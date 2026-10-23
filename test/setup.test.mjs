// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider, textChunk, finishChunk } from './fixtures/fake-server.mjs';
import { applyAnswers, loadBaseConfig, matchingPreset, migrateContextBudget, summaryLines, testProvider } from '../src/setup.mjs';
import { DEFAULTS } from '../src/config.mjs';

const bin = fileURLToPath(new URL('../bin/basicagent-setup.mjs', import.meta.url));

function runSetup(args, { cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'basicagent-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, configPath: join(dir, 'config.json') };
}

const readConfig = (path) => JSON.parse(readFileSync(path, 'utf8'));

// Unit tests ------------------------------------------------------------------

test('matchingPreset finds presets and falls back to custom', () => {
  assert.equal(matchingPreset('http://localhost:11434/v1'), 0);
  assert.equal(matchingPreset('http://localhost:11434/v1/'), 0, 'trailing slash ignored');
  assert.equal(matchingPreset('https://api.deepseek.com/v1'), 2);
  assert.equal(matchingPreset('http://my-server:1234/v1'), 5);
});

test('applyAnswers preserves the base and removes cleared keys', () => {
  const base = {
    provider: { baseUrl: 'http://old/v1', model: 'old', apiKey: 'secret', apiKeyEnv: 'OLD_KEY', maxTokens: 8192 },
    tools: { files: { roots: [{ path: '/x', access: 'ro' }] }, shell: { enabled: false } },
    memory: { enabled: true, dir: '~/old' },
    custom: { keep: true }
  };
  const raw = applyAnswers(base, {
    baseUrl: 'https://new.example/v1/',
    model: 'new-model',
    apiKey: null,
    apiKeyEnv: 'NEW_KEY',
    shellEnabled: true,
    memoryEnabled: false,
    dataDir: '~/new'
  });
  assert.equal(raw.provider.baseUrl, 'https://new.example/v1', 'trailing slash trimmed');
  assert.equal(raw.provider.model, 'new-model');
  assert.equal(raw.provider.maxTokens, 8192);
  assert.ok(!('apiKey' in raw.provider), 'null removes the stored key');
  assert.equal(raw.provider.apiKeyEnv, 'NEW_KEY');
  assert.deepEqual(raw.tools.files.roots, [{ path: '/x', access: 'ro' }], 'unrelated settings survive');
  assert.equal(raw.tools.shell.enabled, true);
  assert.equal(raw.memory.enabled, false);
  assert.equal(raw.memory.dir, '~/new');
  assert.deepEqual(raw.custom, { keep: true });
  assert.equal(base.provider.model, 'old', 'the base object is not modified');
});

test('applyAnswers keeps keys that are left undefined', () => {
  const base = { provider: { baseUrl: 'http://old/v1', model: 'old', apiKey: 'secret' } };
  const raw = applyAnswers(base, { baseUrl: 'http://new/v1', model: 'new', shellEnabled: false, memoryEnabled: true, dataDir: '~/d' });
  assert.equal(raw.provider.apiKey, 'secret');
  assert.ok(!('maxTokens' in raw.provider), 'setup never adds a maxTokens cap');
});

test('loadBaseConfig prefers an existing config and falls back to the example', async (t) => {
  const { dir, configPath } = workspace(t);
  writeFileSync(configPath, JSON.stringify({ provider: { model: 'mine' } }));
  const found = loadBaseConfig(configPath);
  assert.equal(found.found, true);
  assert.equal(found.raw.provider.model, 'mine');

  const examplePath = join(dir, 'example.json');
  writeFileSync(examplePath, JSON.stringify({ provider: { model: 'from-example' } }));
  const missing = loadBaseConfig(join(dir, 'nope.json'), { examplePath });
  assert.equal(missing.found, false);
  assert.equal(missing.raw.provider.model, 'from-example');

  const broken = loadBaseConfig(join(dir, 'nope.json'), { examplePath: join(dir, 'missing.json') });
  assert.deepEqual(broken.raw, {});
});

test('migrateContextBudget converts the old character budget once', () => {
  const { raw, migration } = migrateContextBudget({
    agent: { contextChars: 100000, maxIterations: 5 },
    custom: { keep: true }
  });
  assert.deepEqual(migration, { from: 100000, to: 25000 });
  assert.equal(raw.agent.contextTokens, 25000);
  assert.ok(!('contextChars' in raw.agent));
  assert.equal(raw.agent.maxIterations, 5);
  assert.deepEqual(raw.custom, { keep: true });
});

test('migrateContextBudget discards an invalid old value', () => {
  const { raw, migration } = migrateContextBudget({ agent: { contextChars: 'lots' } });
  assert.deepEqual(migration, { from: 'lots', to: null });
  assert.ok(!('contextChars' in raw.agent));
  assert.ok(!('contextTokens' in raw.agent), 'the runtime default applies');
});

test('loadBaseConfig migrates an existing config and reports it', (t) => {
  const { configPath } = workspace(t);
  writeFileSync(configPath, JSON.stringify({ agent: { contextChars: 100000 }, provider: { model: 'mine' } }));
  const found = loadBaseConfig(configPath);
  assert.equal(found.raw.agent.contextTokens, 25000);
  assert.ok(!('contextChars' in found.raw.agent));
  assert.deepEqual(found.migration, { from: 100000, to: 25000 });
  assert.equal(found.raw.provider.model, 'mine');
});

test('testProvider reports unreachable providers instead of throwing', async () => {
  const result = await testProvider(
    { provider: { baseUrl: 'http://127.0.0.1:9/v1', model: 'none' } },
    { fetchImpl: async () => { throw new Error('boom'); } }
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /boom/);
});

test('summaryLines describe the provider, key source and memory', () => {
  const lines = summaryLines({
    provider: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY', maxTokens: 4096 },
    tools: { shell: { enabled: false } },
    memory: { enabled: true, dir: '~/data' }
  }, { configPath: '/tmp/config.json' });
  const asObject = Object.fromEntries(lines);
  assert.equal(asObject['config file'], '/tmp/config.json');
  assert.equal(asObject.provider, 'https://api.deepseek.com/v1');
  assert.equal(asObject['api key'], 'environment variable DEEPSEEK_API_KEY');
  assert.equal(asObject['shell tool'], 'disabled');
  assert.equal(asObject.memory, 'enabled, ~/data');
  assert.equal(asObject['max tokens'], '4096');
  assert.equal(asObject['context budget'], '24000 tokens');

  const noCap = Object.fromEntries(summaryLines({ provider: { baseUrl: 'http://x/v1', model: 'm' } }, { configPath: '/tmp/config.json' }));
  assert.equal(noCap['max tokens'], 'provider default');
});

// End-to-end tests (piped stdin, no TTY) --------------------------------------

test('Enter-only run writes the example defaults without a maxTokens cap', async (t) => {
  const { dir, configPath } = workspace(t);
  const input = ['', '', '', '', '', '', '', 'n', ''].join('\n') + '\n';
  const result = await runSetup(['--config', configPath, '--no-start'], { cwd: dir, input });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Wrote .*config\.json/);
  const raw = readConfig(configPath);
  assert.equal(raw.provider.baseUrl, 'http://localhost:11434/v1');
  assert.equal(raw.provider.model, 'qwen3:8b');
  assert.equal(raw.provider.apiKeyEnv, 'BASICAGENT_API_KEY');
  assert.ok(!('maxTokens' in raw.provider), 'no output cap is written; the provider default applies');
  assert.equal(raw.tools.shell.enabled, false);
  assert.equal(raw.tools.readOnly, false, 'new installs get the read-only default');
  assert.ok(raw.tools.shell.readOnlyAllowlist.includes('date'));
  assert.equal(raw.agent.toolCircuitBreaker.failureThreshold, 3);
  assert.equal(raw.memory.enabled, true);
  assert.equal(raw.memory.dir, '~/.local/share/basicagent');
  assert.ok(raw.tools.web.enabled, 'other example settings are kept');
  assert.equal(statSync(configPath).mode & 0o777, 0o600, 'config is written 0600');
});

