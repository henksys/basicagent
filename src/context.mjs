// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// Context accounting and the hard trimming fallback.
//
// The agent budgets the *whole* prompt, not just the stored messages:
//
//   system prompt + skills + saved facts + tool schemas + summary + messages
//
// That is what the provider receives (and what usage.prompt_tokens reports),
// so it is the only number that maps to a model's context window. The system
// prompt, skills and facts are assembled per turn, while tool schemas are
// sent with every request, so both have to be counted here rather than being
// silently added on top.
//
// Exact numbers come from the provider when `provider.includeUsage` is on.
// Otherwise tokens are estimated from UTF-8 bytes. English text is roughly
// four bytes per token; using bytes rather than JavaScript's UTF-16
// `.length` keeps the estimate sensible for emoji, CJK and other scripts.
//
// Image content parts are the exception: providers run a vision encoder over
// the decoded pixels, so a base64 data URL would massively overcount. Each
// image part is charged `images.tokensPerImage` (default 1200) instead.
//
// `trimHistory` is the deterministic last resort. Normal operation lets the
// summarizer in compact.mjs shrink old turns first; trimming only runs when
// summarization is disabled, fails, or there is nothing summarizable left.

export const BYTES_PER_TOKEN = 4;

// Chat protocols add a few tokens of framing around each message. The exact
// count differs per provider; four is a deliberately conservative estimate
// and only affects the fallback, not usage reported by the provider.
const MESSAGE_OVERHEAD_TOKENS = 4;

// Images do not become base64 tokens: providers run a vision encoder over the
// decoded pixels. Counting the data URL as text would report hundreds of
// thousands of tokens for a single photo, so one image is charged a fixed,
// deliberately conservative amount. The agent can override this with
// images.tokensPerImage when the model's vision encoder is known to be more
// expensive (for example a dynamic-resolution model).
export const IMAGE_TOKEN_ESTIMATE = 1200;

export const TRIMMED_TOOL_RESULT = '[tool result trimmed to save context]';

// Rough token estimate for one piece of text. This is intentionally cheap:
// it runs on every iteration and must not need a tokenizer dependency.
export function estimateTextTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / BYTES_PER_TOKEN);
}

// Token estimate for a message's `content`, which may be a string or an array
// of OpenAI content parts. Only text parts are measured by size; each image
// part is charged a fixed amount instead of its base64 payload.
export function estimateContentTokens(content, { imageTokens = IMAGE_TOKEN_ESTIMATE } = {}) {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return estimateTextTokens(content == null ? '' : JSON.stringify(content));
  let total = 0;
  for (const part of content) {
    if (typeof part === 'string') {
      total += estimateTextTokens(part);
    } else if (part?.type === 'image_url') {
      total += imageTokens;
    } else if (part?.type === 'text') {
      total += estimateTextTokens(part.text ?? '');
    } else {
      total += estimateTextTokens(JSON.stringify(part ?? ''));
    }
  }
  return total;
}

export function estimateMessageTokens(message, options = {}) {
  // Preserve the original byte-based result exactly for text-only messages.
  // This keeps the context gauge and compaction thresholds unchanged for
  // conversations that never use images.
  if (typeof message?.content === 'string') {
    return estimateTextTokens(JSON.stringify(message)) + MESSAGE_OVERHEAD_TOKENS;
  }
  const { content, ...rest } = message ?? {};
  return estimateContentTokens(content, options) + estimateTextTokens(JSON.stringify(rest)) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateMessagesTokens(messages, options = {}) {
  return (messages ?? []).reduce((total, message) => total + estimateMessageTokens(message, options), 0);
}

// Estimate the full prompt: system text, an optional summary (which is sent
// as part of the system prompt), the tool schemas and the messages.
export function estimatePromptTokens({ system = '', summary = '', tools = [], messages = [], imageTokens } = {}) {
  return (
    estimateTextTokens(system) +
    estimateTextTokens(summary) +
    estimateTextTokens(JSON.stringify(tools ?? [])) +
    estimateMessagesTokens(messages, { imageTokens })
  );
}

// Drop old context when even summarization cannot make it fit.
//
// Old tool results are replaced by a placeholder first, because they are the
// biggest and least useful part of an old turn. After that the oldest
// exchanges are removed. Tool messages always go together with the assistant
// message that requested them, so the provider never sees an orphaned tool
// result. `overheadTokens` is the part of the prompt that cannot be trimmed
// here (system prompt, tools, summary).
export function trimHistory(messages, maxTokens, overheadTokens = 0, options = {}) {
  if (!(maxTokens > 0)) return messages;
  const out = [...messages];
  while (out.length > 2 && estimateMessagesTokens(out, options) + overheadTokens > maxTokens) {
    const toolIndex = out.findIndex(
      (message) => message.role === 'tool' && message.content !== TRIMMED_TOOL_RESULT
    );
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
