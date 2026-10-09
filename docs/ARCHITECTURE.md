# basicagent architecture

This document explains what every file does, how a conversation turn flows
through the system, and how to extend it. It is written to be useful both to a
developer and to an AI agent that is asked to modify this project.

## Big picture

```
                 +------------------+
   prompt  --->  |  bin/basicagent  |  REPL / one-shot / --json
                 +---------+--------+
                           |
                           v
                 +------------------+     +------------------+
                 |    src/agent     |---->|   src/provider    |---> OpenAI-compatible
                 |   (the loop)     |<----| (chat completions)|     /v1/chat/completions
                 +---------+--------+     +------------------+
                           |
              tool calls   v
                 +------------------+     +------------------+
                 | src/tools/index  |---->| files / shell /  |
                 | registry+audit   |     | memory / skills  |
                 +---------+--------+     +------------------+
                           |
                           v
                 +------------------+
                 |   src/skills     |  SKILL.md discovery + load_skill
                 |   src/memory     |  JSONL facts + sessions
                 |   src/prompt     |  system prompt assembly
                 +------------------+
```

There is no framework and no dependency: Node's built-in `fetch`, `readline`,
`spawn`, `AbortSignal` and `node:test` do all the work. `package.json` has no
`dependencies`.

## Module map

| File | Responsibility |
| --- | --- |
| `bin/basicagent.mjs` | CLI entry point. Argument parsing, config loading, REPL, one-shot and `--json` modes, slash commands, Ctrl+C handling. All user-visible behavior lives here. |
| `src/config.mjs` | Built-in defaults, config file loading and merging (defaults <- file <- env <- flags), validation and path normalization. |
| `src/provider.mjs` | The only place that talks HTTP. One OpenAI-compatible `/v1/chat/completions` call with SSE streaming; rebuilds tool calls from deltas. |
| `src/agent.mjs` | The agent loop: send messages + tool schemas, stream the answer, execute tool calls, feed results back, repeat. Applies iteration limits, the failure circuit breaker and context trimming. Also defines the event stream. |
| `src/tools/index.mjs` | Tool registry: schema validation, dispatch, per-call audit log. |
| `src/tools/files.mjs` | File tools plus the root-based path policy (`checkAccess`, `softRealpath`). |
| `src/tools/shell.mjs` | `run_command` with approval, timeout, denylist and output caps. |
| `src/tools/web.mjs` | `fetch_url`: guarded HTTP fetching, SSRF checks, bounded reads, HTML-to-text extraction. Omitted when `tools.web.enabled` is false. |
| `src/tools/memory-tools.mjs` | `remember`, `search_memory`, `forget`. |
| `src/skills.mjs` | SKILL.md discovery, frontmatter parsing (plain, `>` and `|`), prompt index generation, `load_skill` tool. |
| `src/memory.mjs` | JSONL persistence: `facts.jsonl`, `sessions/<id>.jsonl`, `last-session.txt`, `audit.jsonl`. |
| `src/prompt.mjs` | System prompt assembly from persona + environment + skills + facts + tool guidance + safety rules. |
| `src/approval.mjs` | Approval policy for guarded operations (interactive / deny / `--yes`). |
| `src/ui.mjs` | Terminal rendering for human and JSON modes. |
| `src/util.mjs` | Small helpers: `bounded`, `expandHome`, `resolveUserPath`, `previewJSON`, `mask`. |
| `skills/example/SKILL.md` | Working skill template. |
| `config.example.json` | Reference configuration. |
| `test/` | Offline tests with a fake SSE provider; `test/live/` holds opt-in live tests. |

## One turn, step by step

1. The CLI collects a prompt (argument, stdin pipe, or the REPL line).
2. `buildSystemPrompt` is called fresh each turn, so new facts and skill
   changes are picked up without a restart.
3. `Agent.run` pushes the user message and enters the loop:
   1. `Provider.chat` streams the model answer, emitting `assistant_delta`
      events, and returns `{ content, toolCalls, finishReason }`.
   2. If there are no tool calls, the loop emits `done` and returns.
   3. Otherwise each tool call is parsed, validated and executed through the
      registry; each result is appended as a `role: "tool"` message.
   4. The loop repeats (up to `agent.maxIterations`).
4. The CLI streams text to stdout, tool activity to stderr, appends the turn
   to the memory session, and reprompts.

### Hard limits inside the loop

- **maxIterations** (`agent.maxIterations`, default 25) caps one turn.
- **Circuit breaker**: the same tool name + arguments failing three times
  aborts the turn with an `AgentError`.
