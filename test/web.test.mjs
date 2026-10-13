// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { webTools, isPrivateAddress, decodeEntities, htmlToText, detectCharset, domainMatches, pinnedLookup } from '../src/tools/web.mjs';

function webConfig(overrides = {}) {
  return {
    tools: {
      web: {
        enabled: true,
        approval: 'never',
        timeoutMs: 5000,
        maxRawBytes: 512000,
        maxBytes: 24000,
        maxRedirects: 5,
        allowPrivate: true,
        denyDomains: [],
        allowDomains: [],
        userAgent: '',
        ...overrides
      }
    }
  };
}

function tool(config = webConfig()) {
  return webTools({ config })[0];
}

const ctx = { approve: async () => true };

// A local HTTP server. Tests use allowPrivate: true to reach it.
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    })
  };
}

const html = (body) => ({ 'content-type': 'text/html; charset=utf-8' });

test('the tool is omitted entirely when disabled', () => {
  assert.deepEqual(webTools({ config: webConfig({ enabled: false }) }), []);
});

test('fetches and sanitizes HTML', async (t) => {
  const server = await serve((request, response) => {
    response.writeHead(200, html());
    response.end(`<!doctype html><html><head><title>t</title><script>alert(1)</script>
      <style>body{color:red}</style></head><body>
      <nav>navigation</nav>
      <main><h1>Heading</h1><p>First &amp; second.</p>
      <p>Entity: &amp;lt; stays, &#233; decodes.</p>
      <ul><li>one</li><li>two</li></ul></main>
      <footer>footer text</footer></body></html>`);
  });
  t.after(() => server.close());

  const result = await tool().run({ url: `${server.origin}/` }, ctx);
  assert.equal(result.status, 200);
  assert.match(result.text, /# Heading/);
  assert.match(result.text, /First & second\./);
  assert.match(result.text, /Entity: &lt; stays, é decodes\./);
  assert.match(result.text, /- one\n- two/);
  assert.doesNotMatch(result.text, /navigation/);
  assert.doesNotMatch(result.text, /footer text/);
  assert.doesNotMatch(result.text, /alert\(1\)/);
  assert.doesNotMatch(result.text, /color:red/);
  assert.equal(result.truncated, false);
});

test('returns plain text and JSON unchanged', async (t) => {
  const server = await serve((request, response) => {
    if (request.url === '/plain') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('just text');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"a": 1}');
  });
  t.after(() => server.close());

  const plain = await tool().run({ url: `${server.origin}/plain` }, ctx);
  assert.equal(plain.text, 'just text');
  const json = await tool().run({ url: `${server.origin}/json` }, ctx);
  assert.equal(json.text, '{"a": 1}');
});

test('decodes iso-8859-1 from the header and windows-1252 from the meta tag', async (t) => {
  const server = await serve((request, response) => {
    if (request.url === '/header') {
      response.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      response.end(Buffer.concat([Buffer.from('<p>caf'), Buffer.from([0xe9]), Buffer.from('</p>')]));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(Buffer.concat([
      Buffer.from('<html><body><meta charset="windows-1252"><p>quote'),
      Buffer.from([0x92]),
      Buffer.from('</p></body></html>')
    ]));
  });
  t.after(() => server.close());

  const header = await tool().run({ url: `${server.origin}/header` }, ctx);
  assert.match(header.text, /café/);
  const meta = await tool().run({ url: `${server.origin}/meta` }, ctx);
  assert.match(meta.text, /quote\u2019/);
});

test('truncates the sanitized text and flags it', async (t) => {
  const server = await serve((request, response) => {
    response.writeHead(200, html());
    response.end(`<p>${'word '.repeat(500)}</p>`);
  });
  t.after(() => server.close());

  const result = await tool(webConfig({ maxBytes: 120 })).run({ url: `${server.origin}/` }, ctx);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 120);
});

test('truncates huge raw bodies before sanitizing', async (t) => {
  const server = await serve((request, response) => {
    response.writeHead(200, html());
    response.end(`<p>${'x'.repeat(50000)}</p>`);
  });
  t.after(() => server.close());

  const result = await tool(webConfig({ maxRawBytes: 200 })).run({ url: `${server.origin}/` }, ctx);
  assert.equal(result.truncated, true);
});

test('follows redirects and reports the final URL', async (t) => {
  const server = await serve((request, response) => {
    if (request.url === '/a') {
      response.writeHead(302, { location: '/b' });
      response.end();
      return;
    }
    response.writeHead(200, html());
    response.end('<p>arrived</p>');
  });
  t.after(() => server.close());

  const result = await tool().run({ url: `${server.origin}/a` }, ctx);
  assert.match(result.text, /arrived/);
  assert.equal(result.finalUrl, `${server.origin}/b`);
});

test('refuses too many redirects', async (t) => {
  const server = await serve((request, response) => {
    const step = Number(request.url.slice(1) || 0);
    response.writeHead(302, { location: `/${step + 1}` });
    response.end();
  });
  t.after(() => server.close());

  await assert.rejects(() => tool(webConfig({ maxRedirects: 2 })).run({ url: `${server.origin}/0` }, ctx), /Too many redirects/);
});

test('re-checks domain policy on redirect targets', async (t) => {
  const server = await serve((request, response) => {
    response.writeHead(302, { location: 'http://blocked.example/' });
    response.end();
  });
  t.after(() => server.close());

  await assert.rejects(
    () => tool(webConfig({ denyDomains: ['blocked.example'] })).run({ url: `${server.origin}/` }, ctx),
    /deny list/
  );
});

