// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, AgentError, parseToolArguments, trimHistory } from '../src/agent.mjs';
import { estimateMessagesTokens, TRIMMED_TOOL_RESULT } from '../src/context.mjs';

// A scripted stand-in for src/provider.mjs.
class FakeProvider {
  constructor(replies) {
    this.replies = [...replies];
    this.calls = [];
    this.model = 'fake';
  }

  async chat({ messages, onDelta = () => {} }) {
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
    agent: {
      maxIterations: 25,
      contextTokens: 24000,
      compact: 'summarize',
      compactAt: 0.8,
      maxResultChars: 24000
    },
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
      calls.push({ name, args, hasApprove: typeof ctx.approve === 'function', readOnly: ctx.readOnly });
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

test('the tool breaker threshold is configurable', async () => {
  const provider = new FakeProvider(Array.from({ length: 10 }, () => ({
    content: '',
    toolCalls: [toolCall('fake_tool', { same: true })],
    finishReason: 'tool_calls'
  })));
  const registry = makeRegistry(() => {
    throw new Error('always fails');
  });
  const agent = new Agent({
    provider,
    registry,
    config: makeConfig({
      agent: {
        maxIterations: 25,
        contextTokens: 24000,
        compact: 'summarize',
        compactAt: 0.8,
        maxResultChars: 24000,
        toolCircuitBreaker: { failureThreshold: 2 }
      }
    })
  });
  agent.setSystem('system');

  await assert.rejects(() => agent.run('go'), (error) => error instanceof AgentError && /2 times/.test(error.message));
  assert.equal(registry.calls.length, 2);
});

test('read-only mode is passed to the registry and clears the usage anchor', async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [toolCall('fake_tool', {})], finishReason: 'tool_calls' },
    { content: 'Done.', toolCalls: [], finishReason: 'stop' }
  ]);
  const registry = makeRegistry();
  const agent = new Agent({ provider, registry, config: makeConfig() });
  agent.setSystem('system');
  agent.usageAnchor = { count: 1, tokens: 99 };
  agent.setReadOnly(true);
  assert.equal(agent.usageAnchor, null, 'switching mode invalidates the old usage anchor');

  await agent.run('go');

  assert.equal(agent.readOnly, true);
  assert.equal(registry.calls[0].readOnly, true);
});

test('maxIterations stops a runaway loop', async () => {
  const provider = new FakeProvider(Array.from({ length: 10 }, (_, index) => ({
    content: '',
    toolCalls: [toolCall('fake_tool', { n: index })],
    finishReason: 'tool_calls'
  })));
  const registry = makeRegistry();
  const agent = new Agent({ provider, registry, config: makeConfig({ agent: { maxIterations: 2, contextTokens: 24000, compact: 'summarize', compactAt: 0.8, maxResultChars: 24000 } }) });
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
  assert.equal(toolMessage.content, TRIMMED_TOOL_RESULT);
  assert.equal(trimmed.length, messages.length, 'structure is preserved while trimming');
  assert.equal(trimmed.at(-1).content, 'second question');
});

test('contextTokens is the trim metric and every iteration reports it', async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [toolCall('fake_tool', { x: 1 })], finishReason: 'tool_calls' },
    { content: 'Done.', toolCalls: [], finishReason: 'stop' }
  ]);
  const registry = makeRegistry();
  const events = [];
  const agent = new Agent({ provider, registry, config: makeConfig(), emit: (event) => events.push(event), approve: async () => true });
  agent.setSystem('system');
  await agent.run('hello');

  const message = { role: 'user', content: 'a' };
  assert.deepEqual(estimateMessagesTokens([message]), estimateMessagesTokens([message]));
  assert.ok(estimateMessagesTokens([message]) > 0);

  const iterations = events.filter((event) => event.type === 'iteration');
  assert.equal(iterations.length, 2);
  assert.ok(Number.isInteger(iterations[0].contextTokens) && iterations[0].contextTokens > 0);
  assert.ok(iterations[1].contextTokens > iterations[0].contextTokens, 'the tool result grows the measured context');
  assert.ok(events.some((event) => event.type === 'context' && event.contextTokens > 0));
});

