// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.mjs';

function makeMemory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'basicagent-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, memory: new Memory({ dir }) };
}

test('deleteFact removes one exact key only', (t) => {
  const { dir, memory } = makeMemory(t);
  memory.remember('editor', 'nvim');
  memory.remember('editor.theme', 'dark');
  memory.remember('OS', 'Linux');

  assert.equal(memory.deleteFact('editor'), true);
  assert.equal(memory.deleteFact('editor'), false);
  assert.equal(memory.facts.has('editor.theme'), true, 'prefix matches are kept');
  assert.equal(memory.facts.size, 2);

  const lines = readFileSync(join(dir, 'facts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((entry) => entry.key).sort(), ['OS', 'editor.theme']);
});

test('reloadFacts picks up facts written by another instance', (t) => {
  const { dir, memory } = makeMemory(t);
  memory.remember('a', '1');

  const other = new Memory({ dir });
  other.remember('b', '2');
  assert.equal(memory.facts.has('b'), false, 'stale until reload');

  assert.equal(memory.reloadFacts(), 2);
  assert.equal(memory.facts.get('a').value, '1');
  assert.equal(memory.facts.get('b').value, '2');

  writeFileSync(join(dir, 'facts.jsonl'), 'not json\n{"key":"c","value":"3","at":"now"}\n');
  assert.equal(memory.reloadFacts(), 1, 'damaged lines are skipped');
  assert.equal(memory.facts.get('c').value, '3');
});
