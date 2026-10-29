# basicagent tutorial

A five minute setup guide, then the features you will actually use.

## Requirements

- **[Node.js 24 or newer](https://nodejs.org/en/about/previous-releases)** (`node --version`). Nothing else: no npm install, no
  dependencies, no build step.

## 1. Set it up

The guided setup walks you through everything with a handful of questions
(provider, model, API key, shell access, config and data directories), writes
the config file, tests the connection and then offers to start the web
interface in your browser:

```sh
node bin/basicagent-setup.mjs     # or: npm run setup
```

Every question shows a `[default]`; press Enter to accept it. The defaults
come from your existing config file, or from `config.example.json` on a fresh
install. For a local Ollama the whole setup is Enter-only. Read-only mode and
its shell allowlist are not setup questions: a fresh config contains the
defaults (read-only off), and an existing config can stay unchanged because the
runtime supplies them. Edit them later under Settings → Advanced. If you prefer
to configure by hand, section 3 lists the provider recipes.

## 2. Run it

From the project directory:

```sh
node bin/basicagent.mjs
```

Or install the `basicagent` command on your PATH:

```sh
npm link          # from the project directory, optional
basicagent
```

You can also run one-shot without the REPL:

```sh
node bin/basicagent.mjs "list the files in this directory and summarize the project"
```

Without configuration basicagent expects a local Ollama at
`http://localhost:11434/v1`; run the setup in section 1, or pick a provider
recipe in section 3.

## 3. Pick a provider

The setup in section 1 writes this for you; these are the recipes for a manual
config file. Create the config directory and copy the example:

```sh
mkdir -p ~/.config/basicagent
cp config.example.json ~/.config/basicagent/config.json
```

Then edit `provider` in `~/.config/basicagent/config.json`.

**Ollama Cloud** (no local install needed):

```json
"provider": {
  "baseUrl": "https://ollama.com/v1",
  "apiKeyEnv": "OLLAMA_API_KEY_CLOUD",
  "model": "gemma4:31b"
}
```

The key is read from the named environment variable at startup, so it stays
out of the file. Any variable works: `OLLAMA_API_KEY_CLOUD` here,
`DEEPSEEK_API_KEY` below, and so on.

**Local Ollama**:

```json
"provider": { "baseUrl": "http://localhost:11434/v1", "model": "qwen3:8b" }
```

Ollama ignores the API key; no key needed.

**llama.cpp server** (`llama-server --jinja -m model.gguf`):

```json
"provider": { "baseUrl": "http://localhost:8080/v1", "model": "local" }
```

**DeepSeek**:

```json
"provider": {
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "model": "deepseek-chat"
}
```

**OpenAI**:

```json
"provider": {
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "model": "gpt-5.1"
}
```

Quick sanity check without touching config:

```sh
BASICAGENT_BASE_URL=https://ollama.com/v1 \
BASICAGENT_API_KEY="$OLLAMA_API_KEY_CLOUD" \
node bin/basicagent.mjs --model gemma4:31b "say hello in one short sentence"
```

### Give your agent a different name

The program is always `basicagent`, but the persona the model adopts is yours.
Set `agent.systemPrompt` (or `agent.systemPromptFile` pointing at a text file)
to replace the default "You are basicagent, ..." paragraph:

```json
"agent": { "systemPrompt": "You are Alfred, a concise command line assistant." }
```

Only the persona paragraph is replaced; the environment, skills and safety
sections are still appended. The bundled `basicagent` self-help skill also
follows the configured persona while keeping the program's paths and tooling.
The default paragraph is written out in `persona-example.md`; copy it if you
want to tweak the wording instead of replacing it entirely.

### Output cap, context budget, and the model's context window

Three limits are easy to confuse:

- `provider.maxTokens` is an optional cap on **one model answer**. When set it
  is sent as `max_tokens` with the request; when it is unset the provider
  applies its own default output limit (for example, DeepSeek defaults to 4096
  with a maximum of 8192). Tool-call arguments count as output, so a low cap
  can truncate a large `write_file` or `edit_file`, and a value above what the
  provider allows may be rejected with an HTTP 400.
- `agent.contextTokens` (default `24000`) is the budget for the **whole
  prompt** basicagent is willing to send.
- The model's **context window** is the provider's hard ceiling: 8k, 32k,
  128k or 256k tokens depending on the model and how the server is configured.

#### What the budget counts

The budget covers everything in the request: the system prompt and persona,
the skills index, saved facts, tool definitions, the conversation summary and
the messages. With the default tools and memory enabled that fixed part is
about **1,900 tokens** before the first message (roughly 600 for the system
prompt and 1,300 for the tool schemas), so the Web UI gauge starts around 8% of
a 24k budget. That is the real prompt size, not an overhead bug. Saved facts
can add up to ~1,000 tokens and each compaction summary is counted too.
Attached images are counted as `images.tokensPerImage` (default **1,200** each),
not as their base64 size; raise it if your model's vision encoder is expensive.
An image turn that is summarized away stops costing image tokens, but while it
remains in recent history every tool iteration re-sends it.

#### Why the budget is smaller than the window

Setting `contextTokens` to the model's maximum is usually a bad idea:

- every request resends the whole prompt, so input cost and time-to-first-token
  grow with it;
- long histories dilute the model's attention and make tool selection worse;
- you still need room for the answer and for tool-call arguments;
- Ollama's `num_ctx` setting can be lower than the model card, so the window
  you think you have may not be the one the server serves.

A 256k window does **not** mean 256k tokens of useful history. Practical
starting points:

| Model window | Suggested `contextTokens` |
| --- | --- |
| 8k | 6k |
| 32k | 16k–24k |
| 128k | 32k |
| 256k | 32k–64k |

The default `24000` assumes the server actually serves at least a ~32k window.
If you run an 8k local model, lower `contextTokens` to `6000`; otherwise the
provider will truncate the request or reject it.

#### What happens when the budget fills

At `agent.compactAt` (default `0.8`, i.e. 80% of the budget) basicagent
summarizes the oldest part of the conversation:

- the most recent turns stay verbatim (about a quarter of the budget, capped at
  8k tokens);
- the older turns are replaced by a plain-text summary, which is sent as part
  of the system prompt and stored in the session file;
- a compaction notice appears in the CLI (`[context] summarized …`) and in the
  Web UI transcript, where the summary can be expanded;
- if the summary call fails, basicagent falls back to the old behavior:
  replace old tool results with `[tool result trimmed to save context]`, then
  drop the oldest exchanges. A failed summary never breaks a turn.

Set `agent.compact: "off"` to skip summarization and always use that trimming
fallback. The REPL has `/context` to show the current size and `/compact` to
summarize now. `agent.maxResultChars` is a separate cap on one tool result;
it stops a single command or download from consuming the whole budget.

#### Where the number comes from

With `provider.includeUsage: true` the provider reports exact
`prompt_tokens`, which already includes the system prompt, tools, summary and
messages. Without it, basicagent estimates from UTF-8 bytes (roughly four
bytes per English token) and marks notice numbers with `~`. Not every
OpenAI-compatible server accepts `stream_options`, which is why usage is
opt-in; enable it if you want exact numbers.

#### Upgrading from `contextChars`

Before 1.4.0 the budget was `agent.contextChars` (default `100000`). It has
been replaced by `agent.contextTokens` because characters are not tokens and
the old number counted only the stored messages, ignoring the system prompt,
skills, facts and tool definitions.

A config that still contains `agent.contextChars` now stops at startup with a
message explaining the rename. Convert with `tokens ≈ chars / 4`: the old
default `100000` was roughly `25000` tokens, so the new default `24000`
preserves the old working size. Running `basicagent-setup` on an existing
config migrates the value automatically and shows what it wrote.

## 4. Use the REPL

```sh
basicagent
```

```
basicagent 1.7.2
model     gemma4:31b @ https://ollama.com/v1
cwd       /home/you/Projects/basicagent
readonly  off
skills    basicagent, example, omarchy, ...
basicagent> read package.json and tell me what scripts it defines
```

While the agent works you see a trace on stderr:

```
[tool] read_file {"path":"package.json"}
[tool] read_file ok (3ms)
```

Commands:

| Command | Effect |
| --- | --- |
| `/help` | List commands |
| `/new` | Start a new conversation session |
| `/reload` | Re-read the config file, skills and provider (keeps history) |
| `/skills` | List discovered skills |
| `/tools` | List registered tools available in the current mode |
| `/model [name]` | Show or change the model for this session |
| `/context` | Show the current context size, budget, message count and summary state |
| `/compact` | Summarize older turns now |
| `/image [path\|clear]` | Attach an image (PNG/JPEG/WebP) to the next message; list or clear attachments |
| `/readonly` | [on or off] Show or change read-only tool mode for this session |
| `/config` | Show the resolved config with the API key masked |
| `/quit` | Exit (Ctrl+D works too) |

Ctrl+C cancels the running turn, not the program. In a terminal the
`basicagent` part of the prompt is cyan, matching tool-call labels;
`--no-color` or `NO_COLOR=1` disables color.

## 5. Images

If the model supports vision, Basicagent can send images with a prompt.
These are the only supported formats:

| Format | Extensions | MIME type |
| --- | --- | --- |
| PNG | `.png` | `image/png` |
| JPEG | `.jpg`, `.jpeg` | `image/jpeg` |
| WebP | `.webp` | `image/webp` |

JPG and JPEG are the same format. Files are identified by their content (magic
bytes), not their extension, so an oddly named file still works if it really is
PNG, JPEG or WebP. GIF, BMP, TIFF, HEIC, AVIF, SVG, ICO, JPEG XL, RAW and PDF
are **not** supported; there is no conversion or resizing.

These three formats are the intersection accepted by OpenAI, Ollama and
llama.cpp. The original bytes are base64-encoded and sent as a standard OpenAI
`image_url` content part; no external tool is needed.

One-shot:

```sh
basicagent --image screenshot.png "What does this error mean?"
basicagent -i before.jpg -i after.jpg "Describe what changed between these two."
```

REPL:

```text
basicagent> /image ~/Pictures/screenshot.png
Attached image: screenshot.png (image/png, 412.3 KiB). It will be sent with your next message.
basicagent> What is shown in this screenshot?
```

`/image` without an argument lists pending images, and `/image clear` removes
them. The attachment is consumed by the next message, so you can queue several
images (up to 4 by default) before asking a question.

Photos, screenshots and diagrams work well. The model does OCR itself if it has
that capability; Basicagent does not run a separate OCR tool. The model must be
multimodal: `qwen3-vl`, Gemma vision models, and similar. A text-only model
returns an error from the provider, and Basicagent adds a hint that the model
or server may not support images.

Notes:

- Defaults are 4 images per message and 5 MiB per image. Change them in the
  `images` section of the config.
- Image tokens depend on the provider's vision encoder, not on the base64 file
  size. The default budget estimate is 1,200 tokens per image; adjust
  `images.tokensPerImage` if your model uses a different amount. The context
  gauge and compaction use that estimate.
- Ollama accepts base64 image parts only (no remote URLs), and its OpenAI
  compatibility layer accepts `jpeg`, `png` and `webp`.
- llama.cpp needs a multimodal projector (`--mmproj`) to process images.
- Session files store only `[image: filename]` markers. Resuming a session does
  not re-send old images.
- A 50 MiB image is rejected before upload/reading with a clear size error.
  Resize or crop it first, or explicitly raise `images.maxBytes`.

## 6. Use the web interface

basicagent also ships a browser interface for the same agent (the setup in
section 1 can start it for you):

```sh
node bin/basicagent-web.mjs     # or: npm run web
```

It listens on `127.0.0.1:8787` by default and prints a URL that includes an
access token in the fragment; it also opens that URL in your default browser
automatically (pass `--no-open` to skip that, e.g. in scripts or over SSH).
The token is required for every API request, and the unlock screen accepts it
too. The interface has three tabs:

- **Chat** — sessions in a collapsible sidebar, streamed answers, every tool
  call with its arguments and result, and approve/deny buttons when a guarded
  action asks. Stop cancels the running turn and closing the tab aborts it.
  It uses the same sessions as the CLI, so you can switch between the two. A
  context gauge in the composer shows the whole-prompt token budget
  (`agent.contextTokens`): system prompt, tools, summary and messages. It is not
  the model's context window and unrelated to `provider.maxTokens`. Compaction
  points appear in the transcript, with the summary available to inspect. The
  composer also has a per-conversation **Read-only** toggle: file writes and
  non-allowlisted shell commands are disabled, while read, web, skill and
  memory tools remain available. Use **Attach image**, drag an image onto the
  composer or paste one from the clipboard; thumbnails appear above the
  message box and can be removed before sending. Only PNG, JPEG and WebP are
  accepted.
- **Settings** — edits the same `~/.config/basicagent/config.json` (provider,
  images, agent limits, file roots, shell, web tool, skills, memory). The **Advanced**
  card contains the read-only default, the shell allowlist for read-only mode,
  and the tool-call breaker threshold. The read-only checkbox sets the default
  for new conversations; a live conversation keeps its composer toggle. Saving
  validates the values, writes the file and live-reloads the running agent.
  The API key is masked and never sent to the browser; leave the field empty to
  keep it.
- **Memory** — the facts from `facts.jsonl` (view, add, delete), session
  transcripts and the audit log with filters and manual age-based pruning
  (delete entries older than 1–9 weeks).

Options: `--port <number>` (default 8787), `--host <address>` (default
`127.0.0.1`), `--token <string>` (default: random, printed at startup) and
`--no-open` (do not launch the browser).
The server binds to loopback unless you pass a non-loopback `--host`. Every
`/api` request needs the bearer token, and Host/Origin checks reject
DNS-rebinding attempts from other local pages. There are no cookies (the
token lives in the URL fragment and `sessionStorage`), and everything the
agent renders is inserted as text, never HTML.

## 7. One-shot and scripting

```sh
# Answer on stdout, tool trace on stderr:
basicagent "create notes/todo.md with three bullet points about this project"

# Pipeline input:
echo "what files changed today?" | basicagent

# Machine-readable events for scripts:
basicagent --json "read README.md and return its first heading" | jq -c '.type'

# Image + prompt (the model must support vision):
basicagent --image screenshot.png "What error is shown here?"

Or if you only want to extract the final answer:

basicagent --json "read README.md and return its first heading" | jq -r 'select(.type=="done").text'

# Read-only tools: no file writes; only allowlisted shell commands:
basicagent --read-only "summarize the logs with journalctl"

# The same but using "2>/dev/null" to suppress the tool-calling data output and only get the answer stream:
# ( using 2>/dev/null gives the answer without tool lines — but also hides warnings and errors notices.)
basicagent --read-only "check if fstrim ran recently, what the ouput was and how fstrim is configured" 2>/dev/null

```

`--json` emits one JSON object per line: `iteration`, `context`,
`assistant_delta`, `tool_start`, `tool_end`, `compaction`, `done`, `error`,
`approval`. The final answer is the `done` event. `iteration` and `context`
carry `contextTokens`; `compaction` carries `messagesSummarized`,
`tokensBefore`, `tokensAfter`, `summaryTokens` and the summary text. Exit code
is 0 on success and 1 on failure. The web interface streams the same events
plus `approval_result` and `aborted`; there the `approval` event carries an
`id` that is answered with `POST /api/approvals/:id`.

One-shot mode never waits for approval. Actions that need approval are denied
unless you pass `--yes` (only do that in trusted, non-interactive contexts).
Read-only mode does not bypass approval: a whitelisted shell command still
follows `tools.shell.approval`, so scripted use needs `approval: "never"` or
`--yes`.

## 8. Skills

Skills are folders with a `SKILL.md` (frontmatter + markdown instructions).
basicagent injects only their name and description into the prompt and loads
the full text when the model calls `load_skill`.

The default skills paths are:

```
./skills                             project skills (relative to your working directory)
~/.config/basicagent/skills          your personal skills
~/.agents/skills, ~/.claude/skills   where many agents install skills
```

In addition, the project's own `skills/` directory is always scanned (resolved
from the install location, not from your working directory), and it is scanned
after the paths above, so a skill with the same name in your paths wins. It
ships two skills:

- `basicagent` — the agent's self-help: its own configuration, memory,
  guardrails and how to extend it. Ask things like "where is your config
  stored?" or "how do I add a tool?".
- `example` — a template showing the `SKILL.md` format.

If for example the Omarchy skill lives in `~/.agents/skills` on your machine, it is
discovered automatically (symlinked directories are followed). To add your
own:

```sh
mkdir -p ~/.config/basicagent/skills/deploy
cat > ~/.config/basicagent/skills/deploy/SKILL.md <<'EOF'
---
name: deploy
description: Use when the user asks to deploy this project or roll back a release.
---

# Deploying

1. Run the tests first with run_command.
2. ...
EOF
```

Then `/reload` in the REPL (or just start a new run). See
`skills/example/SKILL.md` for a fuller template.

## 9. Guardrails

```json
"tools": {
  "readOnly": false,
  "files": {
    "roots": [
      { "path": ".",        "access": "rw" },
      { "path": "~/Projects", "access": "rw" },
      { "path": "~/.config",  "access": "approval" }
    ],
    "protectedPaths": ["~/.ssh"]
  },
  "shell": {
    "enabled": false,
    "approval": "always",
    "readOnlyAllowlist": [
      "journalctl",
      "systemctl status",
      "systemctl show",
      "systemctl list-units",
      "systemctl list-unit-files",
      "systemctl is-active",
      "systemctl is-enabled",
      "date"
    ]
  },
  "web": {
    "enabled": true,
    "approval": "never",
    "denyDomains": [],
    "allowDomains": [],
    "allowPrivate": false
  }
}
```