- **Context trimming** (`agent.contextChars`): old tool results become a
  placeholder first, then whole old exchanges are dropped. Tool messages are
  removed together with the assistant message that requested them so the
  provider never sees an orphaned `tool` message.
- **Abort**: Ctrl+C in the REPL (or SIGINT in one-shot) aborts the current
  `AbortSignal`; the provider stream and any running command are killed.

### Event stream

Every event the agent emits is rendered by `src/ui.mjs`. In `--json` mode it is
also written to stdout as one JSON object per line:

| Event | Fields |
| --- | --- |
| `iteration` | `iteration` |
| `assistant_delta` | `text` |
| `tool_start` | `name`, `args` |
| `tool_end` | `name`, `ok`, `durationMs`, `result` |
| `warning` | `message` |
| `done` | `text` |
| `error` | `message` |
| `approval` | `description`, `approved`, `automatic` |

Scripts should treat `done` as the final assistant answer and `error` as a
failed run (the CLI also exits 1).

## Provider contract

`src/provider.mjs` speaks one dialect well and tolerates the known variations
between servers:

- request: `{ model, messages, stream: true, temperature, max_tokens }` plus
  `tools`/`tool_choice` when tools exist. `tool_choice` is only sent when
  configured, because Ollama rejects it.
- response: SSE `data:` lines, `[DONE]` terminator, `choices[0].delta`.
- tolerated quirks: missing/repeated tool call ids, names split across deltas,
  arguments delivered as objects, missing trailing newline, `content` given as
  an array of parts.

Tested against: Ollama (local and cloud), llama.cpp server, DeepSeek, OpenAI.
For llama.cpp, start the server with `--jinja` so tool calling works.

## Tool contract

A tool is a plain object:

```js
{
  name: 'read_file',
  description: 'Shown to the model; say when to use the tool and what it returns.',
  parameters: { type: 'object', properties: { ... }, required: [...], additionalProperties: false },
  async run(args, ctx) { return { any: 'JSON-serializable result' }; }
}
```

- `ctx.signal` — AbortSignal for the current turn; long operations must honor it.
- `ctx.approve(description)` — asks the user for approval; returns a boolean.

The registry (`src/tools/index.mjs`) validates arguments against `parameters`
before running anything and rejects unknown arguments. Throwing inside `run`
does not crash the turn: the error text is returned to the model as the tool
result so it can correct itself. Three identical failures trip the circuit
breaker.

### Adding a tool

1. Create `src/tools/my-tool.mjs` exporting a factory that returns tool objects.
2. Register it in `createRegistry` in `src/tools/index.mjs`.
3. Add a unit test under `test/`.
4. If the tool can change user data, think about approval and root policy first.

### Built-in tools

| Tool | Notes |
| --- | --- |
| `read_file` | Line-numbered output, 24 KB cap, ranges for large files. |
| `write_file` | Creates parent directories. Use for new files/full rewrites. |
| `edit_file` | Exact fragment replacement; refuses ambiguous matches unless `replace_all`. |
| `append_file` | Only appends; never creates files. |
| `list_dir` | Sorted, capped listing; directories get a trailing `/`. |
| `rename_file` | Refuses existing destinations and cross-filesystem moves. |
| `run_command` | Disabled by default; argv only, no shell; approval + timeout + denylist. |
| `fetch_url` | Enabled by default; http(s) only; SSRF check on the URL and every redirect; domain allow/deny; bounded stream + text caps; no JS/cookies. |
| `remember` / `search_memory` / `forget` | Registered only when memory is enabled. |
| `load_skill` | Registered only when skills are found. |

## File access policy

Every file path is resolved and authorized by `checkAccess` in
`src/tools/files.mjs`:

1. `~` expands; relative paths resolve against the working directory.
2. `softRealpath` resolves the path (or its nearest existing parent) so
   symlinks cannot escape a root.
3. The path must be inside one of `tools.files.roots`; the **first matching
   root** decides the access level:
   `rw` (free), `ro` (read only), `approval` (writes ask), `deny` (refuse).
4. Writes inside `tools.files.protectedPaths` — and always inside the active
   config file — require approval even in an `rw` root.

Paths outside every root are refused with an error the model can read.

**Shell caveat:** approving a `run_command` is full trust; a command can write
anywhere, including outside all roots. The roots constrain only the file tools.
Keep `tools.shell.enabled` false unless you need it.

## Web access policy

`fetch_url` (`src/tools/web.mjs`) is enabled by default and read-only. Every
request — including each redirect hop — passes the same checks:

1. **URL**: `http:`/`https:` only, no embedded credentials; `localhost` names
   refused.
