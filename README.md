# basicagent

A small, dependency-free transparant (not a blackbox) command line agent. It runs an OpenAI-compatible model (Ollama, llama.cpp, DeepSeek, OpenAI, ...) in a tool-calling loop with file tools, shell access, SKILL.md skills and persistent memory.

It can be used for scripted tasks, as a command line assistant, or through the web interface. Its tool-calling scope is deliberately small, which keeps it fast,transparent and safe. Can be used to study the basics, it has good documentation, and it can be easily expanded.

As a personal assistant it is basic by design, but one can teach/allow it to use the available machine's tools ( let it learn the programs by reading man pages or searching the web, and then ask it to write skills for something like pandoc or pdftotext or any other command-line program, and after that it can perform the tasks with those programs by using the skills it wrote).

So basically it grows more capable while using it. It can assist with for example systemd configuration/information and logs  and other settings, or write code/scripts.

It also ships a local web interface (chat, settings, memory and audit log)
Zero-dependency: Node 24+ built-ins only.

## Requirements

It only requires [Node 24](https://nodejs.org/en/about/previous-releases) or newer (declared in `package.json` engines).

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
  context trimming, an optional output-token cap, Ctrl+C abort.
- **File tools** — read, write, edit, append, list, rename, with a
  root-based access policy (`rw` / `ro` / `approval` / `deny`, most specific
  root wins), symlink-safe path checks and protected paths (config file and
  memory data directory included).
- **Web fetch** — a zero-dependency `fetch_url` tool with SSRF protection
  (private/reserved addresses blocked before and after redirects, including
  non-canonical IPv6 forms; the connection is pinned to the validated
  addresses), domain allow/deny lists, bounded HTML-to-text extraction, and no
  cookies or JS. Disable it with `tools.web.enabled: false` or `--no-web`.
- **Skills** — SKILL.md discovery with on-demand `load_skill` loading; the same
  format used by Claude-style skill directories. Ships a bundled
  [`basicagent` self-help skill](skills/basicagent/SKILL.md) that describes the
  agent's own configuration, memory, guardrails and extension process.
- **Persistent memory** — facts and conversation text in plain JSONL under
  `$XDG_DATA_HOME/basicagent` (or `~/.local/share/basicagent`); set it per
  agent with `memory.dir`, `BASICAGENT_DATA_DIR` or `--data-dir`; resume with
  `--continue` or `--session`.
- **Interactive and scriptable** — REPL for conversation, one-shot mode for
  automation, `--json` event stream for embedding.
- **Guided setup** — `basicagent-setup` asks for the provider, model, API key,
  shell access and the config/data directories, tests the connection and can
  start the web interface when done. Enter accepts the defaults from
  `config.example.json` or your existing config.
- **Local web interface** — `basicagent-web` serves a browser UI on
  `127.0.0.1` (chat with live streaming and inline approvals, a settings
  editor for the config file, and browsable facts, sessions and the audit
  log). Token-protected, loopback-only by default, no framework and no build
  step; it opens in your default browser on startup.
- **Guardrails you can see** — approval prompts, an append-only
  `audit.jsonl`, bounded outputs and a shell tool that is off by default.
- **Zero dependencies** — Node 24+ built-ins only.

## Quick start

```sh
# guided setup: writes the config, tests the provider, offers the web UI
node bin/basicagent-setup.mjs        # or: npm run setup

# or run directly; without a config it expects local Ollama
node bin/basicagent.mjs "list the files here and summarize the project"

# Ollama Cloud
BASICAGENT_BASE_URL=https://ollama.com/v1 \
BASICAGENT_API_KEY="$OLLAMA_API_KEY_CLOUD" \
node bin/basicagent.mjs --model gemma4:31b "say hello"
```

The setup writes `~/.config/basicagent/config.json` (copy
`config.example.json` there to do it by hand). Full provider recipes and
configuration are in the [tutorial](docs/TUTORIAL.md).

## Web interface

```sh
node bin/basicagent-web.mjs        # or: npm run web
```

The server binds to `127.0.0.1:8787` by default and prints a URL with an
access token in the fragment; it also opens that URL in your default browser
automatically (use `--no-open` to skip, e.g. in scripts or over SSH). The
token is required for every `/api` request, so other local programs (and
websites trying DNS rebinding) cannot drive the agent. `--port`, `--host` and
`--token` are available if you need them; a non-loopback `--host` drops the
host/origin checks that only make sense for local use.

The UI has three tabs:

- **Chat** — sessions in the sidebar, streamed answers, tool calls with their
  arguments and results, and approve/deny buttons when a guarded action needs
  confirmation. Stop cancels the running turn; closing the tab aborts it. A
  context gauge shows how full the agent's auto-trim budget
  (`agent.contextChars`) is — not the model's context window.
- **Settings** — edits the same `config.json` the CLI reads (provider, agent
  limits, file roots, shell, web tool, skills, memory). Saving validates the
  result, writes the file atomically and live-reloads the agent. The API key
  is never sent to the browser; leave the field empty to keep it.
- **Memory** — facts (add/delete), session transcripts and the audit log,
  all straight from the JSONL files.

## Documentation

- [docs/TUTORIAL.md](docs/TUTORIAL.md) — setup, providers, usage, skills,
  guardrails, troubleshooting.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the code is organized,
  the turn lifecycle, and how to add tools/providers/skills.
- [persona-example.md](persona-example.md) — the default agent persona and how
  to replace it.
- [skills/basicagent/SKILL.md](skills/basicagent/SKILL.md) — the bundled
  self-help skill the agent loads when asked about itself.
- `skills/example/SKILL.md` — skill template.
- Source files carry explanatory comments throughout.

## CLI summary

```
basicagent [options] [prompt]

  --config <file>   config file (default ~/.config/basicagent/config.json)
  --cwd <dir>       working directory for this run
  --data-dir <dir>  data directory for facts/sessions/audit
                    (default $XDG_DATA_HOME/basicagent, or ~/.local/share/basicagent)
  --model <name>    override the model
  --base-url <url>  override the provider URL
  --continue        resume the most recent session
  --session <id>    use a named session
  --ephemeral       disable memory for this run
  --no-web          disable the fetch_url web tool for this run
  --json            JSON-lines event output (for scripts)
  --yes             auto-approve guarded actions without asking (dangerous)
```

The web server is a separate command:

```
basicagent-web [options]

  --port <number>   port to listen on (default 8787)
  --host <address>  address to bind (default 127.0.0.1)
  --token <string>  fixed access token (default: random, printed at startup)
  --no-open         do not open the interface in the default browser
  --config/--cwd/--data-dir/--model/--base-url/--api-key/--no-web
```

The guided setup is its own command too:

```
basicagent-setup [options]

  --config <file>  config file to create or edit (default ~/.config/basicagent/config.json)
  --no-test        skip the provider connection test
  --no-start       do not offer to start the web interface
```

## Development

```sh
npm test           # offline tests, fake provider, no network
npm run test:live  # opt-in: requires OLLAMA_API_KEY_CLOUD
```

## License

GNU General Public License v3.0 or later (GPL-3.0-or-later). See [LICENSE](LICENSE).

Copyright (C) 2026 Henk Duisterwinkel

basicagent is an independent, from-scratch implementation. All code in this
repository was written for this project; its design follows patterns common to
tool-using agents, such as skill files, schema-validated tool registries and
approval-based guardrails.
