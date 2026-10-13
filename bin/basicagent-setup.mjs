#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// basicagent onboarding.
//
// Usage:
//   basicagent-setup
//
// Asks for the provider, model and directories, optionally tests the
// connection, writes the config file and offers to start the web interface
// (which opens the browser). Every question shows a [default] taken from an
// existing config file or from config.example.json; Enter accepts it.
//
// The questionnaire is deliberately a plain readline script with no
// dependency, and it touches neither the agent loop nor the web server: the
// "start now" answer simply spawns bin/basicagent-web.mjs.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { DEFAULTS, defaultConfigPath, defaultDataDir } from '../src/config.mjs';
import { validateRawConfig, writeConfigFile } from '../src/config-file.mjs';
import {
  PROVIDER_PRESETS,
  applyAnswers,
  getByPath,
  loadBaseConfig,
  matchingPreset,
  summaryLines,
  testProvider
} from '../src/setup.mjs';
import { resolveUserPath } from '../src/util.mjs';

const VERSION = pkg.version;
const WEB_BIN = fileURLToPath(new URL('./basicagent-web.mjs', import.meta.url));

const HELP = `basicagent setup ${VERSION} - guided configuration for basicagent

Usage:
  basicagent-setup [options]

Options:
  --config <file>  Config file to create or edit
                   (default: ~/.config/basicagent/config.json)
  --no-test        Skip the provider connection test
  --no-start       Do not offer to start the web interface
  -h, --help       Show this help
  -v, --version    Show the version

Every question shows a [default]; press Enter to accept it. The defaults come
from config.example.json, or from your existing config file when it exists.
`;

function parseFlags(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      config: { type: 'string' },
      'no-test': { type: 'boolean' },
      'no-start': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }
    }
  });
}

class InputEndedError extends Error {
  constructor() {
    super('input ended');
    this.name = 'InputEndedError';
  }
}

// The prompter buffers complete lines and hands them out one question at a
// time. A plain rl.question() would drop lines that arrive while no question
// is pending, which breaks piped input (and the tests).
function createPrompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const lines = [];
  const waiters = [];
  let ended = false;

  rl.on('line', (line) => {
    if (waiters.length) waiters.shift().resolve(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    ended = true;
    while (waiters.length) waiters.shift().reject(new InputEndedError());
  });
  rl.on('SIGINT', () => {
    process.stdout.write('\nSetup cancelled; nothing written.\n');
    process.exit(130);
  });

  function nextLine() {
    if (lines.length) return Promise.resolve(lines.shift());
    if (ended) return Promise.reject(new InputEndedError());
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  return {
    rl,
    async ask(text) {
      process.stdout.write(text);
      return (await nextLine()).trim();
    },
    // Read a secret without echoing it. Pipes never echo anyway; on a TTY the
    // readline echo is replaced by stars. An empty default (the whole line)
    // is returned as is.
    async secret(text) {
      process.stdout.write(text);
      if (!process.stdin.isTTY) return (await nextLine()).trim();
      const original = rl._writeToOutput;
      rl._writeToOutput = function (string) {
        if (string === '\r\n' || string === '\n' || string === '\r') return;
        if (string.includes('\b') || string.includes('\x7f')) return this.output.write('\b \b');
        this.output.write('*');
      };
      try {
        return (await nextLine()).trim();
      } finally {
        rl._writeToOutput = original;
        process.stdout.write('\n');
      }
    },
    close() {
      rl.close();
    }
  };
}

// Prompt helpers --------------------------------------------------------------

function withDefault(value) {
  return value === undefined || value === null || value === '' ? '' : ` [${value}]`;
}

async function askValue(p, label, fallback) {
  const answer = await p.ask(`${label}${withDefault(fallback)}: `);
  return answer === '' ? fallback : answer;
}

async function askYesNo(p, label, defaultValue) {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]';
  for (;;) {
    const answer = (await p.ask(`${label} ${suffix}: `)).toLowerCase();
    if (!answer) return defaultValue;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    process.stdout.write('Please answer y or n.\n');
  }
}

