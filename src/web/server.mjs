// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// The web server: static files, security checks and the JSON API.
//
// Security model (this server can drive an agent with file and shell tools):
//   - binds to loopback by default; a non-loopback --host is an explicit
//     opt-out from the host/origin checks below
//   - the Host header must be the loopback address the server is bound to
//     (blocks DNS-rebinding attacks from other websites)
//   - cross-origin requests to /api are rejected
//   - every /api request needs "Authorization: Bearer <token>"; there are no
//     cookies, so there is no CSRF surface to abuse
//   - static files are served only from the bundled web/ directory
//
// Node's built-in http module is all that is used here; no dependencies.

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { SessionManager } from './session.mjs';

const WEB_ROOT = fileURLToPath(new URL('../../web', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function tokenMatches(header, token) {
  const match = /^Bearer\s+(.+)$/.exec(header || '');
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function loopbackHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function sendText(res, status, text) {
  if (res.writableEnded || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function serveStatic(req, res, pathname) {
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const target = normalize(join(WEB_ROOT, rel));
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) return sendText(res, 404, 'Not found');
  let info;
  try {
    info = await stat(target);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (!info.isFile()) return sendText(res, 404, 'Not found');
  let data;
  try {
    data = await readFile(target);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': data.length,
    'cache-control': target.includes(`${sep}assets${sep}`) ? 'public, max-age=86400' : 'no-cache'
  });
  res.end(method === 'HEAD' ? undefined : data);
}

export async function startWebServer({ config, flags = {}, cwd, version, token, host = '127.0.0.1', port = 8787 }) {
  if (!token) throw new Error('A token is required');
  const state = { config, flags, cwd };
  const manager = new SessionManager({ config, cwd });
  const api = createApi({ state, manager, version });
  const enforceHostChecks = isLoopbackHost(host);

  const server = createServer((req, res) => {
    (async () => {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');

      let url;
      try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      } catch {
        return sendText(res, 400, 'Bad request');
      }

      const actualPort = server.address()?.port ?? port;
      if (enforceHostChecks && !loopbackHosts(actualPort).has(req.headers.host || '')) {
        return sendText(res, 403, 'Invalid Host header');
      }

      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (enforceHostChecks) {
          const origin = req.headers.origin;
          if (origin && origin !== `http://${req.headers.host}`) {
            return sendText(res, 403, 'Cross-origin request rejected');
          }
        }
        if (!tokenMatches(req.headers.authorization, token)) {
          return sendText(res, 401, 'Unauthorized');
        }
        const handled = await api.handle(req, res, url);
        if (!handled) sendText(res, 404, 'Not found');
        return;
      }

      await serveStatic(req, res, url.pathname);
    })().catch((error) => {
      sendText(res, 500, `Internal error: ${error?.message || String(error)}`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    server,
    manager,
    host,
    port: address.port,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}/`,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  };
}
