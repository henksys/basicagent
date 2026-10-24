// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider, textChunk, toolChunk, finishChunk } from './fixtures/fake-server.mjs';
import { loadConfig } from '../src/config.mjs';
import { startWebServer } from '../src/web/server.mjs';

const TOKEN = 'test-token';
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')}`;

async function setup(t, { baseUrl = 'http://127.0.0.1:9/v1', config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'basicagent-web-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.json');
  const raw = {
    provider: { baseUrl, model: 'fake-model', ...(config.provider || {}) },
    tools: config.tools || { files: { roots: [{ path: dir, access: 'rw' }] } },
    skills: { paths: [], ...(config.skills || {}) },
    memory: config.memory || { dir: join(dir, 'data') }
  };
  if (config.agent) raw.agent = config.agent;
  if (config.images) raw.images = config.images;
  writeFileSync(configPath, JSON.stringify(raw));

  const loaded = loadConfig({ flags: { config: configPath }, cwd: dir });
  const started = await startWebServer({ config: loaded, flags: { config: configPath }, cwd: dir, version: 'test', token: TOKEN, port: 0 });
  t.after(() => started.close());
  const base = `http://127.0.0.1:${started.port}`;
  const auth = { authorization: `Bearer ${TOKEN}` };

  async function json(path, options = {}) {
    const response = await fetch(base + path, {
      method: options.method ?? 'GET',
      headers: { ...auth, ...(options.headers || {}), ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  }

  async function stream(sessionId, message, { onEvent, images } = {}) {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message, ...(images ? { images } : {}) })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      return { status: response.status, events: [], data };
    }
    const events = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        events.push(event);
        if (onEvent) onEvent(event);
      }
    }
    return { status: response.status, events };
  }

  function rawRequest(options = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: started.port, path: '/', method: 'GET', ...options }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  return { dir, configPath, started, base, auth, json, stream, rawRequest };
}

// A provider that streams one delta and then never finishes, so a turn stays
// open until the client aborts it.
async function startHangingProvider(t) {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'thinking ' }, finish_reason: null }] })}\n\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return { baseUrl: `http://127.0.0.1:${port}/v1` };
}

