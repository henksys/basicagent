// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSummaryRequest,
  findSummaryCut,
  keepRecentTokens,
  normalizeSummary,
  serializeMessages
} from '../src/compact.mjs';
import { trimHistory, TRIMMED_TOOL_RESULT } from '../src/context.mjs';

test('keepRecentTokens scales with the budget and has a small floor', () => {
  assert.equal(keepRecentTokens(1000), 500);
  assert.equal(keepRecentTokens(4000), 1000);
  assert.equal(keepRecentTokens(24000), 6000);
  assert.equal(keepRecentTokens(100000), 8000);
});

test('findSummaryCut keeps recent turns and lands on a user message', () => {
  const messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'x'.repeat(4000) }, // ~1000 tokens
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'fake_tool', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'result' }
  ];
  const cut = findSummaryCut(messages, { contextTokens: 2000 });
  assert.equal(cut, 2);
  assert.equal(messages[cut].role, 'user', 'the cut never splits a tool call from its result');
});

test('findSummaryCut leaves a conversation that already fits alone', () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'again' }
  ];
  assert.equal(findSummaryCut(messages, { contextTokens: 24000 }), 0);
});

test('findSummaryCut keeps the current turn when it exceeds the allowance', () => {
  const messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'current question' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'fake_tool', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'x'.repeat(4000) }
  ];
  const cut = findSummaryCut(messages, { contextTokens: 1000 });
  assert.equal(cut, 2);
  assert.equal(messages[cut].content, 'current question');
});

test('serializeMessages labels roles and stays bounded', () => {
  const text = serializeMessages([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi', tool_calls: [{ function: { name: 'read_file' } }] },
    { role: 'tool', content: 'file text' }
  ]);
  assert.match(text, /^User: hello/m);
  assert.match(text, /Assistant: hi\n\[called: read_file\]/);
  assert.match(text, /Tool result: file text/);

  const long = serializeMessages([{ role: 'user', content: 'x'.repeat(50000) }], 3000);
  assert.ok(long.length <= 3000, 'the summarizer input is bounded');
  assert.match(long, /^User: x+/);
});

test('serializeMessages replaces image payloads with a placeholder', () => {
  const text = serializeMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(10000)}` } }
      ]
    }
  ]);
  assert.match(text, /^User: What is this\?\n\[image\]/);
  assert.ok(!text.includes('base64'), 'the summarizer never receives image data');
});

test('buildSummaryRequest folds in the previous summary', () => {
  const request = buildSummaryRequest({
    previousSummary: 'older context',
    messages: [{ role: 'user', content: 'hello' }]
  });
  assert.equal(request[0].role, 'system');
  assert.equal(request[1].role, 'user');
  assert.match(request[1].content, /Previous summary:\nolder context/);
  assert.match(request[1].content, /Conversation to compress:/);
});

test('normalizeSummary trims empty output and caps long output', () => {
  assert.equal(normalizeSummary('  hello  '), 'hello');
  assert.equal(normalizeSummary('   '), '');
  assert.ok(normalizeSummary('x'.repeat(20000)).length <= 8000);
});

test('trimHistory counts fixed prompt overhead', () => {
  const messages = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'fake_tool', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'x'.repeat(2000) },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second question' }
  ];
  const trimmed = trimHistory(messages, 650, 500);
  assert.equal(trimmed.length, messages.length, 'the old tool result is replaced first');
  assert.equal(trimmed.find((message) => message.role === 'tool')?.content, TRIMMED_TOOL_RESULT);
  assert.equal(trimmed.at(-1).content, 'second question');

  const tight = trimHistory(messages, 500, 500);
  assert.ok(tight.length < messages.length, 'old exchanges are dropped when even the placeholder does not fit');
  assert.equal(tight.at(-1).content, 'second question');
});
