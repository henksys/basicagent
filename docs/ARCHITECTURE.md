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

   browser  --->  bin/basicagent-web  --->  src/web/server  --->  src/web/api
                  (http server u.i.)        (routing, auth)       (JSON endpoints)
                                                 |
                                                 v
                                          src/web/session         one Agent + Memory
                                          (WebSession manager)    per conversation
```

There is no framework and no dependency: Node's built-in `fetch`, `readline`,
`spawn`, `http`, `AbortSignal` and `node:test` do all the work. `package.json`
has no `dependencies`.

## Module map

| File | Responsibility |
| --- | --- |
| `bin/basicagent.mjs` | CLI entry point. Argument parsing, config loading, REPL, one-shot and `--json` modes, slash commands, Ctrl+C handling. All user-visible behavior lives here. |
| `bin/basicagent-web.mjs` | Web entry point. Flag parsing, token generation, startup banner, browser launch, signal handling. |
| `bin/basicagent-setup.mjs` | Onboarding entry point. Readline questions, provider connection test, writes the config, offers to start the web server. |
| `src/setup.mjs` | Setup logic without I/O: provider presets, base-config loading (existing file or `config.example.json`), answer merging, the provider test, summary lines. |
| `src/web/server.mjs` | HTTP server: static files from `web/`, host/origin checks, bearer-token auth for `/api`, routing to the API. |
| `src/web/api.mjs` | JSON endpoints: status, chat streaming, approvals, sessions, facts, audit, config read/write. |
| `src/web/session.mjs` | `WebSession` (one Agent + Memory + registry per conversation) and `SessionManager`; the approval bridge to the browser; disk helpers for browsing sessions. |
| `src/web/open-browser.mjs` | Launches the token URL in the default browser (`xdg-open`/`open`/`start`); detached, failures are ignored. |
| `web/` | The frontend: hand-written HTML/CSS/JS, no build step. `web/assets/css/tokens.css` and the Marcellus SC font are copied from henksys.com so the UI matches the site's look; sync them when the site changes. |
| `src/config.mjs` | Built-in defaults, config file loading and merging (defaults <- file <- env <- flags), validation and path normalization. |
| `src/config-file.mjs` | Read/validate/write the raw config file; atomic writes, mode 0600. |
| `src/provider.mjs` | The only place that talks HTTP. One OpenAI-compatible `/v1/chat/completions` call with SSE streaming; rebuilds tool calls from deltas. |
| `src/agent.mjs` | The agent loop: send messages + tool schemas, stream the answer, execute tool calls, feed results back, repeat. Applies iteration limits, the failure circuit breaker and the context budget. Also defines the event stream. |
| `src/context.mjs` | Token accounting for the whole prompt (system, tools, summary, messages) and the `trimHistory` fallback. |
| `src/compact.mjs` | Summarization helpers: safe cut points, transcript rendering, the summarizer prompt and summary normalization. |
| `src/tools/index.mjs` | Tool registry: schema validation, dispatch, per-call audit log. |
| `src/tools/files.mjs` | File tools plus the root-based path policy (`checkAccess`, `softRealpath`). |
| `src/tools/shell.mjs` | `run_command` with approval, timeout, denylist and output caps. |
| `src/tools/web.mjs` | `fetch_url`: guarded HTTP fetching, SSRF checks, bounded reads, HTML-to-text extraction. Omitted when `tools.web.enabled` is false. |
| `src/tools/memory-tools.mjs` | `remember`, `search_memory`, `forget`. |
| `src/skills.mjs` | SKILL.md discovery, frontmatter parsing (plain, `>` and `|`), prompt index generation, `load_skill` tool. |
| `src/memory.mjs` | JSONL persistence: `facts.jsonl`, `sessions/<id>.jsonl` (messages plus compaction summaries), `last-session.txt`, `audit.jsonl`. |
| `src/prompt.mjs` | System prompt assembly from persona + environment + skills + facts + tool guidance + safety rules. |
| `src/approval.mjs` | Approval policy for guarded operations (interactive / deny / `--yes`). |
| `src/ui.mjs` | Terminal rendering for human and JSON modes. |
| `src/util.mjs` | Small helpers: `bounded`, `expandHome`, `resolveUserPath`, `previewJSON`, `formatTokens`, `mask`. |
| `skills/example/SKILL.md` | Working skill template. |
| `config.example.json` | Reference configuration. |
| `test/` | Offline tests with a fake SSE provider; `test/live/` holds opt-in live tests. |

## One turn, step by step

1. The CLI collects a prompt (argument, stdin pipe, or the REPL line).
2. `buildSystemPrompt` is called fresh each turn, so new facts and skill
   changes are picked up without a restart.
3. `Agent.run` pushes the user message and enters the loop:
   1. If the prompt is over the compaction threshold, `Agent` summarizes the
      oldest turns first (`src/compact.mjs`) or trims them when compaction is
      off. The model never decides to do this.
   2. `Provider.chat` streams the model answer, emitting `assistant_delta`
      events, and returns `{ content, toolCalls, finishReason, usage }`.
   3. If there are no tool calls, the loop emits `done` and returns.
   4. Otherwise each tool call is parsed, validated and executed through the
      registry; each result is appended as a `role: "tool"` message.
   5. The loop repeats (up to `agent.maxIterations`).
4. The CLI streams text to stdout, tool activity to stderr, appends the turn
   to the memory session, and reprompts.

### Hard limits inside the loop

- **maxIterations** (`agent.maxIterations`, default 25) caps one turn.
- **Circuit breaker**: the same tool name + arguments failing three times
  aborts the turn with an `AgentError`.
- **Context budget** (`agent.contextTokens`, default 24000): counted over the
  whole prompt — system prompt, skills, facts, tool schemas, summary and
  messages — using `provider.usage.prompt_tokens` when available and UTF-8
  byte estimates otherwise. Before every request, `Agent` checks the budget.
  At `agent.compactAt` (default 0.8) it summarizes the oldest turns; the cut
  always lands on a user message so an assistant `tool_calls` message is never
  separated from its `tool` results. Recent turns stay verbatim. If the
  summary fails or compaction is off, `trimHistory` is the fallback: old tool
  results become a placeholder, then whole old exchanges are dropped. The
  summary is replayed on resume. `provider.maxTokens` remains a separate,
  optional per-request output cap. Every iteration reports `contextTokens`;
  the web gauge and the CLI notices use the same number.
- **Abort**: Ctrl+C in the REPL (or SIGINT in one-shot) aborts the current
  `AbortSignal`; the provider stream and any running command are killed.

### Event stream

Every event the agent emits is rendered by `src/ui.mjs`. In `--json` mode it is
also written to stdout as one JSON object per line:

| Event | Fields |
| --- | --- |
| `iteration` | `iteration`, `contextTokens` (whole-prompt estimate) |
| `context` | `contextTokens` (after an assistant or tool message is appended) |
| `assistant_delta` | `text` |
| `tool_start` | `name`, `args` |
| `tool_end` | `name`, `ok`, `durationMs`, `result` |
| `compaction` | `messagesSummarized`, `tokensBefore`, `tokensAfter`, `summaryTokens`, `summary`, `iteration` |
| `warning` | `message` |
| `done` | `text` |
| `error` | `message` |
| `approval` | `description`, `approved`, `automatic` (CLI) |
| `approval` | `id`, `description`, `automatic` (web; answer with `POST /api/approvals/:id`) |
| `approval_result` | `id`, `approved` (web only) |
| `aborted` | (web only; the turn was cancelled) |

Scripts should treat `done` as the final assistant answer and `error` as a
failed run (the CLI also exits 1).

## Web interface

`basicagent-web` serves the UI in `web/` plus a JSON API on loopback
(default `127.0.0.1:8787`) and requires `Authorization: Bearer <token>` on
every `/api` request. Static files are deliberately unauthenticated (no
secrets); the shell can be opened by anything, the API cannot.

Security model — the API can drive an agent with file and shell tools, so it
is treated like local shell access:

- Host header must be the loopback address the server is bound to (blocks
  DNS-rebinding from web pages); cross-origin requests to `/api` are rejected.
- There are no cookies, so there is no CSRF surface; the token travels in the
  URL fragment (never sent to the server) and is kept in `sessionStorage`.
- `--host` with a non-loopback address skips the Host/Origin checks (the
  user's explicit choice) but never the token.
- All model and tool output is rendered with `textContent`, never
  `innerHTML`.

| Endpoint | Notes |
| --- | --- |
| `GET /api/status` | model, cwd, data dir, tools, skills, last session. |
| `POST /api/chat` | one turn; NDJSON stream with the events above. 409 while busy. |
| `POST /api/chat/abort` | cancels the running turn (also on client disconnect). |
| `POST /api/approvals/:id` | answers a paused approval; expired/unknown ids 404. |
| `GET/POST /api/sessions`, `GET /api/sessions/:id` | session list and transcripts from `sessions/*.jsonl`. |
| `DELETE /api/sessions/:id` | removes one stored conversation and its in-memory session; the `--continue` pointer moves to the newest remaining session (409 while a turn runs). |
| `GET/PUT /api/facts`, `DELETE /api/facts/:key` | fact store via `Memory` (exact-key delete). |
| `GET /api/audit` | parsed `audit.jsonl`, newest first, `limit`/`tool`/`ok` filters. |
| `GET/PUT /api/config` | raw file + effective (masked) config; PUT validates, writes atomically and live-reloads every session. |

Sessions are never replayed from tool traffic: a `WebSession` loads only the
persisted user/assistant text, exactly like `--session` in the CLI. Approvals
and the API event objects differ slightly from the CLI (`id` instead of
`approved`), noted in the event table. Facts are shared between sessions
through `facts.jsonl`; each turn calls `Memory.reloadFacts()` so tabs see
other sessions' changes. Concurrent turns in different tabs can still race on
the last write (atomic rename, last writer wins) — acceptable for a
single-user local tool.

## Provider contract

`src/provider.mjs` speaks one dialect well and tolerates the known variations
between servers:

- request: `{ model, messages, stream: true, temperature }` plus `tools` when
  tools exist and `max_tokens` only when `provider.maxTokens` is set (unset =
  the provider's own default output limit). `tool_choice` is only sent when
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
2. `softRealpath` resolves the path (or its nearest existing parent, following
   dangling symlinks explicitly) so symlinks cannot escape a root.
3. The path must be inside one of `tools.files.roots`; the **most specific
   matching root** (the longest resolved root path) decides the access level:
   `rw` (free), `ro` (read only), `approval` (writes ask), `deny` (refuse).
   This keeps a broad root from silently shadowing a narrower restrictive one,
   regardless of config order.
4. Writes inside `tools.files.protectedPaths` — and always inside the active
   config file and the memory data directory (`memory.dir`, which holds facts,
   sessions and `audit.jsonl`) — require approval even in an `rw` root.

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
   TEST-NETs, multicast, ULA, IPv6 link-local, NAT64, 6to4, Teredo and
   IPv4-compatible ranges. Classification uses `net.BlockList`, so expanded
   and mapped IPv6 forms are handled. `tools.web.allowPrivate` disables this
   and is meant only for trusted local testing.
4. **Pinning**: `http`/`https` requests use a custom
   [`lookup`](https://nodejs.org/api/net.html#socketsocketconnect) that returns
   only the addresses validated in step 3, so the connection cannot be pointed
   elsewhere by a second DNS answer (no rebinding TOCTOU).
5. **Bounds**: redirects are followed manually, at most `maxRedirects` hops;
   the body is streamed with a `maxRawBytes` cap (the rest is abandoned); the
   sanitized text is capped at `maxBytes` and flagged `truncated`.
6. **Content**: only text/html, xhtml+xml, xml, plain, markdown and JSON are
   accepted. Charset comes from the Content-Type header or a `<meta charset>`
   sniff and is decoded with `TextDecoder`.

HTML is converted to text by an ordered regex pipeline: comments/doctype/CDATA,
then `head|script|style|noscript|template|svg|iframe`, then a `<main>` or
`<article>` region when present, then block structure becomes newlines
(`<li>` becomes `- `, headings become `#`), then tags are stripped and entities
are decoded in a single pass (no double decoding of `&amp;lt;`).

Deliberate limitations: regex handling is best-effort and can leak markup on
pathological HTML; there is no JavaScript rendering, no cookie/auth support and
no robots.txt handling. Setting `tools.web.enabled: false` (or `--no-web`)
removes the tool from the schema entirely; `approval: "always"` asks for a y/N
before each fetch.

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

Under `memory.dir` (default: `$XDG_DATA_HOME/basicagent`, falling back to
`~/.local/share/basicagent`; settable per agent via the config file,
`BASICAGENT_DATA_DIR` or `--data-dir`; mode `0700`):

| File | Content |
| --- | --- |
| `facts.jsonl` | `{"key","value","at"}` per line, rewritten atomically. |
| `sessions/<id>.jsonl` | `{"ts","role","content"}` per user/assistant message. |
| `last-session.txt` | session id used by `--continue`. |
| `audit.jsonl` | every tool call: `{ts, tool, args, ok, error, durationMs, approvals}`. |

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
defaults, config file, environment (`BASICAGENT_API_KEY`, `BASICAGENT_BASE_URL`,
`BASICAGENT_MODEL`, `BASICAGENT_DATA_DIR`), CLI flags.

## Testing

- `npm test` — 128 offline tests: config merging, SSE parsing, the agent loop,
  the path policy, skills, memory, the web server (auth, streaming, approvals,
  config save) and the CLI end to end against a fake in-process provider.
- `npm run test:live` — opt-in integration test against Ollama Cloud
  (`OLLAMA_API_KEY_CLOUD`, default model `gemma4:31b`). It creates a file with
  `write_file` and reads it back with `read_file`.
