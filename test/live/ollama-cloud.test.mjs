// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// Live integration test against Ollama Cloud's OpenAI-compatible endpoint.
//
// Skipped automatically unless OLLAMA_API_KEY_CLOUD is set. It makes a small
// number of billed calls, so keep it focused:
//
//   npm run test:live
//
// Model and endpoint can be overridden with LIVE_MODEL / LIVE_BASE_URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Provider } from '../../src/provider.mjs';
import { Agent } from '../../src/agent.mjs';
import { createRegistry } from '../../src/tools/index.mjs';
import { loadConfig } from '../../src/config.mjs';

const apiKey = process.env.OLLAMA_API_KEY_CLOUD || '';
const enabled = Boolean(apiKey);

test('live: gemma4:31b uses write_file and read_file end to end', { skip: !enabled && 'OLLAMA_API_KEY_CLOUD is not set', timeout: 240000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'basicagent-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const baseUrl = process.env.LIVE_BASE_URL || 'https://ollama.com/v1';
  const model = process.env.LIVE_MODEL || 'gemma4:31b';
  const config = loadConfig({
    flags: {},
    env: { BASICAGENT_BASE_URL: baseUrl, BASICAGENT_MODEL: model, BASICAGENT_API_KEY: apiKey },
    cwd: dir
  });
  config.tools.files.roots = [{ path: dir, access: 'rw' }];

  const provider = new Provider(config);
  const registry = createRegistry({ config, memory: null, skills: new Map(), cwd: dir });
  const agent = new Agent({
    provider,
    registry,
    config,
    emit: (event) => {
      if (event.type === 'tool_start') t.diagnostic(`tool: ${event.name} ${JSON.stringify(event.args).slice(0, 120)}`);
      if (event.type === 'error') t.diagnostic(`error: ${event.message}`);
    },
    approve: async () => false
  });
  agent.setSystem('You are basicagent. Use the provided tools. Be concise.');

  await agent.run(`Use the write_file tool to create a file named hello.txt in the working directory. The content must be exactly: hello from basicagent. Then reply with one short sentence.`);
  assert.equal(readFileSync(join(dir, 'hello.txt'), 'utf8'), 'hello from basicagent');

  const second = await agent.run('Use read_file to read hello.txt and tell me its exact content.');
  assert.match(second.text, /hello from basicagent/);
});