test('provider usage anchors the context measurement', async () => {
  const provider = new FakeProvider([
    { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1234 } }
  ]);
  const registry = makeRegistry();
  const agent = new Agent({ provider, registry, config: makeConfig(), approve: async () => true });
  agent.setSystem('system');
  await agent.run('hello');
  // The anchor covers the request (user + system + tools); the assistant
  // message appended afterwards is estimated as a delta.
  assert.equal(agent.contextTokens(), 1234 + estimateMessagesTokens([{ role: 'assistant', content: 'ok' }]));
});

test('summarizes old history when the budget fills', async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [toolCall('fake_tool', {})], finishReason: 'tool_calls' },
    { content: 'SUMMARY OF OLD TURNS', toolCalls: [], finishReason: 'stop' },
    { content: 'Done.', toolCalls: [], finishReason: 'stop' }
  ]);
  const registry = makeRegistry(() => ({ ok: true, big: 'x'.repeat(4000) }));
  const events = [];
  const agent = new Agent({
    provider,
    registry,
    config: makeConfig({
      agent: { maxIterations: 25, contextTokens: 1000, compact: 'summarize', compactAt: 0.5, maxResultChars: 24000 }
    }),
    emit: (event) => events.push(event),
    approve: async () => true
  });
  agent.setSystem('system');
  agent.messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' }
  ];

  const result = await agent.run('new question');

  assert.equal(result.text, 'Done.');
  assert.equal(agent.summary, 'SUMMARY OF OLD TURNS');
  assert.ok(!agent.messages.some((message) => message.content === 'old question'), 'old turn was replaced');
  const compaction = events.find((event) => event.type === 'compaction');
  assert.ok(compaction, 'a compaction event was emitted');
  assert.equal(compaction.messagesSummarized, 2);
  assert.ok(compaction.tokensBefore > compaction.tokensAfter);
  assert.match(compaction.summary, /SUMMARY OF OLD TURNS/);
  // The summary is part of the system prompt on the final request.
  const system = provider.calls.at(-1)[0].content;
  assert.match(system, /Earlier conversation summary/);
  assert.match(system, /SUMMARY OF OLD TURNS/);
});

test('compaction can be turned off and falls back to trimming', async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [toolCall('fake_tool', {})], finishReason: 'tool_calls' },
    { content: 'Done.', toolCalls: [], finishReason: 'stop' }
  ]);
  const registry = makeRegistry(() => ({ ok: true, big: 'x'.repeat(8000) }));
  const events = [];
  const agent = new Agent({
    provider,
    registry,
    config: makeConfig({
      agent: { maxIterations: 25, contextTokens: 1000, compact: 'off', compactAt: 0.5, maxResultChars: 24000 }
    }),
    emit: (event) => events.push(event),
    approve: async () => true
  });
  agent.setSystem('system');

  await agent.run('go');

  assert.ok(!events.some((event) => event.type === 'compaction'), 'no summary was attempted');
  assert.equal(agent.messages.find((message) => message.role === 'tool').content, TRIMMED_TOOL_RESULT);
});

test('a failed summary falls back to trimming without breaking the turn', async () => {
  const provider = new FakeProvider([
    { content: '', toolCalls: [toolCall('fake_tool', {})], finishReason: 'tool_calls' },
    { content: '', toolCalls: [], finishReason: 'stop' }, // empty summary
    { content: 'Done.', toolCalls: [], finishReason: 'stop' }
  ]);
  const registry = makeRegistry(() => ({ ok: true, big: 'x'.repeat(8000) }));
  const events = [];
  const agent = new Agent({
    provider,
    registry,
    config: makeConfig({
      agent: { maxIterations: 25, contextTokens: 1000, compact: 'summarize', compactAt: 0.5, maxResultChars: 24000 }
    }),
    emit: (event) => events.push(event),
    approve: async () => true
  });
  agent.setSystem('system');
  agent.messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' }
  ];

  const result = await agent.run('new question');

  assert.equal(result.text, 'Done.');
  assert.equal(agent.summary, '');
  assert.ok(events.some((event) => event.type === 'warning' && /summarization failed/i.test(event.message)));
  assert.equal(agent.messages.find((message) => message.role === 'tool').content, TRIMMED_TOOL_RESULT);
});
