// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { fileTools, checkAccess } from '../src/tools/files.mjs';

// Build a sandbox:
//   base/outside-dir/secret.txt
//   base/rootA/            (rw)
//   base/rootB/            (ro)
//   base/rootC/            (approval)
//   base/rootA/protected.txt
//   base/rootA/escape -> ../outside-dir
function makeSandbox() {
  const base = mkdtempSync(join(tmpdir(), 'basicagent-files-'));
  mkdirSync(join(base, 'outside-dir'));
  writeFileSync(join(base, 'outside-dir', 'secret.txt'), 'secret');
  mkdirSync(join(base, 'rootA'));
  mkdirSync(join(base, 'rootB'));
  mkdirSync(join(base, 'rootC'));
  writeFileSync(join(base, 'rootA', 'protected.txt'), 'protected');
  symlinkSync(join(base, 'outside-dir'), join(base, 'rootA', 'escape'));

  const configPath = join(base, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    tools: {
      files: {
        roots: [
          { path: 'rootA', access: 'rw' },
          { path: 'rootB', access: 'ro' },
          { path: 'rootC', access: 'approval' }
        ],
        protectedPaths: ['rootA/protected.txt']
      }
    },
    memory: { enabled: false }
  }));
  const config = loadConfig({ flags: { config: configPath }, env: {}, cwd: base });
  const tools = new Map(fileTools({ config, cwd: base }).map((tool) => [tool.name, tool]));
  return { base, config, tools, configPath };
}

// ctx that records approval requests; `allow` decides the answer.
function makeContext(allow = false) {
  const approvals = [];
  return {
    approvals,
    ctx: {
      signal: undefined,
      approve: async (description) => {
        approvals.push(description);
        return allow;
      }
    }
  };
}

test('write_file and read_file round-trip with line numbers', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { ctx } = makeContext();

  await tools.get('write_file').run({ path: 'rootA/note.txt', content: 'hello\nworld\n' }, ctx);
  const read = await tools.get('read_file').run({ path: 'rootA/note.txt' }, ctx);
  assert.equal(read.totalLines, 3);
  assert.match(read.text, /    1\| hello/);
  assert.match(read.text, /    2\| world/);
});

test('paths outside every root are refused', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { ctx } = makeContext();
  await assert.rejects(() => tools.get('write_file').run({ path: '../outside.txt', content: 'x' }, ctx), /outside the configured file roots/);
  await assert.rejects(() => tools.get('read_file').run({ path: 'outside-dir/secret.txt' }, ctx), /outside the configured file roots/);
});

test('symlinks cannot escape a root', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { ctx } = makeContext();
  await assert.rejects(() => tools.get('read_file').run({ path: 'rootA/escape/secret.txt' }, ctx), /outside the configured file roots/);
  await assert.rejects(() => tools.get('write_file').run({ path: 'rootA/escape/new.txt', content: 'x' }, ctx), /outside the configured file roots/);
});

test('dangling symlinks to outside targets cannot be written through', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { ctx } = makeContext();
  symlinkSync(join(base, 'outside-dir', 'newfile.txt'), join(base, 'rootA', 'dangling'));
  await assert.rejects(
    () => tools.get('write_file').run({ path: 'rootA/dangling', content: 'escaped' }, ctx),
    /outside the configured file roots/
  );
  assert.ok(!existsSync(join(base, 'outside-dir', 'newfile.txt')));
});

test('dangling symlinks that stay inside a root still work', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { ctx } = makeContext();
  symlinkSync(join(base, 'rootA', 'real.txt'), join(base, 'rootA', 'inside-dangling'));
  await tools.get('write_file').run({ path: 'rootA/inside-dangling', content: 'ok' }, ctx);
  assert.equal(readFileSync(join(base, 'rootA', 'real.txt'), 'utf8'), 'ok');
});

