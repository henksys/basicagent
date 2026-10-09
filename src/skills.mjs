// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// Skills: reusable instruction documents the model can load on demand.
//
// A skill is a directory containing SKILL.md with YAML-ish frontmatter:
//
//   ---
//   name: my-skill
//   description: >
//     One or two sentences that tell the model WHEN to use this skill.
//   ---
//
//   # Markdown body with the actual instructions
//
// At startup only the name + description of every skill is injected into the
// system prompt (cheap for local models). The model calls `load_skill` to get
// the full body when a skill is relevant. The format is the same one used by
// Claude/agents-style skills, so existing skill directories can be reused.
//
// The frontmatter parser intentionally supports only a small subset of YAML:
//   key: value
//   key: >
//     folded text joined with spaces
//   key: |
//     literal text where newlines are kept

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { bounded, collapseWhitespace } from './util.mjs';

// Parse the leading `--- ... ---` frontmatter block. Returns { meta, body }.
// Files without frontmatter parse as { meta: {}, body: <whole text> }.
export function parseFrontmatter(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: normalized };

  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, '');
  const meta = {};
  const lines = header.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;

    // Block scalars: > (folded) and | (literal), with optional +/-
    if (/^[>|][+-]?$/.test(rawValue)) {
      const folded = rawValue.startsWith('>');
      const collected = [];
      while (i + 1 < lines.length && (lines[i + 1].startsWith('  ') || lines[i + 1].trim() === '')) {
        collected.push(lines[i + 1]);
        i++;
      }
      const indents = collected.filter((entry) => entry.trim()).map((entry) => entry.match(/^ */)[0].length);
      const indent = indents.length ? Math.min(...indents) : 0;
      const stripped = collected.map((entry) => entry.slice(Math.min(indent, entry.length)));
      const joined = stripped.join('\n').trim();
      meta[key] = folded
        ? joined.replace(/\n\s*\n/g, '\u0000').replace(/\n/g, ' ').replace(/\u0000/g, '\n').trim()
        : joined;
      continue;
    }
    meta[key] = rawValue.replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body };
}

// Parse one SKILL.md file into { name, description, body }.
export function parseSkillFile(text, fallbackName = '') {
  const { meta, body } = parseFrontmatter(text);
  const name = collapseWhitespace(meta.name || fallbackName);
  let description = collapseWhitespace(meta.description || '');
  if (!description) {
    // Fall back to the first non-heading, non-empty line of the body.
    description = collapseWhitespace(body.split('\n').find((line) => line.trim() && !line.trim().startsWith('#')) || '');
  }
  return { name, description, body };
}

// Scan each configured path for <dir>/SKILL.md (or a direct SKILL.md path).
// Earlier paths win when two skills share a name.
export function discoverSkills(paths, { maxDescriptionChars = 300 } = {}) {
  const skills = new Map();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    const candidates = [];
    if (stats.isFile() && basename(path) === 'SKILL.md') {
      candidates.push({ file: path, dir: dirname(path) });
    } else if (stats.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const candidateDir = join(path, entry.name);
        // Skills are often symlinked into place (e.g. ~/.agents/skills/omarchy
        // -> /usr/share/omarchy/...), and symlinks are not isDirectory().
        let isDirectory = entry.isDirectory();
        if (!isDirectory && entry.isSymbolicLink()) {
          try {
            isDirectory = statSync(candidateDir).isDirectory();
          } catch {
            isDirectory = false;
          }
        }
        if (!isDirectory) continue;
        const file = join(candidateDir, 'SKILL.md');
        if (existsSync(file)) candidates.push({ file, dir: candidateDir });
      }
    }
    for (const { file, dir } of candidates) {
      try {
        const { name, description, body } = parseSkillFile(readFileSync(file, 'utf8'), basename(dir));
        if (!name || skills.has(name)) continue;
        skills.set(name, { name, description: bounded(description, maxDescriptionChars), body, path: file, dir });
      } catch {
        // A broken skill file must not prevent startup.
      }
    }
  }
  return skills;
}

// The compact index that goes into the system prompt.
export function skillIndexText(skills) {
  return [...skills.values()].map((skill) => `- ${skill.name}: ${skill.description || '(no description)'}`).join('\n');
}

// The load_skill tool definition. Returns the full SKILL.md body on demand.
export function loadSkillTool(skills, { maxResultChars = 24000 } = {}) {
  return {
    name: 'load_skill',
    description:
      'Load the full instructions of a skill listed in the system prompt. ' +
      'Call this before doing work that a skill describes. Returns the skill text and its directory; ' +
      'files and scripts referenced by the skill are usually relative to that directory.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact skill name as listed in the system prompt' } },
      required: ['name'],
      additionalProperties: false
    },
    run: async ({ name }) => {
      const skill = skills.get(name);
      if (!skill) throw new Error(`Unknown skill "${name}". Available: ${[...skills.keys()].join(', ') || '(none)'}`);
      return {
        name: skill.name,
        path: skill.path,
        dir: skill.dir,
        instructions: bounded(skill.body, maxResultChars)
      };
    }
  };
}
