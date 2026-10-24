// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Provider, ProviderError } from '../src/provider.mjs';
import { startFakeProvider, textChunk, toolChunk, finishChunk } from './fixtures/fake-server.mjs';

function providerFor(server, overrides = {}) {
  return new Provider({
    provider: {
      baseUrl: server.baseUrl,
      apiKey: 'test-key',
      model: 'fake-model',
      temperature: 0.2,
      maxTokens: 100,
      timeoutMs: 5000,
      toolChoice: null,
      includeUsage: false,
      ...overrides
    }
  });
}

test('streams text and rebuilds a tool call split across chunks', async (t) => {
  const server = await startFakeProvider([
    [
      textChunk('Hello '),
      textChunk('world'),
      toolChunk({ index: 0, id: 'call_1', name: 'read' }),
      toolChunk({ index: 0, name: '_file' }), // name split across deltas
      toolChunk({ index: 0, name: '_file' }), // duplicate name is ignored
      toolChunk({ index: 0, args: '{"path":' }),
      toolChunk({ index: 0, args: '"a.txt"}' }),
      finishChunk('tool_calls')
    ]
  ]);
  t.after(() => server.close());

  const deltas = [];
  const result = await providerFor(server).chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
    onDelta: (text) => deltas.push(text)
  });

  assert.equal(result.content, 'Hello world');
  assert.deepEqual(deltas, ['Hello ', 'world']);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.equal(result.toolCalls[0].function.name, 'read_file');
  assert.equal(result.toolCalls[0].function.arguments, '{"path":"a.txt"}');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(server.requests[0].model, 'fake-model');
  assert.ok(server.requests[0].tools);
});

test('max_tokens is only sent when provider.maxTokens is set', async (t) => {
  const server = await startFakeProvider([
    [textChunk('ok'), finishChunk('stop')],
    [textChunk('ok'), finishChunk('stop')]
  ]);
  t.after(() => server.close());

  await providerFor(server, { maxTokens: 8192 }).chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(server.requests[0].max_tokens, 8192);

  await providerFor(server, { maxTokens: null }).chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.ok(!('max_tokens' in server.requests[1]), 'unset maxTokens omits max_tokens');
});

test('tool arguments arriving as an object are stringified', async (t) => {
  const server = await startFakeProvider([
    [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'list_dir', arguments: { path: '.' } } }] }, finish_reason: null }] },
      finishChunk('tool_calls')
    ]
  ]);
  t.after(() => server.close());
  const result = await providerFor(server).chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(result.toolCalls[0].function.arguments, '{"path":"."}');
});

test('missing tool call id is generated', async (t) => {
  const server = await startFakeProvider([
    [toolChunk({ index: 0, name: 'list_dir', args: '{}' }), finishChunk('tool_calls')]
  ]);
  t.after(() => server.close());
  const result = await providerFor(server).chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.match(result.toolCalls[0].id, /^call_/);
});

test('HTTP errors surface as ProviderError with status', async (t) => {
  const server = await startFakeProvider([{ status: 401, body: { error: { message: 'bad key' } } }]);
  t.after(() => server.close());
  await assert.rejects(
    () => providerFor(server).chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
    (error) => error instanceof ProviderError && /401/.test(error.message) && /bad key/.test(error.message)
  );
});

test('provider errors mention image support when the request contained an image', async (t) => {
  const server = await startFakeProvider([{ status: 400, body: { error: { message: 'invalid message format' } } }]);
  t.after(() => server.close());
  await assert.rejects(
    () => providerFor(server).chat({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
        ]
      }],
      tools: []
    }),
    (error) => error instanceof ProviderError && /may not support image input/.test(error.message)
  );
});

test('connection failures surface as ProviderError', async () => {
  const provider = new Provider({
    provider: { baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'm', temperature: 0, maxTokens: 10, timeoutMs: 1000, toolChoice: null, includeUsage: false }
  });
  await assert.rejects(
    () => provider.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
    (error) => error instanceof ProviderError
  );
});

test('an event without a trailing newline is still parsed', async (t) => {
  const server = await startFakeProvider([
    [`data: ${JSON.stringify(textChunk('tail', 'stop'))}`] // no trailing \n\n at all before [DONE]
  ]);
  t.after(() => server.close());
  const result = await providerFor(server).chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
  assert.equal(result.content, 'tail');
});
