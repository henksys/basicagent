// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApproval } from '../src/approval.mjs';

test('--yes approves automatically and emits an event', async () => {
  const events = [];
  const approve = createApproval({ yes: true, onEvent: (event) => events.push(event) });
  assert.equal(await approve('do it'), true);
  assert.equal(events[0].approved, true);
  assert.equal(events[0].automatic, true);
});

test('non-interactive runs deny and explain why', async () => {
  const events = [];
  const notices = [];
  const approve = createApproval({
    interactive: false,
    onEvent: (event) => events.push(event),
    onNotice: (text) => notices.push(text)
  });
  assert.equal(await approve('dangerous thing'), false);
  assert.equal(events[0].approved, false);
  assert.equal(events[0].automatic, true);
  assert.match(notices[0], /--yes/);
});

test('interactive runs ask and parse yes/no answers', async () => {
  const asked = [];
  let answer = 'y';
  const approve = createApproval({
    interactive: true,
    question: async (text) => {
      asked.push(text);
      return answer;
    }
  });

  assert.equal(await approve('write file'), true);
  answer = 'yes';
  assert.equal(await approve('write file'), true);
  answer = 'n';
  assert.equal(await approve('write file'), false);
  answer = '';
  assert.equal(await approve('write file'), false, 'empty answer defaults to no');
  assert.equal(asked.length, 4);
  assert.match(asked[0], /write file/);
});
