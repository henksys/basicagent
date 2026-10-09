// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// Configuration loading and validation.
//
// Precedence, lowest to highest:
//   1. built-in DEFAULTS
//   2. the config file (--config, BASICAGENT_CONFIG, or ~/.config/basicagent/config.json)
//   3. environment overrides (BASICAGENT_API_KEY, BASICAGENT_BASE_URL, BASICAGENT_MODEL)
//   4. command line flags (--api-key, --base-url, --model)
//
// Every path in the config may start with "~". Relative paths are resolved
// against the directory basicagent was started in (the "cwd").
//
// The returned object is a fully normalized copy: all file/skill/memory paths
// are absolute, and `paths.configPath` records which config file was used
// (it is protected from unapproved writes even if no file exists yet).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUserPath } from './util.mjs';

export const ACCESS_LEVELS = ['rw', 'ro', 'approval', 'deny'];

// The project's own skills directory (bundled `basicagent` self-help skill and
// the `example` template). It is resolved from this module, not from the
// working directory, and is appended to every skills.paths list in loadConfig
// so the bundled skills are available no matter where basicagent runs.
export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));

export const DEFAULTS = Object.freeze({
  provider: {
    // Any OpenAI-compatible /v1 server: Ollama, llama.cpp, DeepSeek, OpenAI, ...
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    apiKeyEnv: 'BASICAGENT_API_KEY',
    model: 'qwen3:8b',
    temperature: 0.2,
    maxTokens: 2048,
    timeoutMs: 120000,
    // Ollama does not support tool_choice, so it stays null (omitted) by
    // default. Set to "auto", "required" or "none" for providers that do.
    toolChoice: null,
    // Some servers return token usage in the stream; harmless when off.
    includeUsage: false
  },
  agent: {
    maxIterations: 25,
    contextChars: 100000,
    maxResultChars: 24000,
    // Optional replacement for the built-in persona paragraph.
    systemPrompt: '',
    systemPromptFile: ''
  },
  tools: {
    files: {
      // Each root grants access to a directory tree:
      //   rw       read and write without approval
      //   ro       read only
      //   approval writes require a y/N confirmation
      //   deny     refuse everything
      // Paths outside every root are always refused.
      roots: [{ path: '.', access: 'rw' }],
      // Writes inside these paths always require approval.
      protectedPaths: [],
      maxReadBytes: 24000,
      maxWriteBytes: 1048576,
      maxListEntries: 200
    },
    shell: {
      // Disabled by default. When enabled, every command still needs approval
      // (approval: "always") unless changed to "never".
      enabled: false,
      approval: 'always',
      timeoutMs: 30000,
      maxOutputBytes: 24000,
      // A deliberately simple, obvious backstop. It is NOT a sandbox.
      denylist: ['rm -rf /', 'mkfs', 'dd if=', 'shutdown', 'reboot', 'wipefs']
    },
    web: {
      // The fetch_url tool is read-only and enabled by default. Set
      // enabled: false (or use --no-web) to remove the tool entirely.
      enabled: true,
      // "always" asks for y/N approval before every fetch; "never" fetches
      // directly. Private/reserved addresses are blocked either way.
      approval: 'never',
      timeoutMs: 15000,
      maxRawBytes: 512000,
      maxBytes: 24000,
      maxRedirects: 5,
      // Danger: true lets fetch_url reach localhost and private networks.
      // Only for trusted local testing.
      allowPrivate: false,
      denyDomains: [],
      allowDomains: [],
      userAgent: ''
    }
  },
  skills: {
    // Each path is scanned for <name>/SKILL.md. Missing paths are ignored.
    paths: ['./skills', '~/.config/basicagent/skills', '~/.agents/skills', '~/.claude/skills']
  },
  memory: {
    enabled: true,
    dir: '~/.local/share/basicagent'
  }
});

// Expand "~" and XDG_CONFIG_HOME for the default config location.
export function defaultConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'basicagent', 'config.json');
}

