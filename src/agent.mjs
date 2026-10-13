// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// The agent loop.
//
// One turn works like this:
//
//   1. send the conversation + tool schemas to the provider
//   2. stream the assistant text; if the model asked for tools, run them
//   3. append each tool result as a `role: "tool"` message
//   4. repeat until the model answers without tool calls
//
// Safety rails in the loop itself:
//   - maxIterations caps how many model/tool rounds one turn may use
//   - the same tool + arguments failing three times stops the turn
//   - the context is trimmed when it grows past agent.contextChars
//   - Ctrl+C aborts the whole turn via AbortSignal
//
// The loop only knows about an abstract event stream, which the CLI renders
// either as human text or as JSON lines:
//
//   { type: "iteration", iteration }
//   { type: "assistant_delta", text }
//   { type: "tool_start", name, args }
//   { type: "tool_end", name, ok, durationMs, result }
//   { type: "warning", message }
//   { type: "done", text }
//   { type: "error", message }

import { bounded } from './util.mjs';

export class AgentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentError';
  }
}

const TRIMMED_TOOL_RESULT = '[tool result trimmed to save context]';

// Sum of the serialized message sizes. This is the metric trimHistory uses to
// decide when to drop context, and the one the web interface shows as its
// context gauge, so both always agree.
export function contextSize(messages) {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}

// Drop old context when the message history gets too large. Old tool results
// are replaced by a placeholder first; after that the oldest exchanges are
// removed, and tool messages always go together with their assistant message
// so the provider never sees an orphaned tool result.
export function trimHistory(messages, maxChars) {
  if (maxChars <= 0) return messages;
  const out = [...messages];
  while (out.length > 2 && contextSize(out) > maxChars) {
    const toolIndex = out.findIndex((message) => message.role === 'tool' && message.content !== TRIMMED_TOOL_RESULT);
    if (toolIndex >= 0) {
      out[toolIndex] = { ...out[toolIndex], content: TRIMMED_TOOL_RESULT };
      continue;
    }
    // Remove the oldest exchange (index 1) plus any tool messages directly
    // following it, keeping the final user message and the newest answer.
    let end = 1;
    while (end + 1 < out.length && out[end + 1].role === 'tool') end++;
    out.splice(1, end);
  }
  return out;
}

// Tool arguments normally arrive as a JSON string. Some servers send an
// object; some send nothing for parameterless tools. Anything else is an
// error the model gets to see so it can correct itself.
export function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') throw new Error('Tool arguments must be a JSON object');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Tool arguments are not valid JSON (${error.message}): ${bounded(raw, 200)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be a JSON object');
  return parsed;
}

export class Agent {
  constructor({ provider, registry, config, emit = () => {}, approve = async () => false }) {
    this.provider = provider;
    this.registry = registry;
    this.config = config;
    this.emit = emit;
    this.approve = approve;
    this.messages = [];
    this.system = '';
  }

  setSystem(text) {
    this.system = text;
  }

  // Forget the conversation but keep the system prompt and tools.
  reset() {
    this.messages = [];
  }

  // Run one user turn. Resolves with { text, messages }.
  async run(input, { signal } = {}) {
    this.messages.push({ role: 'user', content: input });
    const limits = this.config.agent;
    let lastFailure = { key: '', count: 0 };

    for (let iteration = 1; iteration <= limits.maxIterations; iteration++) {
      signal?.throwIfAborted();
      this.emit({ type: 'iteration', iteration, contextSize: contextSize(this.messages) });

      const result = await this.provider.chat({
        messages: this.#outgoing(),
        tools: this.registry.schemas(),
        signal,
        onDelta: (text) => this.emit({ type: 'assistant_delta', text })
      });

      const assistant = { role: 'assistant', content: result.content || '' };
      if (result.toolCalls?.length) assistant.tool_calls = result.toolCalls;
      this.messages.push(assistant);

      if (!result.toolCalls?.length) {
        if (result.finishReason === 'length') {
          this.emit({ type: 'warning', message: 'The model reply was truncated by its token limit.' });
        }
        this.emit({ type: 'done', text: result.content || '' });
        return { text: result.content || '', messages: this.messages };
      }

      for (const call of result.toolCalls) {
        signal?.throwIfAborted();
        const name = call.function?.name || '';
        let args = {};
        let failure = null;
        try {
          args = parseToolArguments(call.function?.arguments);
        } catch (error) {
          failure = error;
        }

        this.emit({ type: 'tool_start', name, args });
        const started = Date.now();
        let output;
        if (failure) {
          output = { error: failure.message };
        } else {
          try {
            output = await this.registry.execute(name, args, { signal, approve: this.approve });
          } catch (error) {
            if (signal?.aborted) throw error;
            output = { error: error.message || String(error) };
          }
        }
        const ok = !output || !Object.prototype.hasOwnProperty.call(output, 'error');
        this.emit({ type: 'tool_end', name, ok, durationMs: Date.now() - started, result: output });

        // Circuit breaker: the same failing call three times is a loop.
        const key = `${name}:${JSON.stringify(args)}`;
        if (!ok) {
          lastFailure = key === lastFailure.key ? { key, count: lastFailure.count + 1 } : { key, count: 1 };
          if (lastFailure.count >= 3) {
            throw new AgentError(`Tool "${name}" failed ${lastFailure.count} times with identical arguments; stopping to avoid a loop. Last error: ${output.error}`);
          }
        } else {
          lastFailure = { key: '', count: 0 };
        }

        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: bounded(JSON.stringify(output ?? null), limits.maxResultChars)
        });
      }

      this.messages = trimHistory(this.messages, limits.contextChars);
    }

    throw new AgentError(`Reached the maximum of ${limits.maxIterations} tool iterations without a final answer`);
  }

  #outgoing() {
    return [{ role: 'system', content: this.system }, ...this.messages];
  }
}
