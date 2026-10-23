// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Memory } from '../src/memory.mjs';
import { discoverSkills } from '../src/skills.mjs';
import { createRegistry } from '../src/tools/index.mjs';
import { matchReadOnlyCommand } from '../src/tools/shell.mjs';

function workspace({ readOnly = false, shell = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'basicagent-readonly-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    provider: { baseUrl: 'http://127.0.0.1:9/v1', model: 'fake-model' },
    tools: {
      readOnly,
      files: { roots: [{ path: '.', access: 'rw' }], ...files },
      shell: { enabled: true, approval: 'never', ...shell },
      web: { enabled: true }
    },
    skills: { paths: [] },
    memory: { enabled: true, dir: join(dir, 'data') }
  }));
  const config = loadConfig({ flags: { config: configPath }, env: {}, cwd: dir });
  const memory = new Memory({ dir: config.memory.dir });
  const skills = discoverSkills(config.skills.paths);
  const registry = createRegistry({ config, memory, skills, cwd: dir });
  return {
    dir,
    config,
    memory,
    skills,
    registry,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('read-only schemas keep read, web, memory and skill tools and hide file writers', (t) => {
  const { registry, cleanup } = workspace({ readOnly: true });
  t.after(cleanup);

  const names = registry.names({ readOnly: true });
  for (const name of ['read_file', 'list_dir', 'fetch_url', 'remember', 'search_memory', 'forget', 'load_skill']) {
    assert.ok(names.includes(name), `${name} should remain available in read-only mode`);
  }
  for (const name of ['write_file', 'edit_file', 'append_file', 'rename_file']) {
    assert.ok(!names.includes(name), `${name} should be hidden in read-only mode`);
  }
  const schemaNames = registry.schemas({ readOnly: true }).map((schema) => schema.function.name);
  assert.deepEqual(schemaNames, names, 'schemas and names describe the same tool set');
});

test('read-only execution rejects file writers even if the model calls one', async (t) => {
  const { dir, registry, cleanup } = workspace({ readOnly: true });
  t.after(cleanup);

  await assert.rejects(
    () => registry.execute('write_file', { path: 'nope.txt', content: 'x' }, { readOnly: true }),
    /not available in read-only mode/
  );
  assert.ok(!existsSync(join(dir, 'nope.txt')), 'no file was created');
});

test('read-only file reads and memory writes still work', async (t) => {
  const { dir, registry, cleanup } = workspace({ readOnly: true });
  t.after(cleanup);
  writeFileSync(join(dir, 'notes.txt'), 'hello from disk\n');

  const read = await registry.execute('read_file', { path: 'notes.txt' }, { readOnly: true });
  assert.match(read.text, /hello from disk/);

  await registry.execute('remember', { key: 'editor', value: 'nvim' }, { readOnly: true });
  const found = await registry.execute('search_memory', { query: 'editor' }, { readOnly: true });
  assert.equal(found.found, true);
});

test('the shell allowlist matches commands and required argv prefixes', () => {
  const allowlist = ['journalctl', 'systemctl status', 'date'];

  assert.equal(matchReadOnlyCommand(allowlist, 'date', []), true);
  assert.equal(matchReadOnlyCommand(allowlist, 'date', ['+%Y-%m-%d']), true);
  assert.equal(matchReadOnlyCommand(allowlist, 'journalctl', ['-u', 'sshd']), true);
  assert.equal(matchReadOnlyCommand(allowlist, 'systemctl', ['status', 'sshd']), true);
  assert.equal(matchReadOnlyCommand(allowlist, 'systemctl', ['restart', 'sshd']), false);
  assert.equal(matchReadOnlyCommand(allowlist, 'systemctl', ['--user', 'status']), false);
  assert.equal(matchReadOnlyCommand(allowlist, 'date', ['-s', '2030-01-01']), true, 'flags are intentionally trusted');
});

test('read-only shell runs allowlisted commands and refuses others', async (t) => {
  const { registry, cleanup } = workspace({ readOnly: true });
  t.after(cleanup);

  const names = registry.names({ readOnly: true });
  assert.ok(names.includes('run_command'), 'a non-empty allowlist keeps run_command available');

  const result = await registry.execute(
    'run_command',
    { command: 'date', args: [] },
    { readOnly: true, approve: async () => true }
  );
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.trim().length > 0);

  await assert.rejects(
    () => registry.execute(
      'run_command',
      { command: 'systemctl', args: ['restart', 'sshd'] },
      { readOnly: true, approve: async () => true }
    ),
    /not in tools\.shell\.readOnlyAllowlist/
  );
});

test('an empty shell allowlist removes run_command in read-only mode', async (t) => {
  const { registry, cleanup } = workspace({ readOnly: true, shell: { readOnlyAllowlist: [] } });
  t.after(cleanup);

  assert.ok(!registry.names({ readOnly: true }).includes('run_command'));
  await assert.rejects(
    () => registry.execute('run_command', { command: 'date', args: [] }, { readOnly: true }),
    /not available in read-only mode/
  );
});