// Merge `overlay` into `base` recursively. Arrays and scalars replace.
export function deepMerge(base, overlay) {
  if (overlay === undefined) return base;
  if (Array.isArray(base) || Array.isArray(overlay)) return overlay;
  if (base && overlay && typeof base === 'object' && typeof overlay === 'object') {
    const out = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) continue;
      out[key] = deepMerge(base[key], value);
    }
    return out;
  }
  return overlay;
}

// Validate and normalize a raw config object. Throws with a readable message
// on any invalid field so problems surface at startup, not mid-conversation.
export function normalizeConfig(config, { cwd, configPath, configFound }) {
  const provider = config.provider;
  if (typeof provider.baseUrl !== 'string' || !provider.baseUrl.trim()) throw new Error('provider.baseUrl must be a non-empty string');
  if (typeof provider.model !== 'string' || !provider.model.trim()) throw new Error('provider.model must be a non-empty string');
  if (!Number.isFinite(provider.temperature) || provider.temperature < 0 || provider.temperature > 2) throw new Error('provider.temperature must be a number between 0 and 2');
  if (!Number.isInteger(provider.maxTokens) || provider.maxTokens <= 0) throw new Error('provider.maxTokens must be a positive integer');
  if (!Number.isInteger(provider.timeoutMs) || provider.timeoutMs <= 0) throw new Error('provider.timeoutMs must be a positive integer');
  if (provider.toolChoice !== null && !['auto', 'required', 'none'].includes(provider.toolChoice)) throw new Error('provider.toolChoice must be null, "auto", "required" or "none"');
  if (!provider.apiKey && provider.apiKeyEnv && typeof provider.apiKeyEnv !== 'string') throw new Error('provider.apiKeyEnv must be a string');

  const agent = config.agent;
  if (!Number.isInteger(agent.maxIterations) || agent.maxIterations < 1) throw new Error('agent.maxIterations must be a positive integer');
  if (!Number.isInteger(agent.contextChars) || agent.contextChars < 1000) throw new Error('agent.contextChars must be an integer of at least 1000');
  if (!Number.isInteger(agent.maxResultChars) || agent.maxResultChars < 1000) throw new Error('agent.maxResultChars must be an integer of at least 1000');

  const files = config.tools.files;
  if (!Array.isArray(files.roots) || files.roots.length === 0) throw new Error('tools.files.roots must be a non-empty array');
  files.roots = files.roots.map((root, index) => {
    const raw = typeof root === 'string' ? { path: root } : root;
    if (!raw || typeof raw.path !== 'string' || !raw.path.trim()) throw new Error(`tools.files.roots[${index}].path must be a non-empty string`);
    const access = raw.access === undefined ? 'rw' : raw.access;
    if (!ACCESS_LEVELS.includes(access)) throw new Error(`tools.files.roots[${index}].access must be one of: ${ACCESS_LEVELS.join(', ')}`);
    return { path: resolveUserPath(raw.path, cwd), access };
  });
  files.protectedPaths = (files.protectedPaths || []).map((path) => {
    if (typeof path !== 'string' || !path.trim()) throw new Error('tools.files.protectedPaths entries must be non-empty strings');
    return resolveUserPath(path, cwd);
  });
  for (const key of ['maxReadBytes', 'maxWriteBytes', 'maxListEntries']) {
    if (!Number.isInteger(files[key]) || files[key] <= 0) throw new Error(`tools.files.${key} must be a positive integer`);
  }

  const shell = config.tools.shell;
  if (typeof shell.enabled !== 'boolean') throw new Error('tools.shell.enabled must be a boolean');
  if (!['always', 'never'].includes(shell.approval)) throw new Error('tools.shell.approval must be "always" or "never"');
  if (!Number.isInteger(shell.timeoutMs) || shell.timeoutMs <= 0) throw new Error('tools.shell.timeoutMs must be a positive integer');
  if (!Number.isInteger(shell.maxOutputBytes) || shell.maxOutputBytes <= 0) throw new Error('tools.shell.maxOutputBytes must be a positive integer');
  if (!Array.isArray(shell.denylist) || shell.denylist.some((entry) => typeof entry !== 'string')) throw new Error('tools.shell.denylist must be an array of strings');

  const web = config.tools.web;
  if (typeof web.enabled !== 'boolean') throw new Error('tools.web.enabled must be a boolean');
  if (!['always', 'never'].includes(web.approval)) throw new Error('tools.web.approval must be "always" or "never"');
  for (const key of ['timeoutMs', 'maxRawBytes', 'maxBytes', 'maxRedirects']) {
    if (!Number.isInteger(web[key]) || web[key] <= 0) throw new Error(`tools.web.${key} must be a positive integer`);
  }
  if (typeof web.allowPrivate !== 'boolean') throw new Error('tools.web.allowPrivate must be a boolean');
  for (const key of ['denyDomains', 'allowDomains']) {
    if (!Array.isArray(web[key]) || web[key].some((entry) => typeof entry !== 'string')) throw new Error(`tools.web.${key} must be an array of strings`);
  }
  if (typeof web.userAgent !== 'string') throw new Error('tools.web.userAgent must be a string');

  if (!Array.isArray(config.skills.paths) || config.skills.paths.some((path) => typeof path !== 'string')) throw new Error('skills.paths must be an array of strings');
  config.skills.paths = config.skills.paths.map((path) => resolveUserPath(path, cwd));

  if (typeof config.memory.enabled !== 'boolean') throw new Error('memory.enabled must be a boolean');
  config.memory.dir = resolveUserPath(config.memory.dir, cwd);

  if (agent.systemPromptFile) agent.systemPromptFile = resolveUserPath(agent.systemPromptFile, cwd);
  if (agent.systemPrompt !== '' && typeof agent.systemPrompt !== 'string') throw new Error('agent.systemPrompt must be a string');

  provider.baseUrl = provider.baseUrl.replace(/\/+$/, '');
  config.paths = { cwd, configPath, configFound };
  return config;
}

