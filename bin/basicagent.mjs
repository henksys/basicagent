#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// basicagent CLI.
//
// Usage:
//   basicagent                     interactive REPL
//   basicagent "do something"      one-shot: run one prompt and exit
//   basicagent --json "..."        one-shot with JSON-lines events on stdout
//   echo "prompt" | basicagent     read the prompt from stdin
//
// The REPL supports: /help /new /reload /skills /tools /model /config /quit
//
// One-shot mode denies approval-required actions unless --yes is given, so
// scripts never hang on a prompt. The REPL asks interactively; --yes there
// auto-approves everything as well.

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { loadConfig } from '../src/config.mjs';
import { Provider } from '../src/provider.mjs';
import { Agent } from '../src/agent.mjs';
import { createRegistry } from '../src/tools/index.mjs';
import { Memory } from '../src/memory.mjs';
import { discoverSkills } from '../src/skills.mjs';
import { buildSystemPrompt } from '../src/prompt.mjs';
import { createUI, promptLabel } from '../src/ui.mjs';
import { createApproval } from '../src/approval.mjs';
import { mask } from '../src/util.mjs';

const VERSION = pkg.version;

const HELP = `basicagent ${VERSION} - a small CLI agent with file tools, skills and OpenAI-compatible models

Usage:
  basicagent [options] [prompt]
  echo "prompt" | basicagent [options]

Options:
  --config <file>    Config file (default: ~/.config/basicagent/config.json)
  --cwd <dir>        Working directory for this run (default: current directory)
  --data-dir <dir>   Data directory for facts/sessions/audit
                     (default: $XDG_DATA_HOME/basicagent or ~/.local/share/basicagent)
  --model <name>     Override the configured model
  --base-url <url>   Override the provider base URL (e.g. http://localhost:11434/v1)
  --api-key <key>    Override the API key (prefer BASICAGENT_API_KEY or apiKeyEnv)
  --continue         Resume the most recent conversation session
  --session <id>     Use (or create) a named conversation session
  --ephemeral        Disable memory for this run
  --no-web           Disable the fetch_url web tool for this run
  --json             One-shot JSON-lines event output (for scripts)
  --yes              Auto-approve guarded actions without asking (dangerous,
                     in both REPL and one-shot mode)
  -h, --help         Show this help
  -v, --version      Show the version

REPL commands:
  /help /new /reload /skills /tools /model [name] /config /quit

Settings come from, in order: built-in defaults, the config file,
BASICAGENT_API_KEY/BASICAGENT_BASE_URL/BASICAGENT_MODEL/BASICAGENT_DATA_DIR,
then CLI flags.
`;

function parseFlags(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      continue: { type: 'boolean' },
      session: { type: 'string' },
      config: { type: 'string' },
      cwd: { type: 'string' },
      'data-dir': { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      yes: { type: 'boolean' },
      ephemeral: { type: 'boolean' },
      'no-web': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }
    }
  });
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

function redactConfig(config) {
  const copy = structuredClone(config);
  copy.provider.apiKey = mask(copy.provider.apiKey);
  return copy;
}

