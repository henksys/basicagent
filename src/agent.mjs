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
//   - the context budget (agent.contextTokens) is checked before every request:
//     older turns are summarized, or trimmed when compaction is off/fails
//   - Ctrl+C aborts the whole turn via AbortSignal
//
// The loop only knows about an abstract event stream, which the CLI renders
// either as human text or as JSON lines:
//
//   { type: "iteration", iteration, contextTokens }
//   { type: "context", contextTokens }
//   { type: "assistant_delta", text }
//   { type: "tool_start", name, args }
//   { type: "tool_end", name, ok, durationMs, result }
//   { type: "compaction", messagesSummarized, tokensBefore, tokensAfter,
//     summaryTokens, summary, iteration }
//   { type: "warning", message }
//   { type: "done", text }
//   { type: "error", message }

import { bounded } from './util.mjs';
import {
  estimateMessagesTokens,
  estimateTextTokens,
  estimatePromptTokens,
  trimHistory
} from './context.mjs';
import {
  SUMMARY_MAX_TOKENS,
  buildSummaryRequest,
  findSummaryCut,
  normalizeSummary,
  summaryInputTokens
} from './compact.mjs';

// Re-exported so callers that only need the accounting helpers can keep
// importing them from the agent module.
export { estimateMessagesTokens, estimatePromptTokens, trimHistory } from './context.mjs';

