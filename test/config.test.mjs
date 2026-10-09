// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, deepMerge, defaultConfigPath, BUNDLED_SKILLS_DIR } from '../src/config.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'basicagent-config-'));
}

test('defaults load when no config file exists', () => {
  const dir = tempDir();
  try {
    const config = loadConfig({ env: { HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') }, cwd: dir });
    assert.equal(config.provider.baseUrl, 'http://localhost:11434/v1');
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
