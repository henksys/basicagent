// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startFakeProvider, textChunk, toolChunk, finishChunk } from './fixtures/fake-server.mjs';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/basicagent.mjs', import.meta.url));

function makeWorkspace(server, { files = {}, ...extraConfig } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'basicagent-cli-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    provider: { baseUrl: server.baseUrl, model: 'fake-model', apiKey: 'test' },
    tools: { files: { roots: [{ path: dir, access: 'rw' }], ...files } },
    skills: { paths: [] },
    memory: { enabled: false },
    ...extraConfig
  }));
  return { dir, configPath };
}

async function runCli(args, { cwd }) {
  try {
    const result = await run(process.execPath, [bin, ...args], { cwd, timeout: 30000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const parseJSONL = (text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('one-shot --json runs a tool call and reports done', async (t) => {
  const server = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"hello.txt","content":"hi from agent"}' }), finishChunk('tool_calls')],
    [textChunk('Created hello.txt.'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await runCli(['--config', configPath, '--json', 'create hello.txt'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  const events = parseJSONL(result.stdout);
  const toolEnd = events.find((event) => event.type === 'tool_end');
  assert.ok(toolEnd && toolEnd.ok === true, JSON.stringify(events));
  assert.equal(events.find((event) => event.type === 'done').text, 'Created hello.txt.');
  assert.equal(readFileSync(join(dir, 'hello.txt'), 'utf8'), 'hi from agent');

  // The tool schema and the user message reached the provider.
  assert.ok(server.requests[0].tools.some((tool) => tool.function.name === 'write_file'));
  assert.ok(server.requests[0].tools.some((tool) => tool.function.name === 'fetch_url'), 'web tool is on by default');
  assert.equal(server.requests[1].messages.at(-1).role, 'tool');
});

test('one-shot denies approval-required actions without --yes', async (t) => {
  const server = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"protected.txt","content":"nope"}' }), finishChunk('tool_calls')],
    [textChunk('I could not write it.'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server, { files: { protectedPaths: ['protected.txt'] } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await runCli(['--config', configPath, '--json', 'write protected.txt'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  const events = parseJSONL(result.stdout);
  const approval = events.find((event) => event.type === 'approval');
  assert.equal(approval.approved, false);
  assert.equal(events.find((event) => event.type === 'tool_end').ok, false);
  assert.ok(!existsSync(join(dir, 'protected.txt')));
  assert.match(result.stderr, /--yes/);
});

test('--yes approves guarded actions', async (t) => {
  const server = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"protected.txt","content":"yes"}' }), finishChunk('tool_calls')],
    [textChunk('Written.'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server, { files: { protectedPaths: ['protected.txt'] } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await runCli(['--config', configPath, '--json', '--yes', 'write protected.txt'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'protected.txt'), 'utf8'), 'yes');
});

test('a repeated failing tool call stops the run with exit code 1', async (t) => {
  const server = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"../escape.txt","content":"x"}' }), finishChunk('tool_calls')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await runCli(['--config', configPath, '--json', 'escape'], { cwd: dir });
  assert.equal(result.code, 1);
  const events = parseJSONL(result.stdout);
  assert.equal(events.filter((event) => event.type === 'tool_end').length, 3);
  assert.match(events.find((event) => event.type === 'error').message, /3 times/);
  assert.equal(server.requests.length, 3);
});

test('human one-shot keeps tool traces off stdout', async (t) => {
  const server = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"quiet.txt","content":"shh"}' }), finishChunk('tool_calls')],
    [textChunk('Done quietly.'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await runCli(['--config', configPath, 'write quietly'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Done quietly.');
  assert.match(result.stderr, /\[tool\] write_file/);
});

test('--base-url and --model flags override the config file', async (t) => {
  const server = await startFakeProvider([[textChunk('Overridden.'), finishChunk('stop')]]);
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), 'basicagent-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    provider: { model: 'from-config' },
    skills: { paths: [] },
    memory: { enabled: false }
  }));

  const result = await runCli(['--config', configPath, '--json', '--base-url', server.baseUrl, '--model', 'from-flag', 'hello'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  const events = parseJSONL(result.stdout);
  assert.equal(events.find((event) => event.type === 'done').text, 'Overridden.');
  assert.equal(server.requests[0].model, 'from-flag');
});

test('--no-web removes fetch_url from the tool schema', async (t) => {
  const server = await startFakeProvider([[textChunk('No web here.'), finishChunk('stop')]]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await runCli(['--config', configPath, '--json', '--no-web', 'hello'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  const names = server.requests[0].tools.map((tool) => tool.function.name);
  assert.ok(!names.includes('fetch_url'), 'fetch_url must be absent');
  assert.ok(names.includes('read_file'), 'other tools remain');
});

test('--data-dir puts sessions and the audit log there', async (t) => {
  const server = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"hello.txt","content":"hi"}' }), finishChunk('tool_calls')],
    [textChunk('Done.'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server, { memory: { enabled: true } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'agent-data');

  const result = await runCli(['--config', configPath, '--data-dir', dataDir, '--json', 'hello'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(dataDir, 'last-session.txt')), 'session pointer lives in the data dir');
  assert.ok(existsSync(join(dataDir, 'audit.jsonl')), 'audit log lives in the data dir');
  assert.equal(readdirSync(join(dataDir, 'sessions')).filter((name) => name.endsWith('.jsonl')).length, 1);
});
