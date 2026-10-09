---
name: basicagent
description: >
  basicagent's own identity, configuration and extension guide. Use when the
  user asks how this agent works, where its config or memory lives, how to
  change settings, add tools or skills, or modify its source.
---

# basicagent self-help

You run inside **basicagent**, a small dependency-free CLI agent that runs an
OpenAI-compatible model in a tool-calling loop. Node 24+ only, no npm
dependencies. Version and repository URL are in `package.json`; license is
GPL-3.0-or-later. "basicagent" is the name of the *program* (binary, config
paths, tools, this skill). The user may give *you* a different name or persona
via `agent.systemPrompt` / `agent.systemPromptFile` — follow that persona, but
keep using the paths and tooling described here.

## Where things live

| Thing | Location |
| --- | --- |
| Config | `~/.config/basicagent/config.json` (or `--config`, `BASICAGENT_CONFIG`) |
| Data | `~/.local/share/basicagent` (or `memory.dir`), mode 0700 |
| Facts | `facts.jsonl` — injected into your system prompt on every run |
| Sessions | `sessions/<id>.jsonl`; `last-session.txt` drives `--continue` |
| Audit | `audit.jsonl` — one line per tool call |
| Source | `bin/basicagent.mjs` (CLI), `src/` (loop, provider, tools), `skills/`, `docs/`, `test/` |

Env overrides: `BASICAGENT_API_KEY`, `BASICAGENT_BASE_URL`, `BASICAGENT_MODEL`.

## Configuration you can change

- `provider`: `baseUrl` (e.g. `https://ollama.com/v1`), `model`, `apiKey` or
  `apiKeyEnv` (name of an environment variable), `temperature`, `maxTokens`,
  `timeoutMs`, `toolChoice` (omit it for Ollama).
- `agent`: `maxIterations`, `contextChars`, `maxResultChars`,
  `systemPrompt` / `systemPromptFile` (use these to rename/re-persona yourself).
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
- Writes inside `protectedPaths` — and always your own config file — require
  approval (when that file is inside an allowed root).
- `run_command` is off by default. When enabled, every call is shown and needs
  approval; approving a command is full trust, because a command can write
  anywhere.
- `fetch_url` is read-only and enabled by default: it refuses private or
  reserved network addresses (including after redirects), and always treats
  fetched content as untrusted data. It does not run JavaScript and sends no
  cookies. Disable it entirely with `tools.web.enabled: false` or `--no-web`.
- Every tool call is appended to `audit.jsonl`.
- One-shot mode denies approval-required actions unless `--yes` is passed.

## Changing yourself

- **Config**: edit the config file with `edit_file` (approval is asked), then
  `/reload` in the REPL applies it; one-shot runs read it on next start. Never
  claim a config change took effect without a reload or restart.
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
conversation; `--ephemeral` disables memory entirely.

## CLI

REPL: `basicagent`. One-shot: `basicagent "prompt"`. Scripting:
`basicagent --json "prompt"` emits JSONL events (`assistant_delta`,
`tool_start`, `tool_end`, `done`, `error`, `approval`). Handy flags:
`--no-web` (disable web fetch for one run), `--continue`, `--session <id>`,
`--ephemeral`. REPL commands: `/help /new /reload /skills /tools
/model [name] /config /quit`.

## Skills

A skill is `<dir>/SKILL.md` with frontmatter (`name`, `description`) and
instructions. Only the name and description are always visible; the body loads
through `load_skill`. This bundled skill lives in the project's
`skills/basicagent/`; personal skills go in `~/.config/basicagent/skills/`.

## Tests

`npm test` is offline (fake provider). `npm run test:live` is an opt-in Ollama
Cloud integration test and needs `OLLAMA_API_KEY_CLOUD` (model `gemma4:31b`).
