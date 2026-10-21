// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptLabel } from '../src/ui.mjs';

const CYAN = '\u001b[36m';
const RESET = '\u001b[0m';

test('promptLabel paints the label cyan on a TTY', () => {
  assert.equal(
    promptLabel('basicagent', { stream: { isTTY: true }, env: {} }),
    `${CYAN}basicagent${RESET}`
  );
});

test('promptLabel stays plain when the prompt stream is not a TTY', () => {
  assert.equal(
    promptLabel('basicagent', { stream: { isTTY: false }, env: {} }),
    'basicagent'
  );
});

test('promptLabel respects NO_COLOR', () => {
  assert.equal(
    promptLabel('basicagent', { stream: { isTTY: true }, env: { NO_COLOR: '1' } }),
    'basicagent'
  );
});
