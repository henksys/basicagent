// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, deepMerge, defaultConfigPath, defaultDataDir, BUNDLED_SKILLS_DIR } from '../src/config.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'basicagent-config-'));
}

test('defaults load when no config file exists', () => {
  const dir = tempDir();
  try {
    const config = loadConfig({ env: { HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') }, cwd: dir });
    assert.equal(config.provider.baseUrl, 'http://localhost:11434/v1');
    assert.equal(config.provider.maxTokens, null, 'no output cap by default');
    assert.equal(config.agent.contextTokens, 24000, 'whole-prompt token budget');
    assert.equal(config.agent.compact, 'summarize');
    assert.equal(config.agent.compactAt, 0.8);
    assert.equal(config.agent.toolCircuitBreaker.failureThreshold, 3);
    assert.equal(config.tools.readOnly, false, 'read-only mode is off by default');
    assert.ok(config.tools.shell.readOnlyAllowlist.includes('date'));
    assert.ok(config.tools.shell.readOnlyAllowlist.includes('systemctl status'));
    assert.equal(config.tools.files.roots.length, 1);
    assert.equal(config.tools.files.roots[0].path, dir);
    assert.equal(config.paths.configFound, false);
    assert.equal(config.paths.configPath, join(dir, '.config', 'basicagent', 'config.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config file values merge over defaults', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      provider: { model: 'gemma4:31b', baseUrl: 'https://ollama.com/v1' },
      tools: { files: { roots: [{ path: dir, access: 'rw' }] } }
    }));
    const config = loadConfig({ flags: { config: configPath }, env: {}, cwd: dir });
    assert.equal(config.provider.model, 'gemma4:31b');
    assert.equal(config.provider.baseUrl, 'https://ollama.com/v1');
    assert.equal(config.provider.temperature, 0.2, 'untouched defaults survive');
    assert.equal(config.paths.configFound, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precedence: flags beat env beat file', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ provider: { model: 'from-file' } }));
    const config = loadConfig({
      flags: { config: configPath, model: 'from-flag' },
      env: { BASICAGENT_MODEL: 'from-env' },
      cwd: dir
    });
    assert.equal(config.provider.model, 'from-flag');
    const config2 = loadConfig({ flags: { config: configPath }, env: { BASICAGENT_MODEL: 'from-env' }, cwd: dir });
    assert.equal(config2.provider.model, 'from-env');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('api key comes from the named environment variable', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ provider: { apiKeyEnv: 'OLLAMA_API_KEY_CLOUD' } }));
    const config = loadConfig({ flags: { config: configPath }, env: { OLLAMA_API_KEY_CLOUD: 'secret-value' }, cwd: dir });
    assert.equal(config.provider.apiKey, 'secret-value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit missing config file is an error', () => {
  const dir = tempDir();
  try {
    assert.throws(() => loadConfig({ flags: { config: join(dir, 'nope.json') }, env: {}, cwd: dir }), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid values are rejected with clear errors', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ tools: { files: { roots: [{ path: dir, access: 'banana' }] } } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /access/);
    writeFileSync(configPath, JSON.stringify({ agent: { maxIterations: 0 } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /maxIterations/);
    writeFileSync(configPath, JSON.stringify({ agent: { contextChars: 100000 } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /contextChars was replaced by agent\.contextTokens/);
    writeFileSync(configPath, JSON.stringify({ agent: { contextTokens: 100 } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /contextTokens/);
    writeFileSync(configPath, JSON.stringify({ agent: { compact: 'maybe' } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /agent\.compact/);
    writeFileSync(configPath, JSON.stringify({ agent: { compactAt: 2 } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /compactAt/);
    writeFileSync(configPath, JSON.stringify({ provider: { maxTokens: 0 } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /maxTokens/);
    writeFileSync(configPath, JSON.stringify({ agent: { toolCircuitBreaker: { failureThreshold: 0 } } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /toolCircuitBreaker/);
    writeFileSync(configPath, JSON.stringify({ tools: { readOnly: 'yes' } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /tools\.readOnly/);
    writeFileSync(configPath, JSON.stringify({ tools: { shell: { readOnlyAllowlist: 'date' } } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /readOnlyAllowlist/);
    writeFileSync(configPath, JSON.stringify({ tools: { shell: { readOnlyAllowlist: [''] } } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /readOnlyAllowlist/);
    writeFileSync(configPath, JSON.stringify({ tools: { shell: { readOnlyAllowlist: ['bad;command'] } } }));
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /readOnlyAllowlist/);
    writeFileSync(configPath, 'not json');
    assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deepMerge merges objects and replaces arrays', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] });
});

test('defaultConfigPath honors XDG_CONFIG_HOME', () => {
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: '/x' }), join('/x', 'basicagent', 'config.json'));
});

test('defaultDataDir honors XDG_DATA_HOME', () => {
  assert.equal(defaultDataDir({ XDG_DATA_HOME: '/x' }), join('/x', 'basicagent'));
});

test('the data directory follows flag > env > file > XDG default', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    const env = { XDG_CONFIG_HOME: join(dir, '.config'), XDG_DATA_HOME: join(dir, 'xdg-data') };

    // Nothing configured: XDG-aware default.
    let config = loadConfig({ env, cwd: dir });
    assert.equal(config.memory.dir, join(dir, 'xdg-data', 'basicagent'));

    // Config file value beats the default; relative paths resolve against cwd.
    writeFileSync(configPath, JSON.stringify({ memory: { dir: 'agent-data' } }));
    config = loadConfig({ flags: { config: configPath }, env, cwd: dir });
    assert.equal(config.memory.dir, join(dir, 'agent-data'));

    // Environment beats the config file.
    config = loadConfig({
      flags: { config: configPath },
      env: { ...env, BASICAGENT_DATA_DIR: join(dir, 'env-data') },
      cwd: dir
    });
    assert.equal(config.memory.dir, join(dir, 'env-data'));

    // The flag beats the environment.
    config = loadConfig({
      flags: { config: configPath, dataDir: join(dir, 'flag-data') },
      env: { ...env, BASICAGENT_DATA_DIR: join(dir, 'env-data') },
      cwd: dir
    });
    assert.equal(config.memory.dir, join(dir, 'flag-data'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid memory.dir values are rejected', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    for (const body of [{ memory: { dir: '' } }, { memory: { dir: 5 } }, { memory: { dir: null } }]) {
      writeFileSync(configPath, JSON.stringify(body));
      assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), /memory\.dir/, JSON.stringify(body));
    }
    assert.throws(() => loadConfig({ flags: { config: configPath, dataDir: '' }, env: {}, cwd: dir }), /memory\.dir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the bundled skills directory is always included, after user paths', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ skills: { paths: ['./custom-skills'] } }));
    const config = loadConfig({ flags: { config: configPath }, env: {}, cwd: dir });
    assert.equal(config.skills.paths[0], join(dir, 'custom-skills'));
    assert.equal(config.skills.paths.at(-1), BUNDLED_SKILLS_DIR, 'bundled dir is scanned last so user skills win');
    assert.equal(config.skills.paths.filter((path) => path === BUNDLED_SKILLS_DIR).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the bundled skills directory is present with default paths too', () => {
  const dir = tempDir();
  try {
    const config = loadConfig({ env: { HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') }, cwd: dir });
    assert.ok(config.skills.paths.includes(BUNDLED_SKILLS_DIR));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools.web is validated', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    const cases = [
      [{ tools: { web: { approval: 'sometimes' } } }, /tools\.web\.approval/],
      [{ tools: { web: { maxBytes: 0 } } }, /tools\.web\.maxBytes/],
      [{ tools: { web: { maxRedirects: -1 } } }, /tools\.web\.maxRedirects/],
      [{ tools: { web: { allowPrivate: 'yes' } } }, /tools\.web\.allowPrivate/],
      [{ tools: { web: { denyDomains: 'example.com' } } }, /tools\.web\.denyDomains/],
      [{ tools: { web: { userAgent: 5 } } }, /tools\.web\.userAgent/]
    ];
    for (const [body, pattern] of cases) {
      writeFileSync(configPath, JSON.stringify(body));
      assert.throws(() => loadConfig({ flags: { config: configPath }, env: {}, cwd: dir }), pattern, JSON.stringify(body));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the noWeb flag disables the web tool for one run', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ tools: { web: { enabled: true } } }));
    const config = loadConfig({ flags: { config: configPath, noWeb: true }, env: {}, cwd: dir });
    assert.equal(config.tools.web.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the readOnly flag overrides the config in both directions', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ tools: { readOnly: true } }));
    const on = loadConfig({ flags: { config: configPath }, env: {}, cwd: dir });
    assert.equal(on.tools.readOnly, true);

    const off = loadConfig({ flags: { config: configPath, readOnly: false }, env: {}, cwd: dir });
    assert.equal(off.tools.readOnly, false);

    writeFileSync(configPath, JSON.stringify({ tools: { readOnly: false } }));
    const forced = loadConfig({ flags: { config: configPath, readOnly: true }, env: {}, cwd: dir });
    assert.equal(forced.tools.readOnly, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the read-only allowlist is normalized and an explicit empty list survives', () => {
  const dir = tempDir();
  try {
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ tools: { shell: { readOnlyAllowlist: ['  systemctl   status ', 'date'] } } }));
    let config = loadConfig({ flags: { config: configPath }, env: {}, cwd: dir });
    assert.deepEqual(config.tools.shell.readOnlyAllowlist, ['systemctl status', 'date']);

    writeFileSync(configPath, JSON.stringify({ tools: { shell: { readOnlyAllowlist: [] } } }));
    config = loadConfig({ flags: { config: configPath }, env: {}, cwd: dir });
    assert.deepEqual(config.tools.shell.readOnlyAllowlist, [], 'empty means no shell commands in read-only mode');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