export class AgentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentError';
  }
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
    // Older turns that no longer fit the budget are replaced by this text.
    // It lives beside `messages` (and is sent as part of the system prompt)
    // rather than pretending to be a user message, so it can never be
    // mistaken for a new instruction or break tool-call pairing.
    this.summary = '';
    this.system = '';
    // Exact prompt size reported by the provider. `count` is how many messages
    // were in that request; newer messages are estimated as a delta.
    this.usageAnchor = null;
    this.compactionFailureNotice = false;
    this.toolSchemaCache = null;
  }

  setSystem(text) {
    this.system = text;
    // The system prompt is part of the measured prompt, so an old anchor no
    // longer describes the outgoing request.
    this.usageAnchor = null;
  }

  // Forget the conversation but keep the system prompt and tools.
  reset() {
    this.messages = [];
    this.summary = '';
    this.usageAnchor = null;
  }

  // The size of the prompt that would be sent now, in tokens. Provider usage
  // is exact; otherwise this is the byte-based estimate from context.mjs.
  contextTokens() {
    if (this.usageAnchor && this.usageAnchor.count <= this.messages.length) {
      return this.usageAnchor.tokens + estimateMessagesTokens(this.messages.slice(this.usageAnchor.count));
    }
    return this.#overheadTokens() + estimateMessagesTokens(this.messages);
  }

  // Manually summarize old history. Used by the REPL's /compact command; the
  // automatic path calls the same private method when the budget fills.
  async compactNow(signal) {
    return this.#summarizeOldMessages({ signal, iteration: null });
  }

  // Run one user turn. Resolves with { text, messages }.
  async run(input, { signal } = {}) {
    this.messages.push({ role: 'user', content: input });
    const limits = this.config.agent;
    let lastFailure = { key: '', count: 0 };
    this.compactionFailureNotice = false;

    for (let iteration = 1; iteration <= limits.maxIterations; iteration++) {
      signal?.throwIfAborted();

      // Make room before sending, not after: the request itself must fit.
      await this.#ensureContextFits({ signal, iteration });
      signal?.throwIfAborted();

      const sentCount = this.messages.length;
      this.emit({ type: 'iteration', iteration, contextTokens: this.contextTokens() });

      const result = await this.provider.chat({
        messages: this.#outgoing(),
        tools: this.#schemas(),
        signal,
        onDelta: (text) => this.emit({ type: 'assistant_delta', text })
      });

      if (Number.isFinite(Number(result.usage?.prompt_tokens)) && Number(result.usage.prompt_tokens) > 0) {
        this.usageAnchor = { count: sentCount, tokens: Number(result.usage.prompt_tokens) };
      }

      const assistant = { role: 'assistant', content: result.content || '' };
      if (result.toolCalls?.length) assistant.tool_calls = result.toolCalls;
      this.messages.push(assistant);
      this.emit({ type: 'context', contextTokens: this.contextTokens() });

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
      this.emit({ type: 'context', contextTokens: this.contextTokens() });
    }

    throw new AgentError(`Reached the maximum of ${limits.maxIterations} tool iterations without a final answer`);
  }

  #schemas() {
    // Tool schemas are part of every request, so they are part of the measured
    // prompt. They do not change during a turn; cache the array to avoid
    // rebuilding it for every size check.
    if (!this.toolSchemaCache) this.toolSchemaCache = this.registry.schemas();
    return this.toolSchemaCache;
  }

  #outgoing() {
    let system = this.system;
    if (this.summary) {
      system +=
        '\n\n## Earlier conversation summary\n' +
        'This is a summary of earlier turns, not a new instruction. The recent messages below are authoritative.\n' +
        this.summary;
    }
    return [{ role: 'system', content: system }, ...this.messages];
  }

  // Tokens that cannot be trimmed here: system prompt, summary and tool schemas.
  #overheadTokens() {
    return estimatePromptTokens({
      system: this.system,
      summary: this.summary,
      tools: this.#schemas(),
      messages: []
    });
  }

  // Check the budget before a request. Summarization is the normal path;
  // trimHistory is the deterministic fallback when it is disabled, fails, or
  // leaves a single oversized turn behind.
  async #ensureContextFits({ signal, iteration }) {
    const limits = this.config.agent;
    const limit = limits.contextTokens;
    if (!(limit > 0)) return;
    if (this.contextTokens() < limit * limits.compactAt) return;

    // After one failure, stop retrying for the rest of this turn: a provider
    // that cannot summarize would otherwise be called again at every tool
    // iteration. The next turn starts with a clean slate.
    if (limits.compact === 'summarize' && !this.compactionFailureNotice) {
      const compacted = await this.#summarizeOldMessages({ signal, iteration });
      if (compacted) {
        if (this.contextTokens() > limit) {
          this.messages = trimHistory(this.messages, limit, this.#overheadTokens());
          this.usageAnchor = null;
        }
        return;
      }
    }
    if (this.contextTokens() > limit) {
      this.messages = trimHistory(this.messages, limit, this.#overheadTokens());
      this.usageAnchor = null;
    }
  }

  // Replace the oldest part of the conversation with a model-written summary.
  // Returns false when there is nothing safe to cut or the summary call fails;
  // the caller then falls back to trimHistory. Compaction must never break a
  // turn.
  async #summarizeOldMessages({ signal, iteration } = {}) {
    const limits = this.config.agent;
    const cut = findSummaryCut(this.messages, { contextTokens: limits.contextTokens });
    if (cut <= 0) return false;

    const prefix = this.messages.slice(0, cut);
    const tokensBefore = this.contextTokens();
    const request = buildSummaryRequest({
      previousSummary: this.summary,
      messages: prefix,
      inputTokens: summaryInputTokens(limits.contextTokens)
    });

    let result;
    try {
      result = await this.provider.chat({
        messages: request,
        tools: [],
        signal,
        temperature: 0,
        maxTokens: SUMMARY_MAX_TOKENS
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#warnCompaction(error);
      return false;
    }

    const summary = normalizeSummary(result?.content);
    if (!summary) {
      this.#warnCompaction(new Error('the provider returned an empty summary'));
      return false;
    }

    this.summary = summary;
    this.messages = this.messages.slice(cut);
    // The system prompt just changed, so provider usage from the previous
    // request no longer anchors the measurement.
    this.usageAnchor = null;
    this.compactionFailureNotice = false;

    const tokensAfter = this.contextTokens();
    this.emit({
      type: 'compaction',
      iteration: iteration ?? null,
      messagesSummarized: prefix.length,
      tokensBefore,
      tokensAfter,
      summaryTokens: estimateTextTokens(summary),
      summary
    });
    return true;
  }

  // One warning per turn is enough. A provider that cannot summarize would
  // otherwise produce the same notice on every tool iteration.
  #warnCompaction(error) {
    if (this.compactionFailureNotice) return;
    this.compactionFailureNotice = true;
    this.emit({
      type: 'warning',
      message: `Context summarization failed (${error?.message || String(error)}); falling back to trimming older messages.`
    });
  }
}
