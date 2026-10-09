// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// Small shared helpers used across the project. No dependencies.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// Trim a string so it never exceeds `bytes` UTF-8 bytes. Characters are never
// split in half, so the result is always valid UTF-8 text.
export function bounded(text, bytes) {
  let out = '';
  let used = 0;
  for (const ch of String(text)) {
    const size = Buffer.byteLength(ch);
    if (used + size > bytes) break;
    out += ch;
    used += size;
  }
  return out;
}

// Collapse all whitespace runs (including newlines) into single spaces.
export function collapseWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

// Expand a leading "~" to the current user's home directory.
export function expandHome(input) {
  if (typeof input !== 'string') return input;
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

// Resolve a user supplied path: expand "~" and make it absolute relative to
// `base` (default: the process working directory).
export function resolveUserPath(input, base = process.cwd()) {
  const expanded = expandHome(String(input));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

// Compact one-line JSON for log lines and terminal previews.
export function previewJSON(value, maxBytes = 160) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = '';
  return bounded(text, maxBytes);
}

// Mask a secret for display. Never prints the full value.
export function mask(secret) {
  const value = String(secret ?? '');
  if (!value) return '(none)';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}...${value.slice(-2)} (${value.length} chars)`;
}
