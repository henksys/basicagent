// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// Read/validate/write the raw config file (used by the web settings tab and
// by basicagent-setup).
//
// The config file keeps the user's own JSON (relative paths, "~" and all);
// validation happens on a merged copy (DEFAULTS + file) with the same
// normalizeConfig the CLI uses, so a saved file behaves exactly like one
// written by hand. Writes are atomic (temp file + rename) and mode 0600
// because the file may contain an API key.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULTS, deepMerge, normalizeConfig } from './config.mjs';

// Parse a config file. Returns { raw, found }. A missing file is fine.
export function readConfigFile(path) {
  if (!existsSync(path)) return { raw: {}, found: false };
  const text = readFileSync(path, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Config file ${path} is not valid JSON: ${error.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Config file ${path} must contain a JSON object`);
  }
  return { raw, found: true };
}

// Validate a raw config object by normalizing DEFAULTS + raw. Throws with a
// readable message; returns the normalized (absolutized) config.
export function validateRawConfig(raw, { cwd, configPath }) {
  const merged = deepMerge(structuredClone(DEFAULTS), raw);
  return normalizeConfig(merged, { cwd, configPath, configFound: true });
}

// Atomically write the raw config object as pretty JSON.
export function writeConfigFile(path, raw) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