test('auth, host and origin checks protect the API', async (t) => {
  const { base, auth } = await setup(t);

  assert.equal((await fetch(`${base}/api/status`)).status, 401, 'no token');
  assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer wrong' } })).status, 401, 'wrong token');
  assert.equal((await fetch(`${base}/api/status`, { headers: auth })).status, 200, 'valid token');

  const evilHost = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: new URL(base).port, path: '/api/status', headers: { host: 'evil.example', authorization: `Bearer ${TOKEN}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(evilHost, 403, 'DNS-rebinding host rejected');

  const evilOrigin = await fetch(`${base}/api/status`, { headers: { ...auth, origin: 'http://evil.example' } });
  assert.equal(evilOrigin.status, 403, 'cross-origin API request rejected');

  const sameOrigin = await fetch(`${base}/api/status`, { headers: { ...auth, origin: base } });
  assert.equal(sameOrigin.status, 200, 'same-origin request allowed');

  const staticNoAuth = await fetch(`${base}/`);
  assert.equal(staticNoAuth.status, 200, 'static files load without a token');
});

test('status and static files', async (t) => {
  const { base, auth } = await setup(t);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const html = await index.text();
  assert.match(html, /basicagent/);
  assert.match(html, /id="attach-image"/, 'the composer exposes image attachments');
  assert.match(html, /data-config="images\.enabled"/, 'the settings form exposes the image switch');
  assert.match(html, /id="audit-prune-weeks"/, 'the audit tab exposes the age selector');
  assert.match(html, /id="audit-prune"/, 'the audit tab exposes the prune button');

  assert.equal((await fetch(`${base}/app.css`)).status, 200);
  assert.equal((await fetch(`${base}/assets/css/tokens.css`)).status, 200);
  assert.equal((await fetch(`${base}/assets/fonts/MarcellusSC-Regular.ttf`)).status, 200);

  const { status, data } = await (async () => {
    const response = await fetch(`${base}/api/status`, { headers: auth });
    return { status: response.status, data: await response.json() };
  })();
  assert.equal(status, 200);
  assert.equal(data.model, 'fake-model');
  assert.equal(data.memoryEnabled, true);
  assert.equal(data.contextTokens, 24000);
  assert.equal(data.images.enabled, true);
  assert.equal(data.images.maxImages, 4);
  assert.equal(data.images.maxBytes, 5 * 1024 * 1024);
  assert.deepEqual(data.images.types, ['image/png', 'image/jpeg', 'image/webp']);
  assert.ok(data.tools.includes('write_file'));
  assert.ok(data.tools.includes('fetch_url'));
  assert.ok(data.skills.some((skill) => skill.name === 'basicagent'), 'bundled skill is visible');

  assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status, 404, 'path traversal blocked');
  assert.equal((await fetch(`${base}/api/nope`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
});

test('chat streams events, persists the session and lists it', async (t) => {
  const provider = await startFakeProvider([[textChunk('Hello from the fake.'), finishChunk('stop')]]);
  t.after(() => provider.close());
  const { dir, json, stream } = await setup(t, { baseUrl: provider.baseUrl });

  const session = await json('/api/sessions', { method: 'POST', body: {} });
  assert.equal(session.status, 200);
  assert.match(session.data.id, /^\d{14}-[0-9a-f]{4}$/);
  assert.ok(session.data.contextTokens > 0, 'even a new session has a system prompt and tools');

  const result = await stream(session.data.id, 'say hi');
  assert.equal(result.status, 200);
  const types = result.events.map((event) => event.type);
  assert.deepEqual(types, ['iteration', 'assistant_delta', 'context', 'done']);
  assert.ok(Number.isInteger(result.events[0].contextTokens) && result.events[0].contextTokens > 0, 'iterations carry the context size');
  assert.equal(result.events[1].text, 'Hello from the fake.');
  assert.equal(result.events[3].text, 'Hello from the fake.');

  const sessionFile = join(dir, 'data', 'sessions', `${session.data.id}.jsonl`);
  assert.ok(existsSync(sessionFile), 'session is persisted');
  const lines = readFileSync(sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((entry) => entry.role), ['user', 'assistant']);

  const list = await json('/api/sessions');
  assert.equal(list.data.memoryEnabled, true);
  assert.equal(list.data.sessions.length, 1);
  assert.equal(list.data.sessions[0].id, session.data.id);
  assert.equal(list.data.sessions[0].messages, 2);
  assert.equal(list.data.sessions[0].title, 'say hi');

  const transcript = await json(`/api/sessions/${session.data.id}`);
  assert.equal(transcript.data.messages.length, 2);
  assert.equal(transcript.data.messages[0].role, 'user');
  assert.ok(transcript.data.messages[0].ts, 'transcript includes timestamps');
  assert.ok(transcript.data.contextTokens > 0, 'stored sessions report a context size');

  const missing = await json('/api/chat', { method: 'POST', body: { message: 'hi' } });
  assert.equal(missing.status, 400);
  const empty = await json('/api/chat', { method: 'POST', body: { sessionId: session.data.id, message: '   ' } });
  assert.equal(empty.status, 400);
});

test('web chat accepts image data URLs and stores only a marker', async (t) => {
  const provider = await startFakeProvider([
    [textChunk('I see a tiny image.'), finishChunk('stop')],
    [textChunk('Image only.'), finishChunk('stop')]
  ]);
  t.after(() => provider.close());
  const { dir, json, stream } = await setup(t, { baseUrl: provider.baseUrl });
  const session = await json('/api/sessions', { method: 'POST', body: {} });

  const withText = await stream(session.data.id, 'what is this', {
    images: [{ name: 'shot.png', dataUrl: PNG_DATA_URL }]
  });
  assert.equal(withText.status, 200, JSON.stringify(withText.data));
  const user = provider.requests[0].messages.find((message) => message.role === 'user');
  assert.ok(Array.isArray(user.content));
  assert.deepEqual(user.content[0], { type: 'text', text: 'what is this' });
  assert.match(user.content[1].image_url.url, /^data:image\/png;base64,/);

  const imageOnly = await stream(session.data.id, '', {
    images: [{ name: 'only.webp', dataUrl: `data:image/webp;base64,${Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(4)]).toString('base64')}` }]
  });
  assert.equal(imageOnly.status, 200, JSON.stringify(imageOnly.data));
  const secondUser = provider.requests[1].messages.filter((message) => message.role === 'user').at(-1);
  assert.equal(secondUser.content.length, 1);
  assert.equal(secondUser.content[0].type, 'image_url');

  const lines = readFileSync(join(dir, 'data', 'sessions', `${session.data.id}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].content, 'what is this\n[image: shot.png]');
  assert.ok(!readFileSync(join(dir, 'data', 'sessions', `${session.data.id}.jsonl`), 'utf8').includes('base64'), 'base64 is never persisted');
});