test('blocks private and reserved addresses by default', async () => {
  const blocked = tool(webConfig({ allowPrivate: false }));
  await assert.rejects(() => blocked.run({ url: 'http://127.0.0.1:9/' }, ctx), /private or reserved/);
  await assert.rejects(() => blocked.run({ url: 'http://[::1]:9/' }, ctx), /private or reserved/);
  await assert.rejects(() => blocked.run({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx), /private or reserved/);
  await assert.rejects(() => blocked.run({ url: 'http://localhost:9/' }, ctx), /Blocked host/);
});

test('domain allow and deny lists work without network access', async () => {
  await assert.rejects(
    () => tool(webConfig({ allowPrivate: false, denyDomains: ['example.com'] })).run({ url: 'http://example.com/' }, ctx),
    /deny list/
  );
  await assert.rejects(
    () => tool(webConfig({ allowDomains: ['only.test'] })).run({ url: 'http://example.com/' }, ctx),
    /allow list/
  );
});

test('rejects unsupported content types and HTTP errors', async (t) => {
  const server = await serve((request, response) => {
    if (request.url === '/blob') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end('binary');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('nope');
  });
  t.after(() => server.close());

  await assert.rejects(() => tool().run({ url: `${server.origin}/blob` }, ctx), /Unsupported content type/);
  await assert.rejects(() => tool().run({ url: `${server.origin}/missing` }, ctx), /HTTP 404/);
});

test('times out and leaves no hanging request', async (t) => {
  const server = await serve((request, response) => {
    setTimeout(() => {
      response.writeHead(200, html());
      response.end('<p>late</p>');
    }, 500).unref();
  });
  t.after(() => server.close());

  await assert.rejects(() => tool(webConfig({ timeoutMs: 80 })).run({ url: `${server.origin}/` }, ctx), /timed out/);
});

test('approval: always can deny a fetch', async () => {
  const denying = { approve: async () => false };
  await assert.rejects(
    () => tool(webConfig({ approval: 'always' })).run({ url: 'http://example.com/' }, denying),
    /denied by user/
  );
});

test('rejects malformed URLs', async () => {
  await assert.rejects(() => tool().run({ url: 'file:///etc/passwd' }, ctx), /Only http\(s\)/);
  await assert.rejects(() => tool().run({ url: 'http://user:pass@example.com/' }, ctx), /credentials/);
  await assert.rejects(() => tool().run({ url: '' }, ctx), /non-empty "url"/);
});

test('isPrivateAddress covers the important ranges', () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be blocked`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`);
  }
});

test('isPrivateAddress blocks non-canonical and v4-in-v6 forms', () => {
  for (const ip of [
    '0:0:0:0:0:0:0:1',          // loopback, expanded
    '0:0:0:0:0:0:0:0',          // unspecified, expanded
    '::7f00:1',                 // IPv4-compatible loopback
    '::ffff:0:127.0.0.1',       // IPv4-translated loopback
    '64:ff9b::7f00:1',          // NAT64 well-known prefix -> 127.0.0.1
    '2002:7f00:1::',            // 6to4
    '2001::1',                  // Teredo
    '100::1',                   // discard-only
    '2001:db8::1'               // documentation
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be blocked`);
  }
  assert.equal(isPrivateAddress('not-an-ip'), true, 'unparseable input should be blocked');
  assert.equal(isPrivateAddress('::ffff:93.184.216.34'), false, 'public v4-mapped should be allowed');
});

test('pinnedLookup only returns previously validated addresses', async () => {
  const addresses = [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }];

  const all = await new Promise((resolve, reject) => pinnedLookup(addresses)('example.com', { all: true }, (error, result) => error ? reject(error) : resolve(result)));
  assert.deepEqual(all, addresses);

  const single = await new Promise((resolve, reject) => pinnedLookup(addresses)('example.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(single, addresses[0]);

  const v6 = await new Promise((resolve, reject) => pinnedLookup(addresses)('example.com', { all: true, family: 6 }, (error, result) => error ? reject(error) : resolve(result)));
  assert.deepEqual(v6, [addresses[1]]);

  await assert.rejects(
    () => new Promise((resolve, reject) => pinnedLookup([addresses[0]])('example.com', { all: true, family: 6 }, (error, result) => error ? reject(error) : resolve(result))),
    /No allowed address/
  );
});

test('decodeEntities never double-decodes', () => {
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(decodeEntities('&#233; &#xE9;'), 'é é');
  assert.equal(decodeEntities('&mdash; &unknown;'), '— &unknown;');
});

test('htmlToText keeps structure readable', () => {
  const text = htmlToText('<div><h2>Title</h2><p>Para<br>break</p><ul><li>a</li></ul></div>');
  assert.match(text, /## Title/);
  assert.match(text, /Para\nbreak/);
  assert.match(text, /- a/);
});

test('domainMatches handles subdomains and wildcards', () => {
  assert.equal(domainMatches('example.com', 'example.com'), true);
  assert.equal(domainMatches('example.com', 'www.example.com'), true);
  assert.equal(domainMatches('*.example.com', 'example.com'), true);
  assert.equal(domainMatches('example.com', 'notexample.com'), false);
});

test('domainMatches ignores a trailing root dot', () => {
  assert.equal(domainMatches('example.com', 'example.com.'), true);
  assert.equal(domainMatches('example.com', 'www.example.com.'), true);
  assert.equal(domainMatches('example.com.', 'example.com.'), true);
  assert.equal(domainMatches('example.com', 'notexample.com.'), false);
});

test('a trailing root dot cannot bypass the deny list', async () => {
  await assert.rejects(
    () => tool(webConfig({ allowPrivate: false, denyDomains: ['example.com'] })).run({ url: 'http://example.com./x' }, ctx),
    /deny list/
  );
  await assert.rejects(
    () => tool(webConfig({ allowPrivate: false, denyDomains: ['example.com'] })).run({ url: 'http://www.example.com./x' }, ctx),
    /deny list/
  );
});