test('read-only roots allow reads but refuse writes', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(base, 'rootB', 'readme.md'), 'keep me');
  const { ctx } = makeContext();
  const read = await tools.get('read_file').run({ path: 'rootB/readme.md' }, ctx);
  assert.match(read.text, /keep me/);
  await assert.rejects(() => tools.get('write_file').run({ path: 'rootB/new.txt', content: 'x' }, ctx), /read-only/);
});

test('approval roots ask before writing and honor the answer', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const denied = makeContext(false);
  await assert.rejects(() => tools.get('write_file').run({ path: 'rootC/denied.txt', content: 'x' }, denied.ctx), /denied by user/);
  assert.equal(denied.approvals.length, 1);
  assert.ok(!existsSync(join(base, 'rootC', 'denied.txt')));

  const allowed = makeContext(true);
  await tools.get('write_file').run({ path: 'rootC/allowed.txt', content: 'x' }, allowed.ctx);
  assert.ok(existsSync(join(base, 'rootC', 'allowed.txt')));
});

test('protected paths inside an rw root also require approval', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const denied = makeContext(false);
  await assert.rejects(
    () => tools.get('write_file').run({ path: 'rootA/protected.txt', content: 'changed' }, denied.ctx),
    /denied by user/
  );
  assert.equal(readFileSync(join(base, 'rootA', 'protected.txt'), 'utf8'), 'protected');
});

test('the active config file is protected even inside an rw root', async (t) => {
  const { base, config, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  config.paths.configPath = join(base, 'rootA', 'basicagent.json');
  const denied = makeContext(false);
  await assert.rejects(
    () => tools.get('write_file').run({ path: 'rootA/basicagent.json', content: '{}' }, denied.ctx),
    /denied by user/
  );
  assert.equal(denied.approvals.length, 1);
});

test('edit_file replaces exact text and protects against ambiguity', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { ctx } = makeContext();
  writeFileSync(join(base, 'rootA', 'edit.txt'), 'one two one\n');

  await tools.get('edit_file').run({ path: 'rootA/edit.txt', old_string: 'two', new_string: 'TWO' }, ctx);
  assert.equal(readFileSync(join(base, 'rootA', 'edit.txt'), 'utf8'), 'one TWO one\n');

  await assert.rejects(() => tools.get('edit_file').run({ path: 'rootA/edit.txt', old_string: 'one', new_string: 'x' }, ctx), /matches 2 times/);
  await tools.get('edit_file').run({ path: 'rootA/edit.txt', old_string: 'one', new_string: '1', replace_all: true }, ctx);
  assert.equal(readFileSync(join(base, 'rootA', 'edit.txt'), 'utf8'), '1 TWO 1\n');

  await assert.rejects(() => tools.get('edit_file').run({ path: 'rootA/edit.txt', old_string: 'missing', new_string: 'x' }, ctx), /not found/);
});

test('append_file never creates a file and preserves existing bytes', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { ctx } = makeContext();
  await assert.rejects(() => tools.get('append_file').run({ path: 'rootA/new.txt', text: 'x' }, ctx), /does not create files/);
  writeFileSync(join(base, 'rootA', 'log.txt'), 'first');
  await tools.get('append_file').run({ path: 'rootA/log.txt', text: ' second' }, ctx);
  assert.equal(readFileSync(join(base, 'rootA', 'log.txt'), 'utf8'), 'first second');
});

test('rename_file refuses to overwrite and moves the file', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { ctx } = makeContext();
  writeFileSync(join(base, 'rootA', 'a.txt'), 'data');
  await assert.rejects(() => tools.get('rename_file').run({ from: 'rootA/a.txt', to: 'rootA/protected.txt' }, ctx), /already exists/);
  await tools.get('rename_file').run({ from: 'rootA/a.txt', to: 'rootA/b.txt' }, ctx);
  assert.ok(!existsSync(join(base, 'rootA', 'a.txt')));
  assert.equal(readFileSync(join(base, 'rootA', 'b.txt'), 'utf8'), 'data');
});

