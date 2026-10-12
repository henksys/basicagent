# basicagent tutorial

A five minute setup guide, then the features you will actually use.

## Requirements

- **Node.js 24 or newer** (`node --version`). Nothing else: no npm install, no
  dependencies, no build step.

## 1. Run it

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
`http://localhost:11434/v1`. Pick a provider recipe below.

## 2. Pick a provider

Create the config directory and copy the example:

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

## 3. Use the REPL

```sh
basicagent
```

```
basicagent 1.2.1
model     gemma4:31b @ https://ollama.com/v1
cwd       /home/you/Projects/basicagent
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
| `/tools` | List registered tools |
| `/model [name]` | Show or change the model for this session |
| `/config` | Show the resolved config with the API key masked |
| `/quit` | Exit (Ctrl+D works too) |

Ctrl+C cancels the running turn, not the program.

## 4. One-shot and scripting

```sh
# Answer on stdout, tool trace on stderr:
basicagent "create notes/todo.md with three bullet points about this project"

# Pipeline input:
echo "what files changed today?" | basicagent

# Machine-readable events for scripts:
basicagent --json "read README.md and return its first heading" | jq -c '.type'
```

`--json` emits one JSON object per line: `assistant_delta`, `tool_start`,
`tool_end`, `done`, `error`, `approval`. The final answer is the `done` event.
Exit code is 0 on success and 1 on failure.

One-shot mode never waits for approval. Actions that need approval are denied
unless you pass `--yes` (only do that in trusted, non-interactive contexts).

## 5. Skills

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

## 6. Guardrails

```json
"tools": {
  "files": {
    "roots": [
      { "path": ".",        "access": "rw" },
      { "path": "~/Projects", "access": "rw" },
      { "path": "~/.config",  "access": "approval" }
    ],
    "protectedPaths": ["~/.ssh"]
  },
  "shell": { "enabled": false, "approval": "always" },
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
- `protectedPaths` force a prompt even inside an `rw` root. The active
  basicagent config file and the memory data directory (`memory.dir`, holding
  facts, sessions and the audit log) are protected automatically, so the agent
  can change its own record only with your consent.
- `shell` is off by default. When enabled, every command is shown and needs a
  `y` in the REPL. Approving a command is full trust: a command can write
  anywhere, so allow it only if you accept that.
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

## 7. Memory

basicagent saves long-term facts (via the `remember` tool) and user/assistant
text per conversation session under `~/.local/share/basicagent` — configurable
with `memory.dir`, created with mode 0700. The files are plain JSON:

| File | Contents |
| --- | --- |
| `facts.jsonl` | long-term facts, injected into the system prompt of every run |
| `sessions/<id>.jsonl` | user/assistant text of one conversation |
| `last-session.txt` | session pointer used by `--continue` |
| `audit.jsonl` | one line per tool call: tool, args, ok/error, duration, approvals |

```sh
basicagent --continue "what did we work on last time?"   # resume last session
basicagent --session project-x                            # named session
basicagent --ephemeral "just answer, store nothing"       # in-memory only
```

Ask the agent to "remember that I prefer tabs" and it stores a fact; ask it to
"forget my tab preference" and it removes matching records. Resuming replays
only user/assistant text, not tool traffic. Everything is plain JSONL — grep
or delete files directly if you prefer.

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Could not reach provider ... ECONNREFUSED` | Server not running or wrong `baseUrl`. Start Ollama or fix the URL. |
| `Provider HTTP 401` | Wrong or missing API key. Check `apiKeyEnv` and the variable. |
| Model answers but never uses tools | Some models are weak at tool calling. Try a stronger model; for OpenAI/DeepSeek set `"toolChoice": "required"` to force a call; Ollama ignores `tool_choice`. |
| `Tool arguments are not valid JSON` | Local model quirk. The error is returned to the model so it can retry; a stronger model usually fixes it. |
| llama.cpp never calls tools | Start it with `--jinja`. |
| `The run_command tool is disabled` | Set `tools.shell.enabled` to `true`. |
| Approval denied in a script | One-shot denies approvals. Use `--yes`, or run the REPL. |
| `Path is outside the configured file roots` | Add the directory to `tools.files.roots`, or run with `--cwd` inside an allowed root. |
| Agent says it has no web tool | `fetch_url` was removed via `tools.web.enabled: false` or `--no-web`. |
| `Blocked private or reserved address` / `Domain is in the deny list` | The web guardrails refused the URL. Adjust `allowDomains` / `denyDomains` deliberately, or use `allowPrivate` only for local testing. |
| Fetched page looks empty or garbled | The page likely renders with JavaScript (unsupported) or served an unusual encoding. Try the raw API/URL instead. |
| `Unsupported content type` when fetching | Only html, xhtml, xml, plain, markdown and JSON are accepted. |
| Timeouts on slow models | Raise `provider.timeoutMs`. |

## 9. Tests

```sh
npm test          # offline suite, no network
npm run test:live # opt-in: needs OLLAMA_API_KEY_CLOUD (uses gemma4:31b)
```