- `rw` free access, `ro` read only, `approval` writes ask first, `deny` blocked.
  Paths outside all roots are always refused. When roots overlap, the most
  specific (longest) matching root decides, so a broad `rw` root cannot
  silently shadow a narrower `deny` or `approval` root.

  The first entry in "roots" ("path": ".") is the directory from which BasicAgent is started. This means that by default BasicAgent will have READ/WRITE rights in that directory.
- `protectedPaths` force a prompt even inside an `rw` root. The active
  basicagent config file and the memory data directory (`memory.dir`, holding
  facts, sessions and the audit log) are protected automatically, so the agent
  can change its own record only with your consent.
- `shell` is off by default. When enabled, every command is shown and needs a
  `y` in the REPL. Approving a command is full trust: a command can write
  anywhere, so allow it only if you accept that.
- Read-only mode (`tools.readOnly`, default false) hides the file-writing tools
  (`write_file`, `edit_file`, `append_file`, `rename_file`) and refuses them if
  the model tries anyway. `read_file`, `list_dir`, `load_skill`, `fetch_url`
  and the memory tools remain available. In read-only mode `run_command` is
  limited to `tools.shell.readOnlyAllowlist`; an empty list means no shell
  commands at all.
  Entries are a command plus an optional required argv prefix, so
  `"systemctl status"` allows `systemctl status nginx` but not
  `systemctl restart nginx`. This is a user-controlled guardrail, not a sandbox:
  allowed commands can still use flags that write (for example
  `journalctl --vacuum-size` or `date -s` if the process has permission).
