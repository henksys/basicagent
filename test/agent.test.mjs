// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, AgentError, parseToolArguments, trimHistory } from '../src/agent.mjs';

// A scripted stand-in for src/provider.mjs.
class FakeProvider {
  constructor(replies) {
    this.replies = [...replies];
    this.calls = [];
    this.model = 'fake';
  }

  async chat({ messages, onDelta }) {
    this.calls.push(structuredClone(messages));
    const reply = this.replies.shift() ?? { content: '(no more replies)', toolCalls: [], finishReason: 'stop' };
    if (reply.content) onDelta(reply.content);
    return reply;
  }
}

const toolCall = (name, args, id = 'call_1') => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
});

function makeConfig(overrides = {}) {
  return {
    agent: { maxIterations: 25, contextChars: 100000, maxResultChars: 24000 },
    ...overrides
  };
}

function makeRegistry(execute) {
  const calls = [];
  return {
    calls,
    schemas: () => [{ type: 'function', function: { name: 'fake_tool', description: '', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
    names: () => ['fake_tool'],
    execute: async (name, args, ctx) => {
      calls.push({ name, args, hasApprove: typeof ctx.approve === 'function' });
      return execute ? execute(name, args, ctx) : { ok: true };
    }
  };
}

test('runs a tool call and returns the final answer', async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [toolCall('fake_tool', { x: 1 })], finishReason: 'tool_calls' },
    { content: 'All done.', toolCalls: [], finishReason: 'stop' }
  ]);
  const registry = makeRegistry();
  const events = [];
  const agent = new Agent({ provider, registry, config: makeConfig(), emit: (event) => events.push(event), approve: async () => true });
  agent.setSystem('system prompt');

  const result = await agent.run('do the thing');

  assert.equal(result.text, 'All done.');
  assert.equal(registry.calls.length, 1);
  assert.deepEqual(registry.calls[0].args, { x: 1 });
  // The second provider call must contain the tool result.
  const secondCall = provider.calls[1];
  const toolMessage = secondCall.find((message) => message.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_1');
  assert.equal(JSON.parse(toolMessage.content).ok, true);
  assert.ok(events.some((event) => event.type === 'tool_end' && event.ok === true));
  assert.ok(events.some((event) => event.type === 'done' && event.text === 'All done.'));
});

test('tool errors are returned to the model, not thrown', async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [toolCall('fake_tool', {})], finishReason: 'tool_calls' },
    { content: 'Recovered.', toolCalls: [], finishReason: 'stop' }
  ]);
  const registry = makeRegistry(() => {
    throw new Error('boom');
  });
  const agent = new Agent({ provider, registry, config: makeConfig() });
  agent.setSystem('system');

  const result = await agent.run('go');
  assert.equal(result.text, 'Recovered.');
  const toolMessage = provider.calls[1].find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /boom/);
});

test('malformed tool arguments produce an error result instead of crashing', async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [{ id: 'c', type: 'function', function: { name: 'fake_tool', arguments: 'not-json{' } }], finishReason: 'tool_calls' },
    { content: 'Fixed.', toolCalls: [], finishReason: 'stop' }
  ]);
  const registry = makeRegistry();
  const agent = new Agent({ provider, registry, config: makeConfig() });
  agent.setSystem('system');
  const result = await agent.run('go');
  assert.equal(result.text, 'Fixed.');
  assert.equal(registry.calls.length, 0);
  const toolMessage = provider.calls[1].find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /not valid JSON/);
});

test('the same failing call three times trips the circuit breaker', async () => {
  const provider = new FakeProvider(Array.from({ length: 10 }, () => ({
    content: '',
    toolCalls: [toolCall('fake_tool', { same: true })],
    finishReason: 'tool_calls'
  })));
  const registry = makeRegistry(() => {
    throw new Error('always fails');
  });
  const agent = new Agent({ provider, registry, config: makeConfig() });
  agent.setSystem('system');

  await assert.rejects(() => agent.run('go'), (error) => error instanceof AgentError && /3 times/.test(error.message));
  assert.equal(registry.calls.length, 3);
});

test('maxIterations stops a runaway loop', async () => {
  const provider = new FakeProvider(Array.from({ length: 10 }, (_, index) => ({
    content: '',
    toolCalls: [toolCall('fake_tool', { n: index })],
    finishReason: 'tool_calls'
  })));
  const registry = makeRegistry();
  const agent = new Agent({ provider, registry, config: makeConfig({ agent: { maxIterations: 2, contextChars: 100000, maxResultChars: 24000 } }) });
  agent.setSystem('system');
  await assert.rejects(() => agent.run('go'), /maximum of 2/);
});

test('parseToolArguments accepts objects, empty input and rejects garbage', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments(null), {});
  assert.deepEqual(parseToolArguments({ a: 1 }), { a: 1 });
  assert.throws(() => parseToolArguments('['), /not valid JSON/);
  assert.throws(() => parseToolArguments('[1]'), /JSON object/);
});

test('trimHistory drops old tool results before old messages', () => {
  const messages = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: '', tool_calls: [toolCall('fake_tool', {})] },
    { role: 'tool', tool_call_id: 'call_1', content: 'x'.repeat(2000) },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second question' }
  ];
  const trimmed = trimHistory(messages, 500);
  const toolMessage = trimmed.find((message) => message.role === 'tool');
  assert.equal(toolMessage.content, '[tool result trimmed to save context]');
  assert.equal(trimmed.length, messages.length, 'structure is preserved while trimming');
  assert.equal(trimmed.at(-1).content, 'second question');
});
