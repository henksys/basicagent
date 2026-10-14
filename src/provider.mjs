// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// Provider client for any OpenAI-compatible /v1/chat/completions endpoint.
//
// Tested against Ollama (local and cloud), llama.cpp server, DeepSeek and
// OpenAI. The client streams responses and rebuilds tool calls from the
// streamed deltas, tolerating the small differences between servers:
//
//   - missing or repeated tool call ids
//   - tool arguments delivered as an object instead of a JSON string
//   - names split across several deltas
//   - no trailing newline after the final SSE event
//
// `tool_choice` is omitted by default because Ollama does not support it.

import { bounded } from './util.mjs';

export class ProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class Provider {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config.provider;
    this.fetch = fetchImpl;
  }

  get model() {
    return this.config.model;
  }

  set model(value) {
    this.config.model = value;
  }

  // One chat completion round. Returns:
  //   { content, toolCalls, finishReason, usage }
  // `toolCalls` is an array of { id, type: "function", function: { name, arguments } }.
  // `onDelta` receives streamed text chunks as they arrive.
  async chat({ messages, tools, signal, onDelta = () => {} }) {
    const body = {
      model: this.config.model,
      messages,
      stream: true,
      temperature: this.config.temperature
    };
    if (this.config.maxTokens != null) body.max_tokens = this.config.maxTokens;
    if (tools?.length) {
      body.tools = tools;
      if (this.config.toolChoice) body.tool_choice = this.config.toolChoice;
    }
    if (this.config.includeUsage) body.stream_options = { include_usage: true };

    const url = `${this.config.baseUrl}/chat/completions`;
    const headers = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;

    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response;
    try {
      response = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: combined });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted || error?.name === 'TimeoutError') throw new ProviderError(`Provider request timed out after ${this.config.timeoutMs} ms`);
      throw new ProviderError(`Could not reach provider at ${url}: ${error.message}`);
    }
    if (!response.ok) {
      const text = bounded(await response.text().catch(() => ''), 2000);
      throw new ProviderError(`Provider HTTP ${response.status}: ${text}`);
    }
    return this.#readStream(response, { onDelta, signal });
  }

  // Parse the SSE stream. Events are `data: {json}` lines; "[DONE]" ends it.
  async #readStream(response, { onDelta, signal }) {
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason = null;
    let usage = null;
    let sawEvent = false;
    const calls = new Map();

    const handleEvent = (data) => {
      if (data === '[DONE]') return;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new ProviderError(`Malformed stream chunk from provider: ${bounded(data, 200)}`);
      }
      sawEvent = true;
      if (parsed.usage) usage = parsed.usage;
      const choice = parsed.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || choice.message || {};

      let text = delta.content;
      if (Array.isArray(text)) {
        text = text.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
      }
      if (typeof text === 'string' && text) {
        content += text;
        onDelta(text);
      }

      for (const call of delta.tool_calls || []) {
        const index = call.index ?? calls.size;
        const acc = calls.get(index) || { id: '', name: '', arguments: '' };
        if (call.id) acc.id = call.id;
        const name = call.function?.name;
        if (name && !acc.name.endsWith(name)) acc.name += name;
        let args = call.function?.arguments;
        if (args && typeof args === 'object') args = JSON.stringify(args);
        if (typeof args === 'string') acc.arguments += args;
        calls.set(index, acc);
      }
    };

    const processLine = (line) => {
      const trimmed = line.replace(/\r$/, '');
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return;
      handleEvent(trimmed.slice(5).trim());
    };

    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          processLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      // Some servers end the stream without a trailing newline.
      if (buffer.trim()) processLine(buffer);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ProviderError(`Provider stream interrupted: ${error.message}`);
    }

    if (!sawEvent) throw new ProviderError('Provider returned an empty stream');

    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        id: call.id || `call_${index}_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name: call.name, arguments: call.arguments }
      }));

    if (finishReason === null && !content && toolCalls.length === 0) {
      throw new ProviderError('Provider stream ended without a finish reason or content');
    }
    return { content, toolCalls, finishReason, usage };
  }
}