- The tool-call loop breaker stops a turn after
  `agent.toolCircuitBreaker.failureThreshold` identical failures (default 3).
- `fetch_url` (web) is read-only and on by default. It refuses private and
  reserved network addresses (before and after redirects, including
  non-canonical IPv6, NAT64, 6to4 and Teredo forms) and the connection is
  pinned to the validated addresses so DNS cannot be rebound. It never runs
  JavaScript or sends cookies. Restrict it with `denyDomains` /
  `allowDomains`, or turn it off entirely with `"enabled": false` or the
  `--no-web` flag for one run. Set `"approval": "always"` to confirm each
  fetch. `allowPrivate` is a testing escape hatch — leave it false.
- Every tool call is appended to `~/.local/share/basicagent/audit.jsonl`,
  including approval requests and their answers.

## 10. Memory

basicagent saves long-term facts (via the `remember` tool) and user/assistant
text per conversation session under `$XDG_DATA_HOME/basicagent` (falling back
to `~/.local/share/basicagent`), created with mode 0700. The files are plain
JSON:

| File | Contents |
| --- | --- |
| `facts.jsonl` | long-term facts, injected into the system prompt of every run |
| `sessions/<id>.jsonl` | user/assistant text of one conversation |
| `last-session.txt` | session pointer used by `--continue` |
| `audit.jsonl` | one line per tool call: tool, args, ok/error, duration, approvals |

