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

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('one-shot --image sends an OpenAI image content part', async (t) => {
  const server = await startFakeProvider([
    [textChunk('It is a screenshot.'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'shot.png'), pngBytes);

  const result = await runCli(['--config', configPath, '--json', '--image', 'shot.png', 'what is this'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  const user = server.requests[0].messages.find((message) => message.role === 'user');
  assert.ok(Array.isArray(user.content));
  assert.deepEqual(user.content[0], { type: 'text', text: 'what is this' });
  assert.equal(user.content[1].type, 'image_url');
  assert.match(user.content[1].image_url.url, /^data:image\/png;base64,/);
});

test('one-shot --image rejects an oversized image before calling the provider', async (t) => {
  const server = await startFakeProvider([
    [textChunk('should not run'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server, { images: { maxBytes: 1024 } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'big.png'), Buffer.concat([pngBytes, Buffer.alloc(2000)]));

  const result = await runCli(['--config', configPath, '--json', '--image', 'big.png', 'look'], { cwd: dir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /limit is 1\.0 KiB/);
  assert.equal(server.requests.length, 0, 'the provider was never called');
});

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

test('compaction persists and is replayed by --continue', async (t) => {
  const server = await startFakeProvider([
    [textChunk('Old answer.'), finishChunk('stop')],
    [toolChunk({ index: 0, id: 'c1', name: 'read_file', args: '{"path":"big.txt"}' }), finishChunk('tool_calls')],
    [textChunk('SUMMARY OF THE OLD TURN'), finishChunk('stop')],
    [textChunk('Done.'), finishChunk('stop')],
    [textChunk('Resumed.'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server, {
    memory: { enabled: true, dir: './data' },
    agent: { maxIterations: 25, contextTokens: 4000, compact: 'summarize', compactAt: 0.8, maxResultChars: 24000 }
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(20000));

  const first = await runCli(['--config', configPath, '--json', 'old question'], { cwd: dir });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(parseJSONL(first.stdout).find((event) => event.type === 'done').text, 'Old answer.');

  const second = await runCli(['--config', configPath, '--json', '--continue', 'read big.txt'], { cwd: dir });
  assert.equal(second.code, 0, second.stderr);
  const secondEvents = parseJSONL(second.stdout);
  const compaction = secondEvents.find((event) => event.type === 'compaction');
  assert.ok(compaction, JSON.stringify(secondEvents));
  assert.equal(compaction.summary, 'SUMMARY OF THE OLD TURN');
  assert.equal(parseJSONL(second.stdout).find((event) => event.type === 'done').text, 'Done.');

  const sessionDir = join(dir, 'data', 'sessions');
  const sessionFile = join(sessionDir, readdirSync(sessionDir)[0]);
  const lines = readFileSync(sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const summaryLine = lines.find((entry) => entry.kind === 'summary');
  assert.ok(summaryLine, 'the summary is stored in the CLI session');
  assert.deepEqual(summaryLine.recent, [{ role: 'user', content: 'read big.txt' }]);

  const third = await runCli(['--config', configPath, '--json', '--continue', 'again'], { cwd: dir });
  assert.equal(third.code, 0, third.stderr);
  assert.equal(parseJSONL(third.stdout).find((event) => event.type === 'done').text, 'Resumed.');

  // The resumed request carries the summary and not the turns it replaced.
  const resumedRequest = server.requests.at(-1);
  assert.match(resumedRequest.messages[0].content, /Earlier conversation summary/);
  assert.match(resumedRequest.messages[0].content, /SUMMARY OF THE OLD TURN/);
  assert.ok(!resumedRequest.messages.some((message) => message.content === 'old question'), 'old turn is not resent');
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

test('--read-only hides file writers and blocks a write attempt', async (t) => {
  const server = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"blocked.txt","content":"x"}' }), finishChunk('tool_calls')],
    [textChunk('Read-only mode refused the write.'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await runCli(['--config', configPath, '--json', '--read-only', 'write blocked.txt'], { cwd: dir });
  assert.equal(result.code, 0, result.stderr);
  const names = server.requests[0].tools.map((tool) => tool.function.name);
  assert.ok(!names.includes('write_file'), 'write_file must be absent from the schema');
  assert.ok(names.includes('read_file'), 'read tools remain');
  const toolEnd = parseJSONL(result.stdout).find((event) => event.type === 'tool_end');
  assert.equal(toolEnd.ok, false);
  assert.match(JSON.stringify(toolEnd.result), /not available in read-only mode/);
  assert.ok(!existsSync(join(dir, 'blocked.txt')));
});

test('--no-read-only overrides a config that enables read-only mode', async (t) => {
  const server = await startFakeProvider([
    [textChunk('Configured read-only.'), finishChunk('stop')],
    [textChunk('Overridden writable.'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, configPath } = makeWorkspace(server);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  raw.tools.readOnly = true;
  writeFileSync(configPath, JSON.stringify(raw));

  const configured = await runCli(['--config', configPath, '--json', 'hello'], { cwd: dir });
  assert.equal(configured.code, 0, configured.stderr);
  assert.ok(!server.requests[0].tools.some((tool) => tool.function.name === 'write_file'));

  const overridden = await runCli(['--config', configPath, '--json', '--no-read-only', 'hello'], { cwd: dir });
  assert.equal(overridden.code, 0, overridden.stderr);
  assert.ok(server.requests[1].tools.some((tool) => tool.function.name === 'write_file'));
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
