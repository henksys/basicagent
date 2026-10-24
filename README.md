# basicagent

A small, focused command line agent that runs an OpenAI-compatible model
(Ollama, llama.cpp, DeepSeek, OpenAI, ...) in a tool-calling loop. It is fast
by design: one-shot runs start instantly, the local web interface is a small
hand-written app with no build step, and there is no framework between you and
the provider.

basicagent stays lean by being skill-based. Capabilities are added with
SKILL.md files rather than by growing an internal tool surface. You can write
a SKILL.md yourself, ask the agent to write one for you, or use one that
teaches it to drive a program already installed on the machine. The built-in
toolset is deliberately small:

- file reading, writing, editing, appending, listing and renaming
- shell commands (off by default, approval-based)
- web fetch with SSRF and domain protection
- SKILL.md skills and persistent JSONL memory

**Size:** less then 1 mb. The agent itself is about 8,100 lines of source (CLI, core and web
interface). The test suite adds about 3,600 lines; together they are about
11,700. Node.js 24+ built-ins are the only requirement: no external
dependencies and no build step.

Security is deliberately visible and configurable: tools can be enabled,
disabled or scoped; read-only mode blocks file writes and limits shell commands;
guarded actions ask for approval; web fetch is SSRF-protected; and every tool
call is audited. A configurable circuit breaker stops repeated failing tool
calls from looping.

## Requirements

It only requires [Node 24](https://nodejs.org/en/about/previous-releases) or newer (declared in `package.json` engines).

## Features

- **OpenAI-compatible providers** — Ollama, Ollama Cloud, llama.cpp, DeepSeek, OpenAI.
- **Image input for vision models** — attach PNG, JPEG or WebP from the CLI or web interface.
- **Interactive and scriptable** — REPL, instant one-shot runs, JSON-lines output, and a fast local web interface.
- **Lean, skill-based toolset** — file tools, shell, web fetch, SKILL.md skills and persistent JSONL memory.
- **Configurable safety** — file-root policies, approval prompts, read-only tool mode with a shell allowlist, SSRF protection and an audit log.
- **Loop protection** — iteration limits and a configurable circuit breaker for repeated identical tool failures.
- **Guided setup** — writes the config, tests the provider and can start the web UI.
- **Zero dependencies** — Node.js 24+ built-ins only, no build step.

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
  context gauge shows how full the whole-prompt token budget
  (`agent.contextTokens`) is — not the model's context window. Compaction
  points appear in the transcript with the summary available to inspect. A
  per-conversation **Read-only** toggle sits in the composer. Images can be
  attached with the composer button, dragged in or pasted; the model must
  support vision.
- **Settings** — edits the same `config.json` the CLI reads (provider, images,
  agent limits, file roots, shell, web tool, skills, memory) plus an Advanced section
  for read-only mode and the tool-breaker threshold. Saving validates the
  result, writes the file atomically and live-reloads the agent. The API key
  is never sent to the browser; leave the field empty to keep it. The chat
  window also has a per-conversation **Read-only** toggle; the Settings
  checkbox supplies the default for new conversations.
- **Memory** — facts (add/delete), session transcripts and a filterable audit
  log with manual age-based pruning, all straight from the JSONL files.

## Images

Vision-capable models can inspect **PNG, JPEG and WebP** images. The supported
file extensions are `.png`, `.jpg`, `.jpeg` and `.webp`; JPG and JPEG are the
same format. Files are identified by their content, not their extension.
GIF, BMP, TIFF, HEIC, AVIF, SVG, ICO, JPEG XL, RAW and PDF are not supported.
The image is base64-encoded and sent as a standard OpenAI `image_url` content
part, which works with OpenAI-compatible cloud APIs, Ollama and llama.cpp.

```sh
basicagent --image screenshot.png "What error is shown here?"
basicagent -i before.webp -i after.webp "What changed?"
```

In the REPL, `/image path` queues an image for the next message; `/image`
lists pending attachments and `/image clear` removes them. The web composer
accepts the same formats through its attach button, drag-and-drop or paste.
Images are limited to 4 per message and 5 MiB each by default (`images` in the
config). The model itself must support vision; otherwise the provider returns
an error and Basicagent explains the likely cause.

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

  --config <file>   config file (default ~/.config/basicagent/config.json)
  --cwd <dir>       working directory for this run
  --data-dir <dir>  data directory for facts/sessions/audit
                    (default $XDG_DATA_HOME/basicagent, or ~/.local/share/basicagent)
  --model <name>    override the model
  --base-url <url>  override the provider URL
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
```

REPL commands: `/help /new /reload /skills /tools /model [name] /context
/compact /image [path|clear] /readonly [on|off] /config /quit`.

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

basicagent is an independent, from-scratch implementation. All code in this
repository was written for this project; its design follows patterns common to
tool-using agents, such as skill files, schema-validated tool registries and
approval-based guardrails.