2. **Domains**: `denyDomains` always wins; when `allowDomains` is non-empty it
   becomes an allowlist. Entries match the domain and its subdomains;
   `*.example.com` also matches the apex.
3. **Addresses**: the hostname is resolved with `dns.lookup({all:true})` and
   refused when any result is private or reserved: loopback, RFC 1918, CGNAT,
   link-local (including the `169.254.169.254` cloud metadata address),
   TEST-NETs, multicast, ULA and IPv6 link-local. `tools.web.allowPrivate`
   disables this and is meant only for trusted local testing.
4. **Bounds**: `redirect: 'manual'` with at most `maxRedirects` hops; the body
   is streamed with a `maxRawBytes` cap (the rest is cancelled); the sanitized
   text is capped at `maxBytes` and flagged `truncated`.
5. **Content**: only text/html, xhtml+xml, xml, plain, markdown and JSON are
   accepted. Charset comes from the Content-Type header or a `<meta charset>`
   sniff and is decoded with `TextDecoder`.

HTML is converted to text by an ordered regex pipeline: comments/doctype/CDATA,
then `head|script|style|noscript|template|svg|iframe`, then a `<main>` or
`<article>` region when present, then block structure becomes newlines
(`<li>` becomes `- `, headings become `#`), then tags are stripped and entities
are decoded in a single pass (no double decoding of `&amp;lt;`).

Deliberate limitations: regex handling is best-effort and can leak markup on
pathological HTML; DNS resolution and the actual connection are not pinned, so
a determined DNS-rebinding attack is out of scope (TOCTOU); there is no
JavaScript rendering, no cookie/auth support and no robots.txt handling.
Setting `tools.web.enabled: false` (or `--no-web`) removes the tool from the
schema entirely; `approval: "always"` asks for a y/N before each fetch.

## Skills

A skill is a directory with a `SKILL.md`:

```markdown
---
name: my-skill
description: >
  When the model should use this skill.
---

Instructions for the model, in markdown.
```

- `discoverSkills` scans every path in `skills.paths` for `<name>/SKILL.md`
  (or a direct path to a `SKILL.md`). Missing paths are ignored; broken files
  never prevent startup; earlier paths win on duplicate names.
- `loadConfig` always appends `BUNDLED_SKILLS_DIR` — the project's own
  `skills/` directory, resolved from `src/config.mjs` — after the configured
  paths. This keeps the bundled `basicagent` self-help skill and the `example`
  template available no matter which directory basicagent runs in, including
  when a user config replaces `skills.paths` entirely.
- Symlinked skill directories are followed, which is how many agents
  (including Omarchy's `/usr/share/omarchy/default/agents/skills`) install
  skills.
- Only `name` + `description` go into the system prompt. The full body is
  loaded on demand with `load_skill`, which also returns the skill's `dir` so
  referenced scripts can be read with `read_file`.
- The frontmatter parser supports plain values, folded `>` and literal `|`
  blocks — the same shape used by Claude/Omarchy-style skills.

## Memory format

Under `memory.dir` (default `~/.local/share/basicagent`, mode `0700`):

| File | Content |
| --- | --- |
| `facts.jsonl` | `{"key","value","at"}` per line, rewritten atomically. |
| `sessions/<id>.jsonl` | `{"ts","role","content"}` per user/assistant message. |
| `last-session.txt` | session id used by `--continue`. |
| `audit.jsonl` | every tool call: `{ts, tool, args, ok, error, durationMs}`. |

Resuming replays only user/assistant text; tool traffic is not replayed.
`forget` rewrites facts and session files to remove matching lines.

## CLI modes

- **REPL** (`basicagent`): interactive; commands `/help /new /reload /skills
  /tools /model [name] /config /quit`. Ctrl+C cancels the running turn;
  Ctrl+D exits. `/reload` re-reads the config file, skills, provider and
  prompt while keeping the conversation.
- **One-shot** (`basicagent "..."` or a pipe): runs one turn and exits.
  Answer on stdout, tool trace on stderr, exit code 0/1.
- **JSON** (`--json`): one-shot with one JSON event per line on stdout. This
  is the mode to embed in other programs.

## Configuration reference

See `config.example.json` and the table in `docs/TUTORIAL.md`. Precedence:
defaults, config file, environment, CLI flags.

## Testing

- `npm test` — 45 offline tests: config merging, SSE parsing, the agent loop,
  the path policy, skills, memory-adjacent behavior and the CLI end to end
  against a fake in-process provider.
- `npm run test:live` — opt-in integration test against Ollama Cloud
  (`OLLAMA_API_KEY_CLOUD`, default model `gemma4:31b`). It creates a file with
  `write_file` and reads it back with `read_file`.
