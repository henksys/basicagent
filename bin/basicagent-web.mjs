#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// basicagent web server.
//
// Usage:
//   basicagent-web                 serve the UI on 127.0.0.1:8787
//   basicagent-web --port 9000     pick another port
//   basicagent-web --token secret  use a fixed token instead of a random one
//
// The server binds to loopback only unless --host is given explicitly. Every
// /api request needs the bearer token, which is printed (and embedded in the
// URL fragment) at startup.

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { loadConfig } from '../src/config.mjs';
import { openBrowser } from '../src/web/open-browser.mjs';
import { startWebServer } from '../src/web/server.mjs';

const VERSION = pkg.version;

const HELP = `basicagent web ${VERSION} - browser interface for basicagent

Usage:
  basicagent-web [options]

Options:
  --port <number>    Port to listen on (default: 8787)
  --host <address>   Address to bind (default: 127.0.0.1; anything else is
                     exposed to the network and requires the token)
  --token <string>   Fixed access token (default: random, printed at startup)
  --config <file>    Config file (default: ~/.config/basicagent/config.json)
  --cwd <dir>        Working directory for the agent (default: current dir)
  --data-dir <dir>   Data directory for facts/sessions/audit
  --model <name>     Override the configured model
  --base-url <url>   Override the provider base URL
  --api-key <key>    Override the API key (prefer BASICAGENT_API_KEY)
  --no-web           Disable the fetch_url web tool
  --no-open          Do not open the interface in the default browser
  -h, --help         Show this help
  -v, --version      Show the version

Settings come from, in order: built-in defaults, the config file,
BASICAGENT_API_KEY/BASICAGENT_BASE_URL/BASICAGENT_MODEL/BASICAGENT_DATA_DIR,
then CLI flags. The Settings tab reads and writes the same config file.
`;

function parseFlags(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      token: { type: 'string' },
      config: { type: 'string' },
      cwd: { type: 'string' },
      'data-dir': { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      'no-web': { type: 'boolean' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }
    }
  });
}

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

  const port = values.port === undefined ? 8787 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('error: --port must be an integer between 0 and 65535\n');
    process.exit(2);
  }
  const host = values.host || '127.0.0.1';
  const token = values.token || randomBytes(24).toString('base64url');
  const cwd = values.cwd ? resolve(values.cwd) : process.cwd();

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

  let started;
  try {
    started = await startWebServer({ config, flags, cwd, version: VERSION, token, host, port });
  } catch (error) {
    process.stderr.write(`error: could not listen on ${host}:${port}: ${error.message}\n`);
    process.exit(2);
  }

  const url = started.url;
  const tokenUrl = `${url}#token=${encodeURIComponent(token)}`;
  process.stdout.write(
    `basicagent web ${VERSION}\n` +
    `model      ${config.provider.model} @ ${config.provider.baseUrl}\n` +
    `cwd        ${cwd}\n` +
    (config.memory.enabled ? `data       ${config.memory.dir}\n` : 'memory     disabled\n') +
    `listening  ${url}\n` +
    `token      ${token}\n\n` +
    `Open ${tokenUrl}\n` +
    (values['no-open'] ? '' : 'Opening it in your default browser (use --no-open to skip).\n') +
    `\nPress Ctrl+C to stop.\n`
  );
  if (!values['no-open']) openBrowser(tokenUrl);
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    process.stdout.write('Warning: the server is reachable from the network; keep the token secret.\n');
  }

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    process.stdout.write('\nStopping basicagent web...\n');
    started.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error?.stack || error}\n`);
  process.exit(1);
});
