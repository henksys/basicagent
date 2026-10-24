// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('the newest summary is persisted with its kept tail and replayed on resume', (t) => {
  const { dir, memory } = makeMemory(t);
  const id = memory.startSession('20260101000000-aaaa');
  memory.appendEvent('user', 'old question');
  memory.appendEvent('assistant', 'old answer');
  memory.appendEvent('user', 'new question');
  memory.appendSummary({
    summary: 'first summary',
    messagesSummarized: 2,
    tokensBefore: 1000,
    tokensAfter: 100,
    summaryTokens: 20
  }, [{ role: 'user', content: 'new question' }]);
  memory.appendEvent('assistant', 'new answer');
  memory.appendSummary({
    summary: 'newest summary',
    messagesSummarized: 4,
    tokensBefore: 1200,
    tokensAfter: 120,
    summaryTokens: 25
  }, [
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: 'new answer' }
  ]);

  assert.equal(memory.readSummary(id), 'newest summary');
  assert.deepEqual(memory.readSession(id), [
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: 'new answer' }
  ], 'only the tail kept with the newest summary is replayed');

  const resumed = memory.continueSession();
  assert.equal(resumed.id, id);
  assert.equal(resumed.summary, 'newest summary');
  assert.deepEqual(resumed.messages, memory.readSession(id));

  const lines = readFileSync(join(dir, 'sessions', `${id}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const summaries = lines.filter((entry) => entry.kind === 'summary');
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].messagesSummarized, 2);
  assert.deepEqual(summaries[0].recent, [{ role: 'user', content: 'new question' }]);
});

test('summary tails store image placeholders instead of base64', (t) => {
  const { dir, memory } = makeMemory(t);
  const id = memory.startSession('20260101000000-imgg');
  memory.appendSummary({
    summary: 'summary',
    messagesSummarized: 1,
    tokensBefore: 10,
    tokensAfter: 5,
    summaryTokens: 2
  }, [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(1000)}` } }
    ]
  }]);

  const lines = readFileSync(join(dir, 'sessions', `${id}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].recent[0].content, 'what is this?\n[image]');
  assert.ok(!JSON.stringify(lines[0]).includes('base64'));
});

test('pruneAudit removes old dated entries and keeps undated ones', (t) => {
  const { dir, memory } = makeMemory(t);
  const now = new Date('2026-10-24T12:00:00.000Z');
  const missing = memory.pruneAudit({ olderThanWeeks: 4, now });
  assert.equal(missing.removed, 0);
  assert.equal(missing.kept, 0);

  const lines = [
    { ts: '2026-08-01T00:00:00.000Z', tool: 'ancient' },
    { ts: '2026-09-01T00:00:00.000Z', tool: 'old' },
    { ts: '2026-10-20T00:00:00.000Z', tool: 'recent' },
    { tool: 'undated' },
    'not json'
  ];
  writeFileSync(
    join(dir, 'audit.jsonl'),
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'
  );

  const result = memory.pruneAudit({ olderThanWeeks: 4, now });
  assert.equal(result.removed, 2);
  assert.equal(result.kept, 3);
  assert.equal(result.olderThanWeeks, 4);
  assert.equal(result.cutoff, '2026-09-26T12:00:00.000Z');

  const remaining = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(remaining.length, 3);
  assert.match(remaining[0], /recent/);
  assert.match(remaining[1], /undated/);
  assert.equal(remaining[2], 'not json', 'malformed lines are preserved');

  assert.throws(() => memory.pruneAudit({ olderThanWeeks: 0, now }), /1 to 9/);
  assert.throws(() => memory.pruneAudit({ olderThanWeeks: 10, now }), /1 to 9/);
});

test('deleteSession removes the file and keeps the continue pointer valid', (t) => {  const { dir, memory } = makeMemory(t);
  const a = memory.startSession('20260101000000-aaaa');
  const b = memory.startSession('20260102000000-bbbb');
  const c = memory.startSession('20260103000000-cccc');
  memory.appendEvent('user', 'hello from c');
  const pointer = () => readFileSync(join(dir, 'last-session.txt'), 'utf8').trim();

  assert.equal(memory.deleteSession(c), true, 'deletes the newest session');
  assert.ok(!existsSync(join(dir, 'sessions', `${c}.jsonl`)), 'file is gone');
  assert.equal(pointer(), b, 'pointer moves to the next remaining session');

  assert.equal(memory.deleteSession(b), true);
  assert.equal(pointer(), a);

  assert.equal(memory.deleteSession(a), true);
  assert.ok(!existsSync(join(dir, 'last-session.txt')), 'pointer is removed with the last session');

  assert.equal(memory.deleteSession('20260104000000-dddd'), false, 'unknown ids report false');
});