test('web chat rejects unsupported, oversized and excessive images', async (t) => {
  const provider = await startFakeProvider([[textChunk('ok'), finishChunk('stop')]]);
  t.after(() => provider.close());
  const { json } = await setup(t, {
    baseUrl: provider.baseUrl,
    config: { images: { maxBytes: 1024 } }
  });
  const session = await json('/api/sessions', { method: 'POST', body: {} });

  const unsupported = await json('/api/chat', {
    method: 'POST',
    body: { sessionId: session.data.id, message: 'look', images: [{ name: 'x.gif', dataUrl: 'data:image/gif;base64,R0lGODlh' }] }
  });
  assert.equal(unsupported.status, 400);
  assert.match(unsupported.data.error, /PNG, JPEG or WebP/);

  const big = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(2000)]);
  const oversized = await json('/api/chat', {
    method: 'POST',
    body: { sessionId: session.data.id, message: 'look', images: [{ name: 'big.png', dataUrl: `data:image/png;base64,${big.toString('base64')}` }] }
  });
  assert.equal(oversized.status, 413);
  assert.match(oversized.data.error, /limit is 1.0 KiB/);

  const tooMany = await json('/api/chat', {
    method: 'POST',
    body: {
      sessionId: session.data.id,
      message: 'look',
      images: Array.from({ length: 5 }, (_, index) => ({ name: `${index}.png`, dataUrl: PNG_DATA_URL }))
    }
  });
  assert.equal(tooMany.status, 413);
  assert.match(tooMany.data.error, /Too many images/);
  assert.equal(provider.requests.length, 0, 'invalid uploads never reach the provider');
});

test('compaction is streamed and persisted with the transcript', async (t) => {
  const provider = await startFakeProvider([
    [textChunk('Old answer.'), finishChunk('stop')],
    [toolChunk({ id: 'call_read', name: 'read_file', args: JSON.stringify({ path: 'big.txt' }) }), finishChunk('tool_calls')],
    [textChunk('SUMMARY OF THE OLD TURN'), finishChunk('stop')],
    [textChunk('Done.'), finishChunk('stop')],
    [textChunk('Resumed.'), finishChunk('stop')]
  ]);
  t.after(() => provider.close());
  const { dir, json, stream, started } = await setup(t, {
    baseUrl: provider.baseUrl,
    config: { agent: { contextTokens: 4000, compact: 'summarize', compactAt: 0.8, maxResultChars: 24000 } }
  });
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(20000));

  const session = await json('/api/sessions', { method: 'POST', body: {} });
  const first = await stream(session.data.id, 'old question');
  assert.equal(first.status, 200);
  assert.ok(!first.events.some((event) => event.type === 'compaction'), 'the first turn is small');

  const second = await stream(session.data.id, 'new question');
  assert.equal(second.status, 200);
  const compaction = second.events.find((event) => event.type === 'compaction');
  assert.ok(compaction, 'a compaction event is streamed');
  assert.equal(compaction.summary, 'SUMMARY OF THE OLD TURN');
  assert.ok(second.events.some((event) => event.type === 'context'));

  const file = join(dir, 'data', 'sessions', `${session.data.id}.jsonl`);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const summaryLine = lines.find((entry) => entry.kind === 'summary');
  assert.ok(summaryLine, 'the summary is persisted in the session');
  assert.equal(summaryLine.summary, 'SUMMARY OF THE OLD TURN');

  const transcript = await json(`/api/sessions/${session.data.id}`);
  assert.equal(transcript.status, 200);
  const marker = transcript.data.messages.find((message) => message.kind === 'compaction');
  assert.ok(marker, 'the transcript carries a compaction marker');
  assert.equal(marker.summary, 'SUMMARY OF THE OLD TURN');
  assert.ok(transcript.data.contextTokens > 0);

  // Drop the live session and reopen it from disk: the summary must be
  // replayed, and the turns it replaced must not be sent to the provider.
  started.manager.sessions.delete(session.data.id);
  const reopened = await json('/api/sessions', { method: 'POST', body: { id: session.data.id } });
  assert.equal(reopened.status, 200);
  assert.ok(reopened.data.messages.some((message) => message.kind === 'compaction'));
  assert.ok(reopened.data.contextTokens > 0);

  const third = await stream(session.data.id, 'again');
  assert.equal(third.status, 200);
  const resumedRequest = provider.requests.at(-1);
  assert.match(resumedRequest.messages[0].content, /Earlier conversation summary/);
  assert.match(resumedRequest.messages[0].content, /SUMMARY OF THE OLD TURN/);
  assert.ok(!resumedRequest.messages.some((message) => message.content === 'old question'), 'the summarized turn is not resent');
});