test('list_dir marks directories and sorts entries', async (t) => {
  const { base, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { ctx } = makeContext();
  mkdirSync(join(base, 'rootA', 'subdir'));
  writeFileSync(join(base, 'rootA', 'z.txt'), '');
  const listing = await tools.get('list_dir').run({ path: 'rootA' }, ctx);
  assert.ok(listing.entries.includes('subdir/'));
  assert.ok(listing.entries.includes('z.txt'));
  assert.deepEqual(listing.entries, [...listing.entries].sort((a, b) => a.localeCompare(b)));
});

test('checkAccess reports approval requirements to callers', async (t) => {
  const { base, config } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const normal = await checkAccess({ config, cwd: base, input: 'rootA/x.txt', write: true });
  assert.equal(normal.requiresApproval, false);
  const guarded = await checkAccess({ config, cwd: base, input: 'rootC/y.txt', write: true });
  assert.equal(guarded.requiresApproval, true);
});

test('the most specific matching root decides the access level', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'basicagent-specific-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'wide', 'narrow'), { recursive: true });
  writeFileSync(join(base, 'wide', 'open.txt'), 'open');
  const configPath = join(base, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    tools: {
      files: {
        // The broad rw root is listed first: it must not shadow the deny root.
        roots: [
          { path: 'wide', access: 'rw' },
          { path: 'wide/narrow', access: 'deny' }
        ]
      }
    },
    memory: { enabled: false }
  }));
  const config = loadConfig({ flags: { config: configPath }, env: {}, cwd: base });
  const tools = new Map(fileTools({ config, cwd: base }).map((tool) => [tool.name, tool]));
  const { ctx } = makeContext();

  const read = await tools.get('read_file').run({ path: 'wide/open.txt' }, ctx);
  assert.match(read.text, /open/);
  await assert.rejects(() => tools.get('read_file').run({ path: 'wide/narrow/x.txt' }, ctx), /denied by policy/);
  await assert.rejects(() => tools.get('write_file').run({ path: 'wide/narrow/x.txt', content: 'x' }, ctx), /denied by policy/);
});

test('the memory data directory requires approval for writes', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'basicagent-memdir-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const memoryDir = join(base, 'rootA', 'data');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'audit.jsonl'), '');
  const configPath = join(base, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    tools: { files: { roots: [{ path: 'rootA', access: 'rw' }] } },
    memory: { enabled: true, dir: memoryDir }
  }));
  const config = loadConfig({ flags: { config: configPath }, env: {}, cwd: base });
  const tools = new Map(fileTools({ config, cwd: base }).map((tool) => [tool.name, tool]));

  const denied = makeContext(false);
  await assert.rejects(
    () => tools.get('write_file').run({ path: 'rootA/data/audit.jsonl', content: 'tampered' }, denied.ctx),
    /denied by user/
  );
  assert.equal(denied.approvals.length, 1);
  assert.equal(readFileSync(join(memoryDir, 'audit.jsonl'), 'utf8'), '');

  const allowed = makeContext(true);
  await tools.get('write_file').run({ path: 'rootA/data/facts.jsonl', content: 'ok' }, allowed.ctx);
  assert.equal(readFileSync(join(memoryDir, 'facts.jsonl'), 'utf8'), 'ok');
});

test('edit_file enforces the write size limit', async (t) => {
  const { base, config, tools } = makeSandbox();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  config.tools.files.maxWriteBytes = 20;
  const { ctx } = makeContext();
  writeFileSync(join(base, 'rootA', 'grow.txt'), 'short');
  await assert.rejects(
    () => tools.get('edit_file').run({ path: 'rootA/grow.txt', old_string: 'short', new_string: 'x'.repeat(50) }, ctx),
    /write limit/
  );
  assert.equal(readFileSync(join(base, 'rootA', 'grow.txt'), 'utf8'), 'short');
});