The directory can be set per agent, in the usual precedence order: `--data-dir`
flag, then `BASICAGENT_DATA_DIR`, then `memory.dir` in the config file, then
the XDG-aware default above:

```sh
basicagent --data-dir ~/agents/scout/data "what do you remember?"
BASICAGENT_DATA_DIR=~/agents/scout/data basicagent "..."   # same, via env
```

```sh
basicagent --continue "what did we work on last time?"   # resume last session
basicagent --session project-x                            # named session
basicagent --ephemeral "just answer, store nothing"       # in-memory only
```

Ask the agent to "remember that I prefer tabs" and it stores a fact; ask it to
"forget my tab preference" and it removes matching records. Resuming replays
only user/assistant text, not tool traffic. Everything is plain JSONL — grep
or delete files directly if you prefer.

The web interface's **Memory → Audit log** tab can delete entries older than
1–9 weeks. Pruning applies to the whole `audit.jsonl`, not just the 200 rows
currently shown; malformed or undated lines are kept. It is a human web action,
not an agent tool, so the prune itself is not written as a tool call. The
endpoint refuses to run while a turn is active.

Facts are also a lightweight way to rename the agent or teach it your name:
save `agent_name` / `user_name` (for example in the web interface's Memory
tab) and they appear in the system prompt of every run — see
`persona-example.md`.

