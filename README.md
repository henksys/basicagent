# basicagent

A small, dependency-free command line agent. It runs an OpenAI-compatible
model (Ollama, llama.cpp, DeepSeek, OpenAI, ...) in a tool-calling loop with
file tools, shell access, SKILL.md skills and persistent memory.

## Requirements

It only requires Node 24 or newer (declared in `package.json` engines).

## Example

```
$ basicagent
basicagent> add a timeout option to src/provider.mjs and run the tests
[tool] read_file {"path":"src/provider.mjs"}
[tool] edit_file {"path":"src/provider.mjs","old_string":"...","new_string":"..."}
[tool] run_command {"command":"npm","args":["test"]}
...
Done: added provider.timeoutMs handling and all tests pass.
```

## Features

- **Any OpenAI-compatible provider** — local Ollama, Ollama Cloud, llama.cpp,
  DeepSeek, OpenAI. Configure `baseUrl`, `model` and an API-key environment
  variable.
- **Agent loop with limits** — iteration cap, repeated-failure circuit breaker,
  context trimming, Ctrl+C abort.
- **File tools** — read, write, edit, append, list, rename, with a
  root-based access policy (`rw` / `ro` / `approval` / `deny`), symlink-safe
  path checks and protected paths.
- **Web fetch** — a zero-dependency `fetch_url` tool with SSRF protection
  (private/reserved addresses blocked before and after redirects), domain
  allow/deny lists, bounded HTML-to-text extraction, and no cookies or JS.
  Disable it with `tools.web.enabled: false` or `--no-web`.
- **Skills** — SKILL.md discovery with on-demand `load_skill` loading; the same
  format used by Omarchy/Claude-style skill directories. Ships a bundled
  [`basicagent` self-help skill](skills/basicagent/SKILL.md) that describes the
  agent's own configuration, memory, guardrails and extension process.
- **Persistent memory** — facts and conversation text in plain JSONL under
  `~/.local/share/basicagent` (configurable via `memory.dir`); resume with
  `--continue` or `--session`.
- **Interactive and scriptable** — REPL for conversation, one-shot mode for
  automation, `--json` event stream for embedding.
- **Guardrails you can see** — approval prompts, an append-only
  `audit.jsonl`, bounded outputs and a shell tool that is off by default.
- **Zero dependencies** — Node 24+ built-ins only.

## Quick start

```sh
# local Ollama (default)
node bin/basicagent.mjs "list the files here and summarize the project"

# Ollama Cloud
BASICAGENT_BASE_URL=https://ollama.com/v1 \
BASICAGENT_API_KEY="$OLLAMA_API_KEY_CLOUD" \
node bin/basicagent.mjs --model gemma4:31b "say hello"
```

Then copy `config.example.json` to `~/.config/basicagent/config.json` to make
it permanent. Full provider recipes and configuration are in the
[tutorial](docs/TUTORIAL.md).

## Documentation

- [docs/TUTORIAL.md](docs/TUTORIAL.md) — setup, providers, usage, skills,
  guardrails, troubleshooting.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the code is organized,
  the turn lifecycle, and how to add tools/providers/skills.
- [skills/basicagent/SKILL.md](skills/basicagent/SKILL.md) — the bundled
  self-help skill the agent loads when asked about itself.
- `skills/example/SKILL.md` — skill template.
- Source files carry explanatory comments throughout.

## CLI summary

```
basicagent [options] [prompt]

  --config <file>   config file (default ~/.config/basicagent/config.json)
  --cwd <dir>       working directory for this run
  --model <name>    override the model
  --base-url <url>  override the provider URL
  --continue        resume the most recent session
  --session <id>    use a named session
  --ephemeral       disable memory for this run
  --no-web          disable the fetch_url web tool for this run
  --json            JSON-lines event output (for scripts)
  --yes             auto-approve guarded actions in one-shot mode (dangerous)
```

## Development

```sh
npm test           # offline tests, fake provider, no network
npm run test:live  # opt-in: requires OLLAMA_API_KEY_CLOUD
```

## License

GNU General Public License v3.0 or later (GPL-3.0-or-later). See [LICENSE](LICENSE).

basicagent is an independent, from-scratch implementation. All code in this
repository was written for this project; its design follows patterns common to
tool-using agents, such as skill files, schema-validated tool registries and
approval-based guardrails.
