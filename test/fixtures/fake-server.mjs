// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// Fixtures for tests: a tiny OpenAI-compatible SSE server.
//
// Each entry of `script` is the response for one request, either:
//   - an array of SSE event objects (or raw strings), or
//   - { status, body } to return an HTTP error.
// A function script(body, index) may be used for dynamic responses.
//
// Events are deliberately written in two halves to exercise the client's
// chunk buffering.

import { createServer } from 'node:http';

export const textChunk = (text, finish = null) => ({
  choices: [{ index: 0, delta: { content: text }, finish_reason: finish }]
});

export const toolChunk = ({ index = 0, id, name, args }) => {
  const fn = {};
  if (name) fn.name = name;
  if (args) fn.arguments = args;
  const call = { index, function: fn };
  if (id) call.id = id;
  return { choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] };
};

export const finishChunk = (reason) => ({
  choices: [{ index: 0, delta: {}, finish_reason: reason }]
});

export async function startFakeProvider(script) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    requests.push(body);
    const index = requests.length - 1;
    const entry = typeof script === 'function' ? script(body, index) : script[Math.min(index, script.length - 1)];

    if (entry && !Array.isArray(entry)) {
      response.writeHead(entry.status ?? 500, { 'content-type': 'application/json' });
      response.end(JSON.stringify(entry.body ?? { error: 'fake failure' }));
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of entry ?? []) {
      const text = typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`;
      const middle = Math.floor(text.length / 2);
      response.write(text.slice(0, middle));
      response.write(text.slice(middle));
    }
    // Raw-string scripts control their own terminator.
    if (entry && entry.length && typeof entry[entry.length - 1] !== 'string') {
      response.write('data: [DONE]\n\n');
    }
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
