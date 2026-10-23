// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// The run_command tool: run a local executable with literal arguments.
//
// Design choices, all deliberate:
//   - Disabled by default (tools.shell.enabled = false).
//   - No shell interpretation: `command` is an executable name and `args` is
//     an array of strings. Shell metacharacters like ; | > * have no special
//     meaning, so "rm -rf /" style accidents cannot hide inside a pipeline.
//   - The working directory must itself pass the file-root policy.
//   - Every call needs approval unless the config sets approval: "never".
//   - In read-only mode, only commands matching tools.shell.readOnlyAllowlist
//     run. The allowlist is a guardrail, not a sandbox.
//   - A simple denylist backstop refuses obviously destructive commands. It is
//     an accident brake, not a sandbox.
//   - Hard timeout, kill on timeout or cancellation, output caps.
//
// Warning for users: approving a run_command is full trust. A command can
// write outside the configured file roots. The roots only constrain the
// file tools.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { bounded } from '../util.mjs';
import { checkAccess } from './files.mjs';

// Does `command args` match one of the read-only allowlist entries? Each entry
// is a command plus an optional required argv prefix: "journalctl" matches any
// journalctl call, "systemctl status" requires "status" as the first argument.
export function matchReadOnlyCommand(allowlist, command, args) {
  for (const entry of allowlist) {
    const [allowedCommand, ...prefix] = entry.split(' ');
    if (allowedCommand !== command) continue;
    if (prefix.length > args.length) continue;
    if (prefix.every((value, index) => args[index] === value)) return true;
  }
  return false;
}

export function shellTools({ config, cwd }) {
  const settings = config.tools.shell;
  const readOnlyAllowlist = settings.readOnlyAllowlist ?? [];
  const readOnlyAvailable = Boolean(settings.enabled && readOnlyAllowlist.length > 0);
  const readOnlyNote = !settings.enabled
    ? 'In read-only mode this tool is unavailable because shell access is disabled. '
    : readOnlyAllowlist.length > 0
      ? `In read-only mode only commands matching tools.shell.readOnlyAllowlist are permitted. Allowed: ${readOnlyAllowlist.join(', ')}. `
      : 'In read-only mode this tool is unavailable because tools.shell.readOnlyAllowlist is empty. ';

  return [
    {
      name: 'run_command',
      allowedInReadOnly: readOnlyAvailable,
      description:
        (settings.enabled
          ? 'Run a local executable with literal arguments (no shell). Every call is shown and needs approval. '
          : 'EXECUTABLE DISABLED: the run_command tool is turned off in the config. Tell the user to enable tools.shell.enabled. ') +
        readOnlyNote +
        'Use file tools for file operations. Returns exitCode, stdout and stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Executable name or path, e.g. "git" or "/usr/bin/ls"' },
          args: { type: 'array', items: { type: 'string' }, description: 'Literal argument strings (optional)' },
          cwd: { type: 'string', description: 'Working directory (optional, defaults to the agent working directory)' }
        },
        required: ['command'],
        additionalProperties: false
      },
      run: async ({ command, args = [], cwd: requestedCwd }, ctx) => {
        if (!settings.enabled) {
          throw new Error('The run_command tool is disabled by configuration (tools.shell.enabled). Ask the user to enable it.');
        }
        if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new Error('Invalid command');
        if (!/^[A-Za-z0-9_./+-]+$/.test(command)) throw new Error('Command must be a plain executable name or path (no shell syntax)');
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('args must be an array of strings without NUL bytes');

        const line = [command, ...args].join(' ').replace(/\s+/g, ' ').trim();

        // Read-only mode is an authorization filter in front of approval. An
        // empty allowlist means the tool should not have been offered at all.
        if (ctx?.readOnly) {
          const allowlist = settings.readOnlyAllowlist ?? [];
          if (allowlist.length === 0) {
            throw new Error('The run_command tool is unavailable in read-only mode because tools.shell.readOnlyAllowlist is empty.');
          }
          if (!matchReadOnlyCommand(allowlist, command, args)) {
            throw new Error(`Command "${line}" is not in tools.shell.readOnlyAllowlist; read-only mode refused it`);
          }
        }

        let workdir = cwd;
        if (requestedCwd !== undefined) {
          const check = await checkAccess({ config, cwd, input: requestedCwd });
          const stats = await stat(check.real).catch(() => null);
          if (!stats?.isDirectory()) throw new Error(`Working directory not found: ${check.real}`);
          workdir = check.real;
        }

        // Collapse whitespace so extra spaces cannot slip a denied word past
        // the comparison. Still an accident brake, not a sandbox.
        const lower = line.toLowerCase();
        for (const denied of settings.denylist) {
          if (lower.includes(String(denied).toLowerCase().replace(/\s+/g, ' ').trim())) {
            throw new Error(`Command matches the configured denylist entry "${denied}" and was refused`);
          }
        }

        if (settings.approval === 'always') {
          const approved = await ctx.approve(`Run command: ${line}\n  in ${workdir}`);
          if (!approved) throw new Error('Command denied by user');
        }

        return await runCommand({ command, args, cwd: workdir, timeoutMs: settings.timeoutMs, maxOutputBytes: settings.maxOutputBytes, signal: ctx.signal });
      }
    }
  ];
}

// Spawn one process and collect its output with caps and a timeout.
export function runCommand({ command, args, cwd, timeoutMs, maxOutputBytes, signal }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let child;
    try {
      child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error(`Could not start ${command}: ${error.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    };

    const abort = () => {
      child.kill('SIGKILL');
      finish(new Error('Command interrupted'));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        stdout = bounded(stdout, maxOutputBytes);
        outputTruncated = true;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > maxOutputBytes) {
        stderr = bounded(stderr, maxOutputBytes);
        outputTruncated = true;
      }
    });
    child.on('error', (error) => {
      if (error.code === 'ENOENT') finish(new Error(`Executable not found: ${command}`));
      else finish(new Error(`Could not run ${command}: ${error.message}`));
    });
    child.on('close', (code, closeSignal) => {
      finish(null, {
        command,
        args,
        exitCode: code,
        signal: closeSignal || null,
        timedOut,
        truncated: outputTruncated,
        stdout,
        stderr
      });
    });
  });
}