async function askInteger(p, label, fallback) {
  for (;;) {
    const answer = await askValue(p, label, fallback);
    const value = Number(answer);
    if (Number.isInteger(value) && value > 0) return value;
    process.stdout.write('Please enter a positive whole number.\n');
  }
}

// Provider questions ----------------------------------------------------------

function providerMenu() {
  const lines = ['Provider:'];
  for (const [index, preset] of PROVIDER_PRESETS.entries()) {
    const suffix = preset.custom ? '' : `  ${preset.baseUrl}`;
    lines.push(`  ${index + 1}) ${preset.label.padEnd(26)}${suffix}`);
  }
  return lines.join('\n');
}

async function choosePreset(p, defaultIndex) {
  process.stdout.write(providerMenu() + '\n');
  for (;;) {
    const answer = await p.ask(`Choose [${defaultIndex + 1}]: `);
    if (!answer) return defaultIndex;
    const value = Number(answer);
    if (Number.isInteger(value) && value >= 1 && value <= PROVIDER_PRESETS.length) return value - 1;
    process.stdout.write(`Please enter a number between 1 and ${PROVIDER_PRESETS.length}.\n`);
  }
}

// Returns the provider answers; defaults come from `raw` so a retry after a
// failed connection test keeps the earlier answers.
async function askProvider(p, raw) {
  const provider = raw.provider || {};
  let current = {
    baseUrl: provider.baseUrl ?? DEFAULTS.provider.baseUrl,
    model: provider.model ?? DEFAULTS.provider.model,
    apiKeyEnv: provider.apiKeyEnv ?? DEFAULTS.provider.apiKeyEnv,
    apiKey: provider.apiKey
  };

  const choice = await choosePreset(p, matchingPreset(current.baseUrl));
  const preset = PROVIDER_PRESETS[choice];
  if (!preset.custom) {
    current = {
      ...current,
      baseUrl: preset.baseUrl,
      model: preset.model,
      apiKeyEnv: preset.apiKeyEnv || current.apiKeyEnv
    };
  }

  const answers = {
    baseUrl: await askValue(p, 'Provider base URL', current.baseUrl),
    model: await askValue(p, 'Model', current.model)
  };

  if (preset.needsKey) {
    let apiKeyEnv = await askValue(p, 'API key env var', current.apiKeyEnv);
    if (apiKeyEnv === '-') apiKeyEnv = '';
    answers.apiKeyEnv = apiKeyEnv;
    const label = current.apiKey
      ? 'API key to store in the config file (Enter keeps the stored key, "-" removes it): '
      : 'API key to store in the config file (Enter uses the env var; safer to keep it out of files): ';
    const typed = await p.secret(label);
    if (typed === '-') answers.apiKey = null;
    else if (typed !== '') answers.apiKey = typed;
  }
  return answers;
}

async function runProviderTest(p, raw, context) {
  process.stdout.write('Testing the provider connection...\n');
  const result = await testProvider(raw, context);
  if (result.ok) {
    process.stdout.write(`ok: ${raw.provider.model} replied "${result.message}" in ${result.durationMs} ms\n`);
    return true;
  }
  process.stdout.write(`failed: ${result.message} (after ${result.durationMs} ms)\n`);
  return false;
}

// Web server ------------------------------------------------------------------

function spawnWeb(configPath, defaultPath) {
  return new Promise((resolve) => {
    const args = [WEB_BIN];
    if (configPath !== defaultPath) args.push('--config', configPath);
    const ignore = () => {};
    process.on('SIGINT', ignore);
    const done = (code) => {
      process.removeListener('SIGINT', ignore);
      resolve(code ?? 0);
    };
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('error', (error) => {
      process.stderr.write(`Could not start the web interface: ${error.message}\n`);
      done(1);
    });
    child.on('exit', (code) => done(code));
  });
}

