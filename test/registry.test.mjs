// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createRegistry } from '../src/tools/index.mjs';

// Build a registry whose memory directory is `memoryDir` (created as a
// directory, or as a file when `breakAudit` is set so audit writes fail).
function setup({ breakAudit = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'basicagent-registry-'));
  mkdirSync(join(base, 'root'));
  const memoryDir = join(base, 'data');
  if (breakAudit) writeFileSync(memoryDir, 'not a directory');
  const configPath = join(base, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    tools: {
      files: { roots: [{ path: 'root', access: 'approval' }] },
      shell: { enabled: false }
    },
    memory: { enabled: true, dir: memoryDir }
  }));
  const config = loadConfig({ flags: { config: configPath }, env: {}, cwd: base });
  const notices = [];
  const registry = createRegistry({
    config,
    memory: { dir: memoryDir },
    skills: new Map(),
    cwd: base,
    onAuditError: (text) => notices.push(text)
  });
  return { base, registry, memoryDir, notices };
}

function readAudit(memoryDir) {
  return readFileSync(join(memoryDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('audit entries record approval outcomes', async (t) => {
  const { base, registry, memoryDir } = setup();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  await registry.execute('write_file', { path: 'root/a.txt', content: 'x' }, { approve: async () => true });

  const entries = readAudit(memoryDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, 'write_file');
  assert.equal(entries[0].ok, true);
  assert.equal(entries[0].approvals.length, 1);
  assert.equal(entries[0].approvals[0].approved, true);
  assert.match(entries[0].approvals[0].description, /Write to/);
});

test('denied approvals are recorded and the tool fails', async (t) => {
  const { base, registry, memoryDir } = setup();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  await assert.rejects(
    () => registry.execute('write_file', { path: 'root/a.txt', content: 'x' }, { approve: async () => false }),
    /denied by user/
  );

  const entries = readAudit(memoryDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ok, false);
  assert.equal(entries[0].approvals[0].approved, false);
});

test('a broken audit log is reported once, without failing tool calls', async (t) => {
  const { base, registry, notices } = setup({ breakAudit: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const first = await registry.execute('write_file', { path: 'root/a.txt', content: 'x' }, { approve: async () => true });
  assert.equal(first.written, true);
  const second = await registry.execute('write_file', { path: 'root/b.txt', content: 'y' }, { approve: async () => true });
  assert.equal(second.written, true);

  assert.equal(notices.length, 1);
  assert.match(notices[0], /audit log/);
});
