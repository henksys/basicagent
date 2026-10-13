// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserCommand, openBrowser } from '../src/web/open-browser.mjs';

const URL_UNDER_TEST = 'http://127.0.0.1:8787/#token=abc';

function fakeSpawn() {
  const calls = [];
  const child = {
    handlers: {},
    unrefCalled: false,
    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    },
    unref() {
      this.unrefCalled = true;
    }
  };
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { spawnImpl, calls, child };
}

test('browserCommand picks the right launcher per platform', () => {
  assert.deepEqual(browserCommand('linux', URL_UNDER_TEST), ['xdg-open', [URL_UNDER_TEST]]);
  assert.deepEqual(browserCommand('darwin', URL_UNDER_TEST), ['open', [URL_UNDER_TEST]]);
  assert.deepEqual(browserCommand('win32', URL_UNDER_TEST), ['cmd', ['/c', 'start', '', URL_UNDER_TEST]]);
});

test('openBrowser spawns a detached, unreferenced launcher', () => {
  const { spawnImpl, calls, child } = fakeSpawn();
  const result = openBrowser(URL_UNDER_TEST, { platform: 'linux', spawnImpl });

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'xdg-open');
  assert.deepEqual(calls[0].args, [URL_UNDER_TEST]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(child.unrefCalled, true);
  assert.equal(typeof child.handlers.error, 'function', 'an error listener is attached');
  assert.doesNotThrow(() => child.handlers.error(new Error('no display')));
});

test('openBrowser returns false when spawning fails', () => {
  const spawnImpl = () => {
    throw new Error('spawn ENOENT');
  };
  assert.equal(openBrowser(URL_UNDER_TEST, { platform: 'linux', spawnImpl }), false);
});
