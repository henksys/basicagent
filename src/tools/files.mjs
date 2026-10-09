// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// File tools with a root-based access policy.
//
// Every path an agent touches passes through checkAccess():
//
//   1. "~" is expanded; relative paths resolve against the working directory.
//   2. The path is resolved with realpath (including the nearest existing
//      parent for files that do not exist yet) so symlinks cannot escape.
//   3. The path must fall inside one of tools.files.roots. The first matching
//      root decides the access level: rw, ro, approval or deny.
//   4. Writes additionally require approval when the path is protected:
//      entries in tools.files.protectedPaths, or the active basicagent config
//      file itself (so the agent can edit its own config only with consent).
//
// Paths outside every root are refused with an explanatory error.

import { appendFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { bounded, expandHome } from '../util.mjs';

// Is `child` equal to or inside `parent`? Both must be absolute, normalized
// paths (realpath-resolved where possible).
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// realpath that also works for paths that do not exist yet: the nearest
// existing ancestor is resolved and the remaining segments are appended.
export async function softRealpath(path) {
  let current = path;
  const missing = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return normalize(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

// Resolve and authorize one path. Returns:
//   { absolute, real, access, requiresApproval }
// Throws when the path is outside all roots or denied/read-only as requested.
export async function checkAccess({ config, cwd, input, write = false }) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('A non-empty "path" string is required');
  const expanded = expandHome(input.trim());
  const absolute = isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);
  const real = await softRealpath(absolute);

  let matched = null;
  for (const root of config.tools.files.roots) {
    if (isInside(await softRealpath(root.path), real)) {
      matched = root;
      break;
    }
  }
  if (!matched) {
    throw new Error(`Path is outside the configured file roots: ${input}`);
  }
  let access = matched.access;
  if (access === 'deny') throw new Error(`Access to this path is denied by policy: ${input}`);
  if (write && access === 'ro') throw new Error(`This path is read-only by policy: ${input}`);

  let requiresApproval = false;
  if (write && access === 'approval') requiresApproval = true;

  if (write) {
    const protectedPaths = new Set(config.tools.files.protectedPaths);
    if (config.paths?.configPath) protectedPaths.add(config.paths.configPath);
    for (const protectedPath of protectedPaths) {
      const protectedReal = await softRealpath(protectedPath);
      if (isInside(protectedReal, real)) {
        requiresApproval = true;
        break;
      }
    }
  }

  return { absolute, real, access, requiresApproval };
}

// Ask for approval when the policy requires it. `ctx.approve` is provided by
// the CLI: interactive y/N in the REPL, deny-by-default in one-shot mode.
async function guardWrite(ctx, check) {
  if (!check.requiresApproval) return;
  const approved = await ctx.approve(`Write to ${check.absolute} (protected by config)`);
  if (!approved) throw new Error('Write denied by user');
}

async function guardDir(check) {
  const stats = await stat(check.absolute).catch(() => null);
  if (!stats?.isDirectory()) throw new Error(`Not a directory: ${check.absolute}`);
}

function lineRange(lines, startLine, endLine) {
  const from = Number.isInteger(startLine) ? Math.max(1, startLine) : 1;
  const to = Number.isInteger(endLine) ? Math.min(lines.length, endLine) : lines.length;
  return { from, to };
}

export function fileTools({ config, cwd }) {
  const limits = config.tools.files;

  return [
    {
      name: 'read_file',
      description:
        'Read a UTF-8 text file. Output is line numbered ("   12| text"). ' +
        `Files larger than ${limits.maxReadBytes} bytes need start_line/end_line. ` +
        'When quoting text for edit_file, do NOT include the line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'number', description: 'First line to read (1-based, optional)' },
          end_line: { type: 'number', description: 'Last line to read (inclusive, optional)' }
        },
        required: ['path'],
        additionalProperties: false
      },
      run: async ({ path, start_line, end_line }, ctx) => {
        const check = await checkAccess({ config, cwd, input: path });
        const stats = await stat(check.absolute).catch(() => null);
        if (!stats) throw new Error(`File not found: ${check.absolute}`);
        if (!stats.isFile()) throw new Error(`Not a regular file: ${check.absolute}`);
        if (stats.size > limits.maxReadBytes && start_line === undefined && end_line === undefined) {
          throw new Error(`File is ${stats.size} bytes (limit ${limits.maxReadBytes}); read it in ranges with start_line/end_line`);
        }
        const content = await readFile(check.absolute);
        if (content.includes(0)) throw new Error('Binary files are not supported');
        const lines = content.toString('utf8').split('\n');
        const { from, to } = lineRange(lines, start_line, end_line);
        const numbered = lines.slice(from - 1, to).map((line, index) => `${String(from + index).padStart(5)}| ${line}`).join('\n');
        const text = bounded(numbered, limits.maxReadBytes);
        return { path: check.absolute, totalLines: lines.length, from, to, truncated: text.length < numbered.length, text };
      }
    },

    {
      name: 'write_file',
      description:
        'Write a complete UTF-8 file, creating parent directories as needed. ' +
        'Use for new files or explicitly requested full rewrites; for small changes prefer edit_file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false
      },
      run: async ({ path, content }, ctx) => {
        if (typeof content !== 'string') throw new Error('"content" must be a string');
        if (Buffer.byteLength(content) > limits.maxWriteBytes) throw new Error(`Content exceeds the ${limits.maxWriteBytes} byte write limit`);
        const check = await checkAccess({ config, cwd, input: path, write: true });
        await guardWrite(ctx, check);
        await mkdir(dirname(check.absolute), { recursive: true });
        await writeFile(check.absolute, content);
        return { written: true, path: check.absolute, bytes: Buffer.byteLength(content) };
      }
    },

    {
      name: 'edit_file',
      description:
        'Replace an exact text fragment in an existing file, preserving every other byte. ' +
        'old_string must match exactly (including whitespace and newlines). ' +
        'If old_string appears more than once, provide more surrounding context or set replace_all.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
        },
        required: ['path', 'old_string', 'new_string'],
        additionalProperties: false
      },
      run: async ({ path, old_string, new_string, replace_all = false }, ctx) => {
        if (!old_string) throw new Error('old_string must not be empty; use write_file for new files');
        if (old_string === new_string) throw new Error('old_string and new_string are identical');
        const check = await checkAccess({ config, cwd, input: path, write: true });
        await guardWrite(ctx, check);
        const content = (await readFile(check.absolute)).toString('utf8');
        const count = content.split(old_string).length - 1;
        if (count === 0) throw new Error('old_string was not found in the file; read it again and copy the exact text');
        if (count > 1 && !replace_all) throw new Error(`old_string matches ${count} times; add more context or set replace_all: true`);
        const updated = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
        await writeFile(check.absolute, updated);
        return { edited: true, path: check.absolute, replacements: replace_all ? count : 1 };
      }
    },

    {
      name: 'append_file',
      description:
        'Append text to the end of an EXISTING file without changing existing bytes. ' +
        'No newline is added automatically; include one in text when needed.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, text: { type: 'string' } },
        required: ['path', 'text'],
        additionalProperties: false
      },
      run: async ({ path, text }, ctx) => {
        if (typeof text !== 'string') throw new Error('"text" must be a string');
        const check = await checkAccess({ config, cwd, input: path, write: true });
        const stats = await stat(check.absolute).catch(() => null);
        if (!stats?.isFile()) throw new Error(`File not found: ${check.absolute}. append_file does not create files.`);
        await guardWrite(ctx, check);
        await appendFile(check.absolute, text);
        return { appended: true, path: check.absolute, bytes: Buffer.byteLength(text) };
      }
    },

    {
      name: 'list_dir',
      description: `List the entries of a directory (directories get a trailing "/"), newest first is not guaranteed. Limited to ${limits.maxListEntries} entries.`,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory (default ".")' } },
        required: [],
        additionalProperties: false
      },
      run: async ({ path = '.' }, ctx) => {        const check = await checkAccess({ config, cwd, input: path });
        await guardDir(check);
        const entries = await readdir(check.absolute, { withFileTypes: true });
        const names = entries
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort((a, b) => a.localeCompare(b));
        return {
          path: check.absolute,
          count: names.length,
          truncated: names.length > limits.maxListEntries,
          entries: names.slice(0, limits.maxListEntries)
        };
      }
    },

    {
      name: 'rename_file',
      description: 'Rename or move a file within the allowed roots. Refuses to overwrite an existing destination or move between filesystems.',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
        additionalProperties: false
      },
      run: async ({ from, to }, ctx) => {
        const source = await checkAccess({ config, cwd, input: from, write: true });
        const stats = await stat(source.absolute).catch(() => null);
        if (!stats?.isFile()) throw new Error(`Source file not found: ${source.absolute}`);
        const destination = await checkAccess({ config, cwd, input: to, write: true });
        if (await stat(destination.absolute).catch(() => null)) throw new Error(`Destination already exists: ${destination.absolute}`);
        await guardWrite(ctx, source);
        await guardWrite(ctx, destination);
        await rename(source.absolute, destination.absolute);
        return { renamed: true, from: source.absolute, to: destination.absolute };
      }
    }
  ];
}
