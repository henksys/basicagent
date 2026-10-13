// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// Terminal output.
//
// Two modes:
//   human  streaming text on stdout, tool activity and notices on stderr
//          (so `basicagent "..." > answer.txt` keeps stdout clean)
//   json   every event as one JSON object per line on stdout, suitable for
//          scripts; human errors still go to stderr
//
// Colors are used only when stderr is a TTY and NO_COLOR is not set.

import { previewJSON } from './util.mjs';

export function createUI({ json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
  const useColor = Boolean(stderr.isTTY) && !process.env.NO_COLOR;
  const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

  return {
    json,

    // Machine readable event (JSON mode only).
    event(event) {
      if (json) stdout.write(JSON.stringify(event) + '\n');
    },

    // Human notices (stderr so stdout stays the answer).
    banner(text) {
      if (!json) stderr.write(text + '\n');
    },
    info(text) {
      if (!json) stderr.write(text + '\n');
    },
    warn(text) {
      stderr.write((json ? '' : paint(33, 'warning: ')) + text + '\n');
    },
    error(text) {
      stderr.write((json ? '' : paint(31, 'error: ')) + text + '\n');
    },

    // Streamed assistant text (stdout).
    delta(text) {
      if (!json) stdout.write(text);
    },
    turnEnd() {
      if (!json) stdout.write('\n');
    },

    // Tool activity (stderr).
    toolStart(name, args) {
      if (!json) stderr.write(paint(36, `[tool] ${name}`) + ' ' + previewJSON(args) + '\n');
    },
    toolEnd(name, ok, durationMs, result) {
      if (json) return;
      const status = ok ? paint(32, 'ok') : paint(31, 'failed');
      stderr.write(`[tool] ${name} ${status} (${durationMs}ms)\n`);
      if (!ok && result?.error) stderr.write(`       ${String(result.error).split('\n')[0]}\n`);
    }
  };
}