test('sessions can be deleted from the Memory API', async (t) => {
  const provider = await startFakeProvider([[textChunk('Hi.'), finishChunk('stop')]]);
  t.after(() => provider.close());
  const { dir, json, stream } = await setup(t, { baseUrl: provider.baseUrl });

  const first = await json('/api/sessions', { method: 'POST', body: { id: 'session-one' } });
  const second = await json('/api/sessions', { method: 'POST', body: { id: 'session-two' } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  await stream(first.data.id, 'remember this');
  assert.equal((await json('/api/sessions')).data.sessions.length, 2);

  const deleted = await json(`/api/sessions/${first.data.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.removed, true);
  assert.equal(deleted.data.lastSessionId, second.data.id, 'the continue pointer moves to the remaining session');

  const list = await json('/api/sessions');
  assert.deepEqual(list.data.sessions.map((session) => session.id), [second.data.id]);
  assert.deepEqual((await json(`/api/sessions/${first.data.id}`)).data.messages, [], 'transcript is gone');
  assert.ok(!existsSync(join(dir, 'data', 'sessions', `${first.data.id}.jsonl`)), 'file is gone');

  const again = await json(`/api/sessions/${first.data.id}`, { method: 'DELETE' });
  assert.equal(again.status, 200);
  assert.equal(again.data.removed, false);
  assert.equal((await json('/api/sessions/', { method: 'DELETE' })).status, 404);
});

test('tool calls are executed, audited and streamed over the API', async (t) => {
  const provider = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"hello.txt","content":"hi from web"}' }), finishChunk('tool_calls')],
    [textChunk('Created hello.txt.'), finishChunk('stop')]
  ]);
  t.after(() => provider.close());
  const { dir, json, stream } = await setup(t, { baseUrl: provider.baseUrl });

  const session = await json('/api/sessions', { method: 'POST', body: {} });
  const result = await stream(session.data.id, 'create hello.txt');
  const toolEnd = result.events.find((event) => event.type === 'tool_end');
  assert.ok(toolEnd, 'tool_end event present');
  assert.equal(toolEnd.name, 'write_file');
  assert.equal(toolEnd.ok, true);
  assert.equal(typeof toolEnd.durationMs, 'number');
  assert.equal(readFileSync(join(dir, 'hello.txt'), 'utf8'), 'hi from web');

  const auditPath = join(dir, 'data', 'audit.jsonl');
  assert.ok(existsSync(auditPath), 'audit log written');
  const entry = JSON.parse(readFileSync(auditPath, 'utf8').trim().split('\n')[0]);
  assert.equal(entry.tool, 'write_file');
  assert.equal(entry.ok, true);

  const audit = await json('/api/audit');
  assert.equal(audit.status, 200);
  assert.equal(audit.data.total, 1);
  assert.equal(audit.data.entries[0].tool, 'write_file');
  const filtered = await json('/api/audit?tool=write_file&ok=true');
  assert.equal(filtered.data.total, 1);
  const failed = await json('/api/audit?ok=false');
  assert.equal(failed.data.total, 0);
});

test('audit entries can be pruned by age', async (t) => {
  const { dir, json } = await setup(t);
  const now = Date.now();
  const old = new Date(now - 10 * 7 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(
    join(dir, 'data', 'audit.jsonl'),
    [
      JSON.stringify({ ts: old, tool: 'old_tool', ok: true, durationMs: 1 }),
      JSON.stringify({ ts: recent, tool: 'recent_tool', ok: true, durationMs: 1 })
    ].join('\n') + '\n'
  );

  for (const query of ['', '?olderThanWeeks=0', '?olderThanWeeks=10', '?olderThanWeeks=nope']) {
    const invalid = await json(`/api/audit${query}`, { method: 'DELETE' });
    assert.equal(invalid.status, 400, query || 'missing olderThanWeeks');
  }

  const pruned = await json('/api/audit?olderThanWeeks=4', { method: 'DELETE' });
  assert.equal(pruned.status, 200, JSON.stringify(pruned.data));
  assert.equal(pruned.data.olderThanWeeks, 4);
  assert.equal(pruned.data.removed, 1);
  assert.equal(pruned.data.kept, 1);
  assert.ok(pruned.data.cutoff);

  const audit = await json('/api/audit');
  assert.equal(audit.data.total, 1);
  assert.equal(audit.data.entries[0].tool, 'recent_tool');
});

test('approval pauses the turn until the browser approves', async (t) => {
  const provider = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"protected.txt","content":"approved"}' }), finishChunk('tool_calls')],
    [textChunk('Written.'), finishChunk('stop')]
  ]);
  t.after(() => provider.close());
  const { dir, json, stream } = await setup(t, {
    baseUrl: provider.baseUrl,
    config: { tools: { files: { roots: [{ path: '.', access: 'rw' }], protectedPaths: ['protected.txt'] } } }
  });

  const session = await json('/api/sessions', { method: 'POST', body: {} });
  let approvalResolve;
  const approvalSeen = new Promise((resolve) => { approvalResolve = resolve; });
  const streamPromise = stream(session.data.id, 'write protected.txt', {
    onEvent: (event) => {
      if (event.type === 'approval') approvalResolve(event);
    }
  });

  const approval = await approvalSeen;
  assert.match(approval.description, /protected\.txt/);
  assert.equal(typeof approval.id, 'string');

  const answer = await json(`/api/approvals/${approval.id}`, { method: 'POST', body: { approved: true } });
  assert.equal(answer.status, 200);
  assert.equal((await json(`/api/approvals/${approval.id}`, { method: 'POST', body: { approved: true } })).status, 404, 'approvals cannot be answered twice');

  const result = await streamPromise;
  assert.ok(result.events.some((event) => event.type === 'approval_result' && event.approved === true));
  const toolEnd = result.events.find((event) => event.type === 'tool_end');
  assert.equal(toolEnd.ok, true);
  assert.equal(readFileSync(join(dir, 'protected.txt'), 'utf8'), 'approved');
});

test('denied approval blocks the guarded write', async (t) => {
  const provider = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"protected.txt","content":"nope"}' }), finishChunk('tool_calls')],
    [textChunk('I did not write it.'), finishChunk('stop')]
  ]);
  t.after(() => provider.close());
  const { dir, json, stream } = await setup(t, {
    baseUrl: provider.baseUrl,
    config: { tools: { files: { roots: [{ path: '.', access: 'rw' }], protectedPaths: ['protected.txt'] } } }
  });

  const session = await json('/api/sessions', { method: 'POST', body: {} });
  let approvalResolve;
  const approvalSeen = new Promise((resolve) => { approvalResolve = resolve; });
  const streamPromise = stream(session.data.id, 'write protected.txt', {
    onEvent: (event) => {
      if (event.type === 'approval') approvalResolve(event);
    }
  });
  const approval = await approvalSeen;
  await json(`/api/approvals/${approval.id}`, { method: 'POST', body: { approved: false } });

  const result = await streamPromise;
  const toolEnd = result.events.find((event) => event.type === 'tool_end');
  assert.equal(toolEnd.ok, false);
  assert.ok(!existsSync(join(dir, 'protected.txt')), 'file is not written');
  assert.equal((await json('/api/approvals/does-not-exist', { method: 'POST', body: { approved: true } })).status, 404);
});

test('a running turn reports busy and can be aborted', async (t) => {
  const provider = await startHangingProvider(t);
  const { json, stream } = await setup(t, { baseUrl: provider.baseUrl });

  const session = await json('/api/sessions', { method: 'POST', body: {} });
  let iterationResolve;
  const iterationSeen = new Promise((resolve) => { iterationResolve = resolve; });
  const streamPromise = stream(session.data.id, 'hang', {
    onEvent: (event) => {
      if (event.type === 'iteration') iterationResolve();
    }
  });

  await iterationSeen;
  const busy = await json('/api/chat', { method: 'POST', body: { sessionId: session.data.id, message: 'again' } });
  assert.equal(busy.status, 409);

  const busyToggle = await json(`/api/sessions/${session.data.id}/read-only`, { method: 'POST', body: { enabled: true } });
  assert.equal(busyToggle.status, 409, 'cannot change read-only mode while a turn is running');

  const deleteBusy = await json(`/api/sessions/${session.data.id}`, { method: 'DELETE' });
  assert.equal(deleteBusy.status, 409, 'cannot delete while a turn is running');

  const pruneBusy = await json('/api/audit?olderThanWeeks=4', { method: 'DELETE' });
  assert.equal(pruneBusy.status, 409, 'cannot prune the audit log while a turn is running');

  const abort = await json('/api/chat/abort', { method: 'POST', body: { sessionId: session.data.id } });
  assert.equal(abort.status, 200);
  const result = await streamPromise;
  assert.ok(result.events.some((event) => event.type === 'aborted'), 'aborted event sent');

  const deleted = await json(`/api/sessions/${session.data.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.removed, true);
  assert.equal(deleted.data.lastSessionId, null);
});

test('read-only sessions hide writers and can be toggled per conversation', async (t) => {
  const server = await startFakeProvider([
    [toolChunk({ index: 0, id: 'c1', name: 'write_file', args: '{"path":"readonly-toggle.txt","content":"one"}' }), finishChunk('tool_calls')],
    [textChunk('The write was refused.'), finishChunk('stop')],
    [toolChunk({ index: 0, id: 'c2', name: 'write_file', args: '{"path":"readonly-toggle.txt","content":"two"}' }), finishChunk('tool_calls')],
    [textChunk('The write succeeded.'), finishChunk('stop')]
  ]);
  t.after(() => server.close());
  const { dir, json, stream } = await setup(t, {
    baseUrl: server.baseUrl,
    config: { tools: { readOnly: true, files: { roots: [{ path: '.', access: 'rw' }] } } }
  });

  const status = await json('/api/status');
  assert.equal(status.data.readOnly, true, 'status exposes the configured default');

  const config = await json('/api/config');
  assert.equal(config.data.effective.tools.readOnly, true);
  assert.ok(config.data.effective.tools.shell.readOnlyAllowlist.includes('date'), 'effective defaults are available to the settings form');
  assert.equal(config.data.effective.agent.toolCircuitBreaker.failureThreshold, 3);

  const session = await json('/api/sessions', { method: 'POST', body: {} });
  assert.equal(session.data.readOnly, true, 'new sessions inherit the default');
  const id = session.data.id;

  const first = await stream(id, 'try to write');
  const firstTool = first.events.find((event) => event.type === 'tool_end');
  assert.equal(firstTool.ok, false);
  assert.match(JSON.stringify(firstTool.result), /not available in read-only mode/);
  assert.ok(!existsSync(join(dir, 'readonly-toggle.txt')), 'the refused write created nothing');
  assert.ok(!server.requests[0].tools.some((tool) => tool.function.name === 'write_file'), 'write_file is not advertised');

  const toggled = await json(`/api/sessions/${id}/read-only`, { method: 'POST', body: { enabled: false } });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.data.readOnly, false);
  assert.ok(Number.isInteger(toggled.data.contextTokens));

  const second = await stream(id, 'write now');
  const secondTool = second.events.find((event) => event.type === 'tool_end');
  assert.equal(secondTool.ok, true);
  assert.ok(server.requests[2].tools.some((tool) => tool.function.name === 'write_file'), 'write_file is advertised again');
  assert.equal(readFileSync(join(dir, 'readonly-toggle.txt'), 'utf8'), 'two');
});

test('saving settings keeps existing conversation modes and applies the default to new ones', async (t) => {
  const { json } = await setup(t, {
    config: { tools: { readOnly: true, files: { roots: [{ path: '.', access: 'rw' }] } } }
  });

  const session = await json('/api/sessions', { method: 'POST', body: {} });
  assert.equal(session.data.readOnly, true);
  const toggled = await json(`/api/sessions/${session.data.id}/read-only`, { method: 'POST', body: { enabled: false } });
  assert.equal(toggled.data.readOnly, false);

  const current = await json('/api/config');
  const saved = await json('/api/config', { method: 'PUT', body: { config: current.data.raw } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const existing = await json(`/api/sessions/${session.data.id}`);
  assert.equal(existing.data.readOnly, false, 'the live conversation keeps its explicit toggle');

  const fresh = await json('/api/sessions', { method: 'POST', body: {} });
  assert.equal(fresh.data.readOnly, true, 'new conversations use the saved default');
});

test('facts can be listed, added and removed', async (t) => {
  const { dir, json } = await setup(t);

  assert.deepEqual((await json('/api/facts')).data.facts, []);

  const added = await json('/api/facts', { method: 'PUT', body: { key: 'editor', value: 'nvim' } });
  assert.equal(added.status, 200);
  assert.equal(added.data.fact.key, 'editor');
  assert.equal((await json('/api/facts', { method: 'PUT', body: { key: 'editor' } })).status, 400);

  const listed = await json('/api/facts');
  assert.equal(listed.data.facts.length, 1);
  assert.equal(listed.data.facts[0].value, 'nvim');
  assert.ok(existsSync(join(dir, 'data', 'facts.jsonl')));

  const removed = await json('/api/facts/editor', { method: 'DELETE' });
  assert.equal(removed.data.removed, true);
  assert.equal((await json('/api/facts/editor', { method: 'DELETE' })).data.removed, false);
  assert.deepEqual((await json('/api/facts')).data.facts, []);
});

test('config can be read, validated, saved and reloaded with key preservation', async (t) => {
  const { dir, json } = await setup(t, { config: { provider: { apiKey: 'sekret-key-1234567890' } } });
  const dataDir = join(dir, 'data');

  const initial = await json('/api/config');
  assert.equal(initial.data.found, true);
  assert.equal(initial.data.apiKeySet, true);
  assert.equal(initial.data.raw.provider.apiKey, '', 'the raw key is never sent');
  assert.match(initial.data.effective.provider.apiKey, /^sek.../, 'the effective key is masked');
  assert.ok(!initial.data.effective.provider.apiKey.includes('1234567890'), 'the full key is never sent');
  assert.ok(initial.data.path.endsWith('config.json'));

  const invalid = await json('/api/config', { method: 'PUT', body: { config: { provider: { temperature: 9 } } } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /temperature/);

  const saved = await json('/api/config', {
    method: 'PUT',
    body: { config: { provider: { model: 'new-model', apiKey: '' }, skills: { paths: [] }, memory: { dir: dataDir } } }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.effective.provider.model, 'new-model');

  const rawOnDisk = JSON.parse(readFileSync(initial.data.path, 'utf8'));
  assert.equal(rawOnDisk.provider.model, 'new-model');
  assert.equal(rawOnDisk.provider.apiKey, 'sekret-key-1234567890', 'empty key keeps the stored one');
  assert.equal(statSync(initial.data.path).mode & 0o777, 0o600);

  const status = await json('/api/status');
  assert.equal(status.data.model, 'new-model', 'the server reloaded the config');

  const cleared = await json('/api/config', {
    method: 'PUT',
    body: { config: { provider: { apiKey: null }, skills: { paths: [] }, memory: { dir: dataDir } } }
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.apiKeySet, false);
  assert.ok(!('apiKey' in JSON.parse(readFileSync(initial.data.path, 'utf8')).provider), 'null clears the key');
});

test('memory disabled turns off facts, sessions and the audit API', async (t) => {
  const provider = await startFakeProvider([[textChunk('No memory here.'), finishChunk('stop')]]);
  t.after(() => provider.close());
  const { json, stream } = await setup(t, { baseUrl: provider.baseUrl, config: { memory: { enabled: false } } });

  const status = await json('/api/status');
  assert.equal(status.data.memoryEnabled, false);
  assert.equal(status.data.dataDir, null);

  assert.equal((await json('/api/facts')).status, 400);
  assert.equal((await json('/api/audit')).status, 400);
  assert.equal((await json('/api/audit?olderThanWeeks=4', { method: 'DELETE' })).status, 400);
  assert.equal((await json('/api/sessions/whatever', { method: 'DELETE' })).status, 400);
  const sessions = await json('/api/sessions');
  assert.deepEqual(sessions.data, { memoryEnabled: false, sessions: [] });

  const session = await json('/api/sessions', { method: 'POST', body: {} });
  assert.deepEqual(session.data.messages, []);
  const result = await stream(session.data.id, 'hello');
  assert.ok(result.events.some((event) => event.type === 'done'));
});
