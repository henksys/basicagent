// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// File tools with a root-based access policy.
//
// Every path an agent touches passes through checkAccess():
//
//   1. "~" is expanded; relative paths resolve against the working directory.
//   2. The path is resolved with realpath (including the nearest existing
//      parent for files that do not exist yet, and following dangling
//      symlinks manually) so symlinks cannot escape.
//   3. The path must fall inside one of tools.files.roots. The most specific
//      matching root (the longest resolved root path) decides the access
//      level: rw, ro, approval or deny. This keeps a broad root from silently
//      shadowing a narrower restrictive one, regardless of config order.
//   4. Writes additionally require approval when the path is protected:
//      entries in tools.files.protectedPaths, the active basicagent config
//      file itself, or the memory data directory (so the agent can edit its
//      own config, facts and audit log only with consent).
//
// Paths outside every root are refused with an explanatory error.

import { appendFile, lstat, mkdir, readFile, readdir, readlink, realpath, rename, stat, writeFile } from 'node:fs/promises';
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
// A symlink whose target does not exist (dangling) is followed manually:
// realpath reports ENOENT for it, but a write through it would still reach
// the target, which may be outside every root.
export async function softRealpath(path) {
  let current = path;
  const missing = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const link = await lstat(current).then((info) => info.isSymbolicLink(), () => false);
      if (link) {
        const target = await readlink(current);
        const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(current), target);
        const rest = missing.reverse();
        return join(await softRealpath(resolvedTarget), ...rest);
      }
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
  let matchedReal = '';
  for (const root of config.tools.files.roots) {
    const rootReal = await softRealpath(root.path);
    if (isInside(rootReal, real) && (!matched || rootReal.length > matchedReal.length)) {
      matched = root;
      matchedReal = rootReal;
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
    // The memory directory holds facts, sessions and the audit log; the agent
    // must not be able to rewrite its own record without consent.
    if (config.memory?.enabled && config.memory.dir) protectedPaths.add(config.memory.dir);
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
  const stats = await stat(check.real).catch(() => null);
  if (!stats?.isDirectory()) throw new Error(`Not a directory: ${check.real}`);
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
        const stats = await stat(check.real).catch(() => null);
        if (!stats) throw new Error(`File not found: ${check.real}`);
        if (!stats.isFile()) throw new Error(`Not a regular file: ${check.real}`);
        if (stats.size > limits.maxReadBytes && start_line === undefined && end_line === undefined) {
          throw new Error(`File is ${stats.size} bytes (limit ${limits.maxReadBytes}); read it in ranges with start_line/end_line`);
        }
        const content = await readFile(check.real);
        if (content.includes(0)) throw new Error('Binary files are not supported');
        const lines = content.toString('utf8').split('\n');
        const { from, to } = lineRange(lines, start_line, end_line);
        const numbered = lines.slice(from - 1, to).map((line, index) => `${String(from + index).padStart(5)}| ${line}`).join('\n');
        const text = bounded(numbered, limits.maxReadBytes);
        return { path: check.real, totalLines: lines.length, from, to, truncated: text.length < numbered.length, text };
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
        await mkdir(dirname(check.real), { recursive: true });
        await writeFile(check.real, content);
        return { written: true, path: check.real, bytes: Buffer.byteLength(content) };
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
        const content = (await readFile(check.real)).toString('utf8');
        const count = content.split(old_string).length - 1;
        if (count === 0) throw new Error('old_string was not found in the file; read it again and copy the exact text');
        if (count > 1 && !replace_all) throw new Error(`old_string matches ${count} times; add more context or set replace_all: true`);
        const updated = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
        if (Buffer.byteLength(updated) > limits.maxWriteBytes) throw new Error(`Content exceeds the ${limits.maxWriteBytes} byte write limit`);
        await writeFile(check.real, updated);
        return { edited: true, path: check.real, replacements: replace_all ? count : 1 };
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
        const stats = await stat(check.real).catch(() => null);
        if (!stats?.isFile()) throw new Error(`File not found: ${check.real}. append_file does not create files.`);
        await guardWrite(ctx, check);
        await appendFile(check.real, text);
        return { appended: true, path: check.real, bytes: Buffer.byteLength(text) };
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
        const entries = await readdir(check.real, { withFileTypes: true });
        const names = entries
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort((a, b) => a.localeCompare(b));
        return {
          path: check.real,
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
        const stats = await stat(source.real).catch(() => null);
        if (!stats?.isFile()) throw new Error(`Source file not found: ${source.real}`);
        const destination = await checkAccess({ config, cwd, input: to, write: true });
        if (await stat(destination.real).catch(() => null)) throw new Error(`Destination already exists: ${destination.real}`);
        await guardWrite(ctx, source);
        await guardWrite(ctx, destination);
        await rename(source.real, destination.real);
        return { renamed: true, from: source.real, to: destination.real };
      }
    }
  ];
}