function printStartHint(configPath, defaultPath) {
  const suffix = configPath === defaultPath ? '' : ` --config ${configPath}`;
  process.stdout.write(`\nStart the interface any time with:\n  basicagent-web${suffix}\n`);
}

// Main ------------------------------------------------------------------------

async function main() {
  let parsed;
  try {
    parsed = parseFlags(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${HELP}`);
    process.exit(2);
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const cwd = process.cwd();
  const defaultPath = defaultConfigPath();
  const configPath = values.config ? resolveUserPath(values.config, cwd) : defaultPath;
  const base = loadBaseConfig(configPath);
  const p = createPrompter();

  process.stdout.write(`basicagent setup ${VERSION}\n\n`);
  process.stdout.write('This writes the basicagent configuration file. Press Enter to accept the\n');
  process.stdout.write('[default] shown for each question.\n\n');
  if (base.found) process.stdout.write(`Found an existing config at ${base.source}; its values are the defaults.\n\n`);
  else process.stdout.write(`No config found; the defaults come from ${base.source}.\n\n`);

  // Provider block (repeated when a connection test fails and the user asks
  // to edit the settings).
  const answers = await askProvider(p, base.raw);
  answers.maxTokens = await askInteger(p, 'Max tokens', getByPath(base.raw, 'provider.maxTokens') ?? DEFAULTS.provider.maxTokens);
  answers.shellEnabled = await askYesNo(
    p,
    'Enable the shell tool (run_command; every command still needs approval)',
    Boolean(getByPath(base.raw, 'tools.shell.enabled'))
  );
  const targetPath = resolveUserPath(await askValue(p, 'Config file', configPath), cwd);
  answers.dataDir = await askValue(
    p,
    'Data directory (facts, sessions, audit)',
    getByPath(base.raw, 'memory.dir') ?? defaultDataDir()
  );
  answers.memoryEnabled = await askYesNo(p, 'Enable memory', getByPath(base.raw, 'memory.enabled') ?? true);

  let raw = applyAnswers(base.raw, answers);

  if (!values['no-test'] && await askYesNo(p, 'Test the provider connection now', true)) {
    while (!(await runProviderTest(p, raw, { cwd, configPath: targetPath }))) {
      if (!(await askYesNo(p, 'Edit the provider settings and try again', true))) break;
      Object.assign(answers, await askProvider(p, raw));
      raw = applyAnswers(base.raw, answers);
    }
  }

  process.stdout.write('\nAbout to write:\n\n');
  for (const [label, value] of summaryLines(raw, { configPath: targetPath })) {
    process.stdout.write(`  ${label.padEnd(12)}  ${value}\n`);
  }
  process.stdout.write('\n');
  if (existsSync(targetPath)) process.stdout.write('The config file already exists; its other settings are preserved.\n');

  if (!await askYesNo(p, 'Write this configuration', true)) {
    p.close();
    process.stdout.write('Nothing written.\n');
    return;
  }

  try {
    validateRawConfig(raw, { cwd, configPath: targetPath });
    writeConfigFile(targetPath, raw);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 2;
    p.close();
    return;
  }
  process.stdout.write(`Wrote ${targetPath} (mode 0600).\n`);

  if (values['no-start']) {
    p.close();
    printStartHint(targetPath, defaultPath);
    return;
  }

  const start = await askYesNo(p, 'Start the web interface now', true);
  p.close();
  if (!start) {
    printStartHint(targetPath, defaultPath);
    return;
  }
  process.stdout.write('\nStarting the web interface; Ctrl+C stops it. The browser opens automatically.\n\n');
  process.exitCode = await spawnWeb(targetPath, defaultPath);
}

main().catch((error) => {
  if (error instanceof InputEndedError) {
    process.stdout.write('\nInput ended; nothing written.\n');
    process.exit(1);
  }
  process.stderr.write(`fatal: ${error?.stack || error}\n`);
  process.exit(1);
});