test('preset answers, inline key, shell and custom paths are written', async (t) => {
  const { dir, configPath } = workspace(t);
  const dataDir = join(dir, 'agent-data');
  const input = ['2', '', '', '', 'sk-test-123', 'y', '', dataDir, '', 'n', ''].join('\n') + '\n';
  const result = await runSetup(['--config', configPath, '--no-start'], { cwd: dir, input });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Ollama Cloud/);
  const raw = readConfig(configPath);
  assert.equal(raw.provider.baseUrl, 'https://ollama.com/v1');
  assert.equal(raw.provider.model, 'gemma4:31b');
  assert.equal(raw.provider.apiKeyEnv, 'OLLAMA_API_KEY_CLOUD');
  assert.equal(raw.provider.apiKey, 'sk-test-123');
  assert.ok(!('maxTokens' in raw.provider), 'setup adds no maxTokens cap');
  assert.equal(raw.tools.shell.enabled, true);
  assert.equal(raw.memory.dir, dataDir);
});

test('an existing config keeps its values and unrelated settings', async (t) => {
  const { dir, configPath } = workspace(t);
  writeFileSync(configPath, JSON.stringify({
    provider: { baseUrl: 'http://localhost:9999/v1', model: 'my-model', apiKey: 'sekret', apiKeyEnv: 'MY_KEY', maxTokens: 8192 },
    tools: { files: { roots: [{ path: '/somewhere', access: 'ro' }] }, shell: { enabled: true } },
    custom: { keep: true }
  }));
  const input = ['', '', '', '', '', '', '', join(dir, 'data'), '', ''].join('\n') + '\n';
  const result = await runSetup(['--config', configPath, '--no-start', '--no-test'], { cwd: dir, input });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Found an existing config/);
  const raw = readConfig(configPath);
  assert.equal(raw.provider.baseUrl, 'http://localhost:9999/v1');
  assert.equal(raw.provider.model, 'my-model');
  assert.equal(raw.provider.apiKey, 'sekret', 'stored key is kept on Enter');
  assert.equal(raw.provider.apiKeyEnv, 'MY_KEY');
  assert.equal(raw.provider.maxTokens, 8192, 'an existing cap is preserved');
  assert.deepEqual(raw.tools.files.roots, [{ path: '/somewhere', access: 'ro' }]);
  assert.equal(raw.tools.shell.enabled, true);
  assert.ok(!('readOnly' in raw.tools), 'an existing file keeps its minimal shape; defaults apply at runtime');
  assert.deepEqual(raw.custom, { keep: true });
});