async function main() {
  let parsed;
  try {
    parsed = parseFlags(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${HELP}`);
    process.exit(2);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();
  // parseArgs keeps kebab-case names; config expects camelCase flag names.
  const flags = {
    config: values.config,
    cwd: values.cwd,
    dataDir: values['data-dir'],
    model: values.model,
    baseUrl: values['base-url'],
    apiKey: values['api-key'],
    noWeb: values['no-web']
  };
  let config;
  try {
    config = loadConfig({ flags, cwd });
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(2);
  }

  const ui = createUI({ json: values.json });
  const memory = config.memory.enabled && !values.ephemeral ? new Memory({ dir: config.memory.dir }) : null;

  // Conversation history: new session by default, or resume with --continue.
  let history = [];
  if (memory) {
    if (values.continue) {
      const resumed = memory.continueSession();
      if (!resumed) {
        ui.error('No previous session to continue; run without --continue to start one.');
        process.exit(1);
      }
      history = resumed.messages;
    } else if (values.session) {
      try {
        history = memory.readSession(memory.startSession(values.session));
      } catch (error) {
        ui.error(error.message);
        process.exit(2);
      }
    } else {
      memory.startSession();
    }
  } else if (values.continue || values.session) {
    ui.warn('--continue/--session ignored because memory is disabled or --ephemeral was used.');
  }

  // The prompt may come from arguments or a pipe.
  let promptText = positionals.join(' ').trim();
  if (!promptText && !process.stdin.isTTY) promptText = await readStdin();
  const replMode = !promptText;

  let rl = null;
  const approve = createApproval({
    interactive: replMode && !values.json,
    yes: Boolean(values.yes),
    // The callback-based readline API needs wrapping to be awaitable.
    question: (text) => new Promise((resolve) => rl.question(text, resolve)),
    onEvent: (event) => ui.event(event),
    onNotice: (text) => ui.warn(text)
  });

  function onEvent(event) {
    ui.event(event);
    switch (event.type) {
      case 'assistant_delta':
        ui.delta(event.text);
        break;
      case 'tool_start':
        ui.toolStart(event.name, event.args);
        break;
      case 'tool_end':
        ui.toolEnd(event.name, event.ok, event.durationMs, event.result);
        break;
      case 'warning':
        ui.warn(event.message);
        break;
      default:
        break;
    }
  }

  // Rebuildable runtime state (so /reload can swap everything in place).
  let skills;
  let provider;
  let registry;
  let agent;

  function build() {
    skills = discoverSkills(config.skills.paths);
    provider = new Provider(config);
    registry = createRegistry({ config, memory, skills, cwd, onAuditError: (text) => ui.warn(text) });
    agent = new Agent({ provider, registry, config, emit: onEvent, approve });
    agent.messages = history;
  }

  function refreshSystemPrompt() {
    agent.setSystem(buildSystemPrompt({ config, skills, memory, cwd }));
  }

  async function runTurn(input, signal) {
    refreshSystemPrompt();
    memory?.appendEvent('user', input);
    const result = await agent.run(input, { signal });
    ui.turnEnd();
    memory?.appendEvent('assistant', result.text);
    return result;
  }

  function renderError(error) {
    if (error?.name === 'AbortError') {
      ui.error('Interrupted');
      return;
    }
    const message = error?.message || String(error);
    ui.event({ type: 'error', message });
    ui.error(message);
  }

  build();

  // One-shot mode -----------------------------------------------------------
  if (!replMode) {
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    try {
      await runTurn(promptText, controller.signal);
    } catch (error) {
      renderError(error);
      process.exitCode = 1;
    }
    memory?.close();
    return;
  }

  // Interactive REPL ---------------------------------------------------------
  refreshSystemPrompt();
  const promptOutput = values.json ? process.stderr : process.stdout;
  rl = createInterface({
    input: process.stdin,
    output: promptOutput,
    terminal: true,
    prompt: `${promptLabel('basicagent', { stream: promptOutput })}> `
  });

  ui.banner(`basicagent ${VERSION}`);
  ui.banner(`model     ${provider.model} @ ${config.provider.baseUrl}`);
  ui.banner(`cwd       ${cwd}`);
  ui.banner(`skills    ${skills.size ? [...skills.keys()].join(', ') : '(none)'}`);
  if (memory?.sessionId) ui.banner(`session   ${memory.sessionId}`);
  if (history.length) ui.banner(`resumed   ${history.length} messages from the previous session`);
  ui.banner('Type /help for commands. Ctrl+C cancels a running turn; Ctrl+D exits.');

  let busy = false;
  let controller = null;
  let closed = false;

  async function handleCommand(line) {
    const [name, ...rest] = line.slice(1).split(/\s+/);
    const argument = rest.join(' ').trim();
    switch (name) {
      case 'help':
        ui.banner('Commands: /new /reload /skills /tools /model [name] /config /quit');
        break;
      case 'quit':
      case 'exit':
        closed = true;
        rl.close();
        return;
      case 'new':
        agent.reset();
        memory?.startSession();
        ui.info('Started a new conversation.');
        break;
      case 'reload': {
        const messages = agent.messages;
        try {
          config = loadConfig({ flags, cwd });
        } catch (error) {
          ui.error(`Reload failed: ${error.message}`);
          break;
        }
        build();
        agent.messages = messages;
        refreshSystemPrompt();
        ui.info(`Reloaded: model ${provider.model}, ${skills.size} skills, ${registry.names().length} tools.`);
        break;
      }
      case 'skills':
        if (skills.size === 0) ui.info('No skills found. Add <dir>/SKILL.md and /reload.');
        for (const skill of skills.values()) ui.info(`- ${skill.name}: ${skill.description}`);
        break;
      case 'tools':
        ui.info(registry.names().join(', '));
        break;
      case 'model':
        if (argument) {
          provider.model = argument;
          ui.info(`Model set to ${provider.model} for this session (config unchanged).`);
        } else {
          ui.info(`model: ${provider.model}`);
        }
        break;
      case 'config':
        ui.info(JSON.stringify(redactConfig(config), null, 2));
        break;
      default:
        ui.warn(`Unknown command /${name}. Try /help.`);
        break;
    }
  }

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input.startsWith('/')) {
      Promise.resolve(handleCommand(input))
        .catch((error) => ui.error(error.message))
        .finally(() => {
          if (!closed) rl.prompt();
        });
      return;
    }
    if (busy) {
      ui.warn('Still working; press Ctrl+C to cancel first.');
      rl.prompt();
      return;
    }
    busy = true;
    controller = new AbortController();
    runTurn(input, controller.signal)
      .catch((error) => {
        renderError(error);
        if (error?.name !== 'AbortError') ui.warn('The turn ended with an error; the conversation is still usable.');
      })
      .finally(() => {
        busy = false;
        controller = null;
        rl.prompt();
      });
  });

  rl.on('SIGINT', () => {
    if (busy && controller) {
      ui.warn('Cancelling current turn...');
      controller.abort();
    } else {
      ui.info('(press Ctrl+D or type /quit to exit)');
      rl.prompt();
    }
  });

  rl.on('close', () => {
    closed = true;
    memory?.close();
    process.exit(0);
  });

  rl.prompt();
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error?.stack || error}\n`);
  process.exit(1);
});