## 11. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Could not reach provider ... ECONNREFUSED` | Server not running or wrong `baseUrl`. Start Ollama or fix the URL. |
| `Provider HTTP 401` | Wrong or missing API key. Check `apiKeyEnv` and the variable. |
| Model answers but never uses tools | Some models are weak at tool calling. Try a stronger model; for OpenAI/DeepSeek set `"toolChoice": "required"` to force a call; Ollama ignores `tool_choice`. |
| `Tool arguments are not valid JSON` | Local model quirk. The error is returned to the model so it can retry; a stronger model usually fixes it. |
| llama.cpp never calls tools | Start it with `--jinja`. |
| `The run_command tool is disabled` | Set `tools.shell.enabled` to `true`. |
| `Tool "..." is not available in read-only mode` | Read-only mode is active. Turn it off in the chat composer, with `/readonly off`, or with `--no-read-only`. |
| `Command "..." is not in tools.shell.readOnlyAllowlist` | Add the command (or an argv prefix such as `systemctl status`) under Settings → Advanced, or turn read-only mode off. |
| Approval denied in a script | One-shot denies approvals. Use `--yes`, or run the REPL. |
| `Path is outside the configured file roots` | Add the directory to `tools.files.roots`, or run with `--cwd` inside an allowed root. |
| Agent says it has no web tool | `fetch_url` was removed via `tools.web.enabled: false` or `--no-web`. |
| `Blocked private or reserved address` / `Domain is in the deny list` | The web guardrails refused the URL. Adjust `allowDomains` / `denyDomains` deliberately, or use `allowPrivate` only for local testing. |
| Fetched page looks empty or garbled | The page likely renders with JavaScript (unsupported) or served an unusual encoding. Try the raw API/URL instead. |
| `Unsupported content type` when fetching | Only html, xhtml, xml, plain, markdown and JSON are accepted. |
| Timeouts on slow models | Raise `provider.timeoutMs`. |
| Answers or tool calls are truncated | The provider's default output cap is low (DeepSeek defaults to 4096). Set `provider.maxTokens` to the provider's maximum (DeepSeek 8192). |
| `Provider HTTP 400` mentioning `max_tokens` | `provider.maxTokens` is above what the model allows. Lower it, or remove the setting to use the provider default. |
| `Provider HTTP 400` after attaching an image | The model or server probably does not support vision. Use a multimodal model (for llama.cpp, start with `--mmproj`), or remove the image. |
| `Cannot prune the audit log while a turn is running` | Wait for the running conversation to finish, or press Stop, then try again. |
| `Image "…" is …; the limit is …` | The image exceeds `images.maxBytes` (5 MiB by default). Resize/crop it, or raise the limit deliberately. |
| `Image "…" is not a supported image` | Only PNG, JPEG and WebP are accepted. GIF, BMP, TIFF, HEIC, AVIF and SVG are not. |
| `Too many images` | The limit is `images.maxImages` (4 by default) per message. |
| Context fills quickly with images | The estimate is `images.tokensPerImage` (1,200 by default). Raise it if your model's vision encoder uses more, or attach fewer images. |

## 12. Tests

```sh
npm test          # offline suite, no network
npm run test:live # opt-in: needs OLLAMA_API_KEY_CLOUD (uses gemma4:31b)
```