test('setup migrates contextChars from an existing config', async (t) => {
  const { dir, configPath } = workspace(t);
  writeFileSync(configPath, JSON.stringify({
    provider: { baseUrl: 'http://localhost:9999/v1', model: 'my-model', apiKey: 'sekret', apiKeyEnv: 'MY_KEY' },
    agent: { contextChars: 100000 },
    tools: { shell: { enabled: true } }
  }));
  const input = ['', '', '', '', '', '', '', join(dir, 'data'), '', ''].join('\n') + '\n';
  const result = await runSetup(['--config', configPath, '--no-start', '--no-test'], { cwd: dir, input });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Migrating agent\.contextChars=100000 to agent\.contextTokens=25000/);
  const raw = readConfig(configPath);
  assert.equal(raw.agent.contextTokens, 25000);
  assert.ok(!('contextChars' in raw.agent), 'the old key is gone after setup');
});

test('the provider test runs against the configured provider', async (t) => {
  const provider = await startFakeProvider([[textChunk('ready'), finishChunk('stop')]]);
  t.after(() => provider.close());
  const { dir, configPath } = workspace(t);
  const input = ['6', provider.baseUrl, 'fake-model', '', '', '', '', join(dir, 'data'), '', '', ''].join('\n') + '\n';
  const result = await runSetup(['--config', configPath, '--no-start'], { cwd: dir, input });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Testing the provider connection/);
  assert.match(result.stdout, /ok: fake-model replied "ready"/);
  const raw = readConfig(configPath);
  assert.equal(raw.provider.baseUrl, provider.baseUrl);
  assert.equal(raw.provider.model, 'fake-model');
});

test('a failed provider test can be skipped and the config is still written', async (t) => {
  const { dir, configPath } = workspace(t);
  const input = ['6', 'http://127.0.0.1:9/v1', 'nope-model', '', '', '', '', join(dir, 'data'), '', '', 'n', ''].join('\n') + '\n';
  const result = await runSetup(['--config', configPath, '--no-start'], { cwd: dir, input });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /failed:/);
  assert.match(result.stdout, /Edit the provider settings and try again/);
  assert.ok(readConfig(configPath).provider.baseUrl === 'http://127.0.0.1:9/v1');
});

test('declining the write leaves no file and starts nothing', async (t) => {
  const { dir, configPath } = workspace(t);
  const input = ['', '', '', '', '', '', '', 'n', 'n'].join('\n') + '\n';
  const result = await runSetup(['--config', configPath, '--no-start'], { cwd: dir, input });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Nothing written/);
  assert.throws(() => statSync(configPath));
});

test('--help and --version exit without prompting', async (t) => {
  const { dir } = workspace(t);
  const help = await runSetup(['--help'], { cwd: dir, input: '' });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /basicagent setup/);
  assert.match(help.stdout, /--config <file>/);

  const version = await runSetup(['--version'], { cwd: dir, input: '' });
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
