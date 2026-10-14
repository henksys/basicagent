// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// Onboarding helpers for `basicagent-setup`.
//
// The interactive questions live in bin/basicagent-setup.mjs; this module
// holds the pure parts so they are testable without a terminal:
//
//   PROVIDER_PRESETS   the provider menu
//   loadBaseConfig     defaults: the existing config, else config.example.json
//   applyAnswers       merge the answers into the base config
//   testProvider       one minimal chat completion against the provider
//   summaryLines       the "about to write" block
//
// The result is validated with the same normalizeConfig the CLI and the web
// settings use, so the written file behaves exactly like one written by hand.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, deepMerge, normalizeConfig } from './config.mjs';
import { readConfigFile } from './config-file.mjs';
import { Provider } from './provider.mjs';
import { bounded, collapseWhitespace, mask } from './util.mjs';

const EXAMPLE_PATH = fileURLToPath(new URL('../config.example.json', import.meta.url));

export const PROVIDER_PRESETS = Object.freeze([
  { label: 'Local Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', apiKeyEnv: '', needsKey: false },
  { label: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', model: 'gemma4:31b', apiKeyEnv: 'OLLAMA_API_KEY_CLOUD', needsKey: true },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY', needsKey: true },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.1', apiKeyEnv: 'OPENAI_API_KEY', needsKey: true },
  { label: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1', model: 'local', apiKeyEnv: '', needsKey: false },
  { label: 'Custom (enter your own URL and model)', custom: true, needsKey: true }
]);

export const CUSTOM_INDEX = PROVIDER_PRESETS.length - 1;

// The preset whose baseUrl matches, or the Custom entry.
export function matchingPreset(baseUrl) {
  const clean = String(baseUrl ?? '').replace(/\/+$/, '');
  const index = PROVIDER_PRESETS.findIndex((preset) => preset.baseUrl && preset.baseUrl === clean);
  return index === -1 ? CUSTOM_INDEX : index;
}

export function getByPath(object, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
}

// Defaults for the questions: the existing config file when it is there,
// otherwise the bundled config.example.json. Returns { raw, source, found }.
export function loadBaseConfig(configPath, { examplePath = EXAMPLE_PATH } = {}) {
  if (existsSync(configPath)) {
    return { raw: readConfigFile(configPath).raw, source: configPath, found: true };
  }
  try {
    const raw = JSON.parse(readFileSync(examplePath, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { raw, source: examplePath, found: false };
    }
  } catch {
    // Missing or damaged example: fall back to the built-in defaults.
  }
  return { raw: {}, source: 'built-in defaults', found: false };
}

// Merge the answers into the base config; every other key is preserved.
// apiKey/apiKeyEnv keep their base value when undefined, are set for a
// string and removed for null or "".
export function applyAnswers(base, answers) {
  const raw = structuredClone(base ?? {});
  raw.provider = { ...(raw.provider || {}) };
  raw.provider.baseUrl = String(answers.baseUrl).replace(/\/+$/, '');
  raw.provider.model = answers.model;
  for (const key of ['apiKey', 'apiKeyEnv']) {
    const value = answers[key];
    if (value === undefined) continue;
    if (value === null || value === '') delete raw.provider[key];
    else raw.provider[key] = value;
  }
  raw.tools = { ...(raw.tools || {}) };
  raw.tools.shell = { ...(raw.tools.shell || {}), enabled: Boolean(answers.shellEnabled) };
  raw.memory = { ...(raw.memory || {}), enabled: Boolean(answers.memoryEnabled), dir: answers.dataDir };
  return raw;
}

// One minimal chat completion to check URL, model and key. The token limit
// and timeout are capped so a wrong address fails quickly; the key is
// resolved the same way loadConfig does it (explicit key, then env var name).
export async function testProvider(raw, { cwd = process.cwd(), configPath = '', timeoutMs = 10000, fetchImpl } = {}) {
  const merged = deepMerge(structuredClone(DEFAULTS), raw);
  const config = normalizeConfig(merged, { cwd, configPath, configFound: true });
  config.provider.timeoutMs = Math.min(config.provider.timeoutMs, timeoutMs);
  config.provider.maxTokens = 16;
  config.provider.temperature = 0;
  if (process.env.BASICAGENT_API_KEY) config.provider.apiKey = process.env.BASICAGENT_API_KEY;
  else if (!config.provider.apiKey && config.provider.apiKeyEnv) config.provider.apiKey = process.env[config.provider.apiKeyEnv] || '';

  const provider = new Provider(config, fetchImpl ? { fetchImpl } : {});
  const started = Date.now();
  try {
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }]
    });
    const reply = bounded(collapseWhitespace(result.content || ''), 120) || '(empty reply)';
    return { ok: true, message: reply, durationMs: Date.now() - started };
  } catch (error) {
    return { ok: false, message: error?.message || String(error), durationMs: Date.now() - started };
  }
}

// [label, value] pairs for the confirmation block.
export function summaryLines(raw, { configPath }) {
  const provider = raw.provider || {};
  const key = provider.apiKey
    ? `stored in the file (${mask(provider.apiKey)})`
    : provider.apiKeyEnv ? `environment variable ${provider.apiKeyEnv}` : '(none)';
  return [
    ['config file', configPath],
    ['provider', provider.baseUrl],
    ['model', provider.model],
    ['api key', key],
    ['max tokens', provider.maxTokens == null ? 'provider default' : String(provider.maxTokens)],
    ['shell tool', raw.tools?.shell?.enabled ? 'enabled (every command asks approval)' : 'disabled'],
    ['memory', raw.memory?.enabled === false ? 'disabled' : `enabled, ${raw.memory?.dir}`]
  ];
}