// Load, merge and validate the configuration. Never throws when the default
// config file is simply missing; an explicitly requested file must exist.
export function loadConfig({ flags = {}, env = process.env, cwd = process.cwd() } = {}) {
  const explicitPath = flags.config || env.BASICAGENT_CONFIG || '';
  const candidate = explicitPath ? resolveUserPath(explicitPath, cwd) : defaultConfigPath(env);

  let fileConfig = {};
  let configFound = false;
  if (existsSync(candidate)) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (error) {
      throw new Error(`Config file ${candidate} is not valid JSON: ${error.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Config file ${candidate} must contain a JSON object`);
    fileConfig = raw;
    configFound = true;
  } else if (explicitPath) {
    throw new Error(`Config file not found: ${candidate}`);
  }

  const config = deepMerge(structuredClone(DEFAULTS), fileConfig);

  // Environment overrides (before flags, after the file).
  if (env.BASICAGENT_API_KEY) config.provider.apiKey = env.BASICAGENT_API_KEY;
  if (env.BASICAGENT_BASE_URL) config.provider.baseUrl = env.BASICAGENT_BASE_URL;
  if (env.BASICAGENT_MODEL) config.provider.model = env.BASICAGENT_MODEL;

  // Command line flag overrides.
  if (flags.apiKey !== undefined) config.provider.apiKey = flags.apiKey;
  if (flags.baseUrl !== undefined) config.provider.baseUrl = flags.baseUrl;
  if (flags.model !== undefined) config.provider.model = flags.model;
  if (flags.noWeb) config.tools.web.enabled = false;

  // The API key may come from a named environment variable (keeps secrets
  // out of the config file). A directly configured key wins over the env name.
  if (!config.provider.apiKey && config.provider.apiKeyEnv) {
    config.provider.apiKey = env[config.provider.apiKeyEnv] || '';
  }

  const normalized = normalizeConfig(config, { cwd, configPath: candidate, configFound });

  // Always scan the bundled skills too, after the user's paths so a skill of
  // the same name in the user's paths takes precedence. Appending it here
  // (instead of in DEFAULTS) keeps it even when the config replaces
  // skills.paths entirely.
  if (!normalized.skills.paths.includes(BUNDLED_SKILLS_DIR)) {
    normalized.skills.paths.push(BUNDLED_SKILLS_DIR);
  }
  return normalized;
}
