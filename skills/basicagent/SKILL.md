---
name: basicagent
description: >
  basicagent's own identity, configuration and extension guide. Use when the
  user asks how this agent works, where its config or memory lives, how to
  change settings, add tools or skills, or modify its source.
---

# basicagent self-help

You run inside **basicagent**, a small CLI agent that runs an
OpenAI-compatible model in a tool-calling loop. It also ships a local web
interface (`basicagent-web`) for chatting, editing settings and browsing
memory. Node 24+ only, no npm dependencies. Version and repository URL are in
`package.json`; license is GPL-3.0-or-later. "basicagent" is the name of the
*program* (binary, config paths, tools, this skill). The user may give *you* a
different name or persona via `agent.systemPrompt` / `agent.systemPromptFile`
— follow that persona, but keep using the paths and tooling described here.

## Where things live

| Thing | Location |
| --- | --- |
| Config | `~/.config/basicagent/config.json` (or `--config`, `BASICAGENT_CONFIG`) |
| Data | `$XDG_DATA_HOME/basicagent` (or `~/.local/share/basicagent`); set via `memory.dir`, `BASICAGENT_DATA_DIR` or `--data-dir`, mode 0700 |
| Facts | `facts.jsonl` — injected into your system prompt on every run |
| Sessions | `sessions/<id>.jsonl`; `last-session.txt` drives `--continue` |
| Audit | `audit.jsonl` — one line per tool call |
| Source | `bin/basicagent.mjs` (CLI), `bin/basicagent-web.mjs` (web server), `src/` (loop, provider, tools), `src/web/` (server, API, sessions), `web/` (browser UI), `skills/`, `docs/`, `test/` |

Env overrides: `BASICAGENT_API_KEY`, `BASICAGENT_BASE_URL`, `BASICAGENT_MODEL`,
`BASICAGENT_DATA_DIR`.

## Configuration you can change

- `provider`: `baseUrl` (e.g. `https://ollama.com/v1`), `model`, `apiKey` or
  `apiKeyEnv` (name of an environment variable), `temperature`, `maxTokens`
  (optional cap on one reply; unset means the provider's own default is used),
  `timeoutMs`, `toolChoice` (omit it for Ollama).
- `agent`: `maxIterations`, `contextChars` (character budget for the stored
  conversation before old history is trimmed — not the model's context window),
  `maxResultChars`, `systemPrompt` / `systemPromptFile` (use these to
  rename/re-persona yourself; the default persona is in `persona-example.md`).
- `tools.files`: `roots` (`{path, access}` with `rw` / `ro` / `approval` /
  `deny`), `protectedPaths`, size caps.
- `tools.shell`: `enabled` (default false), `approval` (`always` / `never`),
  `timeoutMs`, `maxOutputBytes`, `denylist`.
- `tools.web`: `fetch_url` settings — `enabled` (default true), `approval`
  (`never` / `always`), `timeoutMs`, `maxBytes`, `maxRedirects`,
  `allowPrivate` (default false), `denyDomains`, `allowDomains`, `userAgent`.
- `skills.paths`: directories scanned for `<name>/SKILL.md`.
- `memory`: `enabled`, `dir`.

Precedence: defaults < config file < environment < CLI flags.

## Guardrails (enforced in code, not just by policy)

- File paths must fall inside a configured root; symlink escapes are blocked.
  When roots overlap, the most specific matching root decides the access level.
- Writes inside `protectedPaths` — and always your own config file and the
  memory data directory (`audit.jsonl`, facts, sessions) — require approval
  (when the path is inside an allowed root).
- `run_command` is off by default. When enabled, every call is shown and needs
  approval; approving a command is full trust, because a command can write
  anywhere.
- `fetch_url` is read-only and enabled by default: it refuses private or
  reserved network addresses (including after redirects and non-canonical IPv6
  forms) and pins the connection to the validated addresses. It always treats
  fetched content as untrusted data. It does not run JavaScript and sends no
  cookies. Disable it entirely with `tools.web.enabled: false` or `--no-web`.
- Every tool call is appended to `audit.jsonl`, including approval requests
  and their answers.
- The web interface (`basicagent-web`) binds to loopback by default. Every
  `/api` request needs the bearer token printed at startup, and Host/Origin
  checks block DNS rebinding from other local pages. It writes only the same
  config file and data directory the CLI uses.
- One-shot mode denies approval-required actions unless `--yes` is passed;
  `--yes` auto-approves in the REPL as well.

## Changing yourself

- **Config**: edit the config file with `edit_file` (approval is asked), then
  `/reload` in the REPL applies it; one-shot runs read it on next start. The
  web interface's Settings tab edits the same file, validating the values and
  live-reloading every session on save. Never claim a config change took
  effect without a reload or restart.
- **Name/persona**: set `agent.systemPrompt` or `agent.systemPromptFile`;
  the program, paths, tools and skills keep the name basicagent.
- **Source**: read `docs/ARCHITECTURE.md` first. Add tools in
  `src/tools/<name>.mjs` and register them in `src/tools/index.mjs`; add tests
  under `test/`; keep `README.md` and `docs/` in sync; run `npm test`.
- **Version**: `package.json` `version` is the single source (the CLI reads
  it). Releases are tagged `vX.Y.Z` and pushed to GitHub.

## Memory and sessions

Facts saved with `remember` appear in every future prompt; `search_memory` finds
past records and `forget` removes them. `--continue` resumes the last session's
user/assistant text only (no tool traffic); `--session <id>` pins a named
conversation; `--ephemeral` disables memory entirely. The web interface's
Memory tab lists facts (add and delete), session transcripts and the audit
log; each web turn re-reads `facts.jsonl` so tabs stay in sync.

## CLI

REPL: `basicagent`. One-shot: `basicagent "prompt"`. Web interface:
`basicagent-web` (or `npm run web`) serves `http://127.0.0.1:8787` by default
and opens it in the default browser (`--no-open` skips that); `--port`,
`--host` and `--token` adjust it. Guided configuration: `basicagent-setup`
(provider, model, key, shell access, config/data dirs; tests the provider and
can start the web interface). Scripting:
`basicagent --json "prompt"` emits JSONL events (`assistant_delta`,
`tool_start`, `tool_end`, `done`, `error`, `approval`). The web interface
streams the same events plus `approval_result` and `aborted`; there the
`approval` event carries an `id` answered with `POST /api/approvals/:id`.
Handy flags: `--no-web` (disable web fetch for one run), `--continue`,
`--session <id>`, `--ephemeral`. REPL commands: `/help /new /reload /skills
/tools /model [name] /config /quit`.

## Skills

A skill is `<dir>/SKILL.md` with frontmatter (`name`, `description`) and
instructions. Only the name and description are always visible; the body loads
through `load_skill`. This bundled skill lives in the project's
`skills/basicagent/`; personal skills go in `~/.config/basicagent/skills/`.

## Tests

`npm test` is offline (fake provider; 124 tests including the web server).
`npm run test:live` is an opt-in Ollama Cloud integration test and needs
`OLLAMA_API_KEY_CLOUD` (model `gemma4:31b`).
