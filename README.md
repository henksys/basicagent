# <img src="web/assets/favicon.svg" width="48"> basicagent


CLI agent + web-interface that runs on Node.js® v24 or higher.

Can be configured with any OpenAI-compatible (local or cloud) model.

This agent is SKILL-based, therefore the built-in toolset is deliberately small:

- file reading, writing, editing, appending, listing and renaming
- shell commands (off by default, approval-based)
- web fetch with SSRF and domain protection
- SKILL.md skills and persistent JSONL memory

**Size:** the source is under 1 Mb.

Security is deliberately visible and configurable. Guardrails are not only suggestions.


## Recommended models

- For scripting with fine-tuned instructions: *Qwen3.5-2B* (or equivalent).
- As an actual assistant, at minimum: *Qwen3.5-4B* (or equivalent).
- Ideally: *Qwen3.5-9B* (or equivalent or higher).

*note: the more capable the model is, the less precise instructions it needs. The same goes for the SKILL.md files.*



## Requirements

basicagent requires [Node.js 24](https://nodejs.org/en/about/previous-releases)
or newer (declared in `package.json` engines). There are no external
dependencies or packages

## Features

- **OpenAI-compatible providers** — Ollama, Ollama Cloud, llama.cpp, DeepSeek, OpenAI, etc.
- **Image input for vision models** — attach PNG, JPEG or WebP from the CLI or web interface.
- **Interactive and scriptable** — REPL, instant one-shot runs, JSON-lines output, and a fast local web interface.
- **Lean, skill-based toolset** — file tools, shell, web fetch, SKILL.md skills and persistent JSONL memory.
- **Configurable safety** — file-root policies, approval prompts, read-only tool mode with a shell allowlist, SSRF protection, and an audit log with manual age-based pruning.
- **Loop protection** — iteration limits and a configurable circuit breaker for repeated identical tool failures.
- **Guided setup** — writes the config, tests the provider and can start the web UI.

## Quick start

Get the code first:

```sh
git clone https://github.com/henksys/basicagent.git
cd basicagent
```
(or download the latest release)

Then run the guided setup:

```sh
# guided setup: writes the config, tests the provider, offers the web UI
node bin/basicagent-setup.mjs        # or: npm run setup
```

The setup writes `~/.config/basicagent/config.json` (copy
`config.example.json` there to do it by hand). Full provider recipes and
configuration are in the [tutorial](docs/TUTORIAL.md). After finishing the guided setup, the web-interface will automatically open in your default browser. 


## Web interface

```sh
node bin/basicagent-web.mjs        # or: npm run web
```

The server binds to `127.0.0.1:8787` by default and prints a URL with an
access token in the fragment; it also opens that URL in your default browser
automatically.

## Images

Vision-capable models can inspect **PNG, JPEG and WebP** images. The supported
file extensions are `.png`, `.jpg`, `.jpeg` and `.webp`; JPG and JPEG are the
same format. Files are identified by their content, not their extension.

```sh
basicagent --image screenshot.png "What error is shown here?"
basicagent -i before.webp -i after.webp "What changed?"
```

## Documentation

- [docs/TUTORIAL.md](docs/TUTORIAL.md) — setup, providers, usage, skills,
  guardrails, troubleshooting.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the code is organized,
  the turn lifecycle, and how to add tools/providers/skills.
- [docs/SKILLBASEDFUNTIONALITY.md](docs/SKILLBASEDFUNTIONALITY.md) — how to add
  functionality with skills, using PDF Q&A via `pdftotext` and `grep` as an
  example.
- [persona-example.md](persona-example.md) — the default agent persona and how
  to replace it.
- [skills/basicagent/SKILL.md](skills/basicagent/SKILL.md) — the bundled
  self-help skill the agent loads when asked about itself.
- `skills/example/SKILL.md` — skill template.
- Source files carry explanatory comments throughout.

## CLI summary

```
basicagent [options] [prompt]
echo "prompt" | basicagent [options]

  --config <file>   config file (default ~/.config/basicagent/config.json)
  --cwd <dir>       working directory for this run
  --data-dir <dir>  data directory for facts/sessions/audit
                    (default $XDG_DATA_HOME/basicagent, or ~/.local/share/basicagent)
  --model <name>    override the model
  --base-url <url>  override the provider URL
  --api-key <key>   override the API key (prefer BASICAGENT_API_KEY or apiKeyEnv)
  --image, -i <file> attach an image (PNG/JPEG/WebP; repeatable)
  --continue        resume the most recent session
  --session <id>    use a named session
  --ephemeral       disable memory for this run
  --no-web          disable the fetch_url web tool for this run
  --read-only       only allow read-only tool calls (no file writes; shell
                    commands must match tools.shell.readOnlyAllowlist)
  --no-read-only    disable read-only tool mode for this run
  --json            JSON-lines event output (for scripts)
  --no-color        disable ANSI colors in terminal output
  --yes             auto-approve guarded actions without asking (dangerous)
  -h, --help        show help
  -v, --version     show version
```

REPL commands: `/help /new /reload /skills /tools /model [name] /context
/compact /image [path|clear] /readonly [on|off] /config /quit`.

The web server summary:

```
basicagent-web [options]

  --port <number>   port to listen on (default 8787)
  --host <address>  address to bind (default 127.0.0.1)
  --token <string>  fixed access token (default: random, printed at startup)
  --no-open         do not open the interface in the default browser
  --config/--cwd/--data-dir/--model/--base-url/--api-key/--no-web
  -h, --help        show help
  -v, --version     show version
```

The guided setup summary:

```
basicagent-setup [options]

  --config <file>  config file to create or edit (default ~/.config/basicagent/config.json)
  --no-test        skip the provider connection test
  --no-start       do not offer to start the web interface
  -h, --help       show help
  -v, --version    show version
```

## Development

```sh
npm test           # offline tests, fake provider, no network
npm run test:live  # opt-in: requires OLLAMA_API_KEY_CLOUD
```


## Privacy

No telemetry and no update checker. Only network connections that the user itself initiates.

## License

GNU General Public License v3.0 or later (GPL-3.0-or-later). See [LICENSE](LICENSE).

basicagent is an independent, from-scratch implementation. All code in this
repository was written for this project.
