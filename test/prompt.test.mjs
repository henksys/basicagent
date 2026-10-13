// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/prompt.mjs';

const emptyConfig = { agent: { systemPrompt: '', systemPromptFile: '' } };

test('default persona names basicagent and includes the skills index', () => {
  const skills = new Map([['demo', { name: 'demo', description: 'does demo things' }]]);
  const text = buildSystemPrompt({ config: emptyConfig, skills, memory: null, cwd: '/tmp/work' });
  assert.match(text, /You are basicagent/);
  assert.match(text, /- demo: does demo things/);
  assert.match(text, /Working directory: \/tmp\/work/);
});

test('a custom systemPrompt replaces only the persona', () => {
  const config = { agent: { systemPrompt: 'You are Alfred, a butler.', systemPromptFile: '' } };
  const text = buildSystemPrompt({ config, skills: new Map(), memory: null, cwd: '/tmp' });
  assert.match(text, /^You are Alfred, a butler\./);
  assert.doesNotMatch(text, /You are basicagent/);
  assert.match(text, /## Using tools/);
  assert.match(text, /## Safety rules/);
});

test('saved facts are included and marked untrusted', () => {
  const memory = { factsContext: () => '- editor: nvim' };
  const text = buildSystemPrompt({ config: emptyConfig, skills: new Map(), memory, cwd: '/tmp' });
  assert.match(text, /## Saved facts/);
  assert.match(text, /- editor: nvim/);
  assert.match(text, /untrusted reference data/);
});
