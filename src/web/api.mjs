// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// JSON API for the web interface.
//
// Routes (all under /api/, all requiring the bearer token):
//
//   GET    /api/status              server, model and tool summary
//   POST   /api/chat                run one turn; NDJSON event stream back
//   POST   /api/chat/abort          abort the running turn
//   POST   /api/approvals/:id       approve or deny a paused tool call
//   GET    /api/sessions            list stored conversations
//   POST   /api/sessions            start (or resume) a conversation
//   GET    /api/sessions/:id        one transcript with timestamps
//   GET    /api/facts               list saved facts
//   PUT    /api/facts               add/update a fact {key, value}
//   DELETE /api/facts/:key          remove a fact by exact key
//   GET    /api/audit               audit log entries (limit/tool/ok filter)
//   GET    /api/config              raw + effective config (key redacted)
//   PUT    /api/config              validate, save and live-reload config
//
// The chat stream uses the same event objects as the CLI's --json mode,
// plus "approval", "approval_result" and "aborted".

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.mjs';
import { discoverSkills } from '../skills.mjs';
import { createRegistry } from '../tools/index.mjs';
import { mask } from '../util.mjs';
import { lastSessionPointer, listSessions, readSessionEvents } from './session.mjs';
import { readConfigFile, validateRawConfig, writeConfigFile } from './config-file.mjs';

export const MAX_MESSAGE_CHARS = 100000;
const AUDIT_LIMIT_DEFAULT = 200;
const AUDIT_LIMIT_MAX = 1000;
const REQUEST_BODY_LIMIT = 2 * 1024 * 1024;

export function createApi({ state, manager, version }) {
  // Small helpers -----------------------------------------------------------

  function sendJSON(res, status, body) {
    if (res.writableEnded || res.headersSent) return;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify(body));
  }

  function badRequest(res, message) {
    sendJSON(res, 400, { error: message });
  }

  async function readJSON(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > REQUEST_BODY_LIMIT) {
        const error = new Error('Request body too large');
        error.status = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      const error = new Error('Request body is not valid JSON');
      error.status = 400;
      throw error;
    }
  }

  // Decode one URL path segment; null when the encoding is broken.
  function segment(path, prefix) {
    try {
      return decodeURIComponent(path.slice(prefix.length));
    } catch {
      return null;
    }
  }

  const memoryDir = () => (state.config.memory.enabled ? state.config.memory.dir : null);

  function readRawConfigSafe() {
    const path = state.config.paths.configPath;
    try {
      return { ...readConfigFile(path), path, parseError: null };
    } catch (error) {
      return { raw: {}, found: false, path, parseError: error.message };
    }
  }

  function configPayload() {
    const config = state.config;
    const fileInfo = readRawConfigSafe();
    const raw = structuredClone(fileInfo.raw);
    let apiKeySet = false;
    if (raw.provider && typeof raw.provider === 'object' && !Array.isArray(raw.provider)) {
      apiKeySet = Boolean(raw.provider.apiKey);
      raw.provider.apiKey = '';
    }
    const effective = structuredClone(config);
    effective.provider.apiKey = mask(effective.provider.apiKey);
    return {
      path: fileInfo.path,
      found: fileInfo.found,
      parseError: fileInfo.parseError,
      apiKeySet,
      raw,
      effective
    };
  }

  // Handlers ----------------------------------------------------------------

  function status(res) {
    const config = state.config;
    const dir = memoryDir();
    const skills = discoverSkills(config.skills.paths);
    const registry = createRegistry({ config, memory: manager.factStore, skills, cwd: state.cwd });
    sendJSON(res, 200, {
      version,
      model: config.provider.model,
      baseUrl: config.provider.baseUrl,
      cwd: state.cwd,
      memoryEnabled: config.memory.enabled,
      dataDir: dir,
      configPath: config.paths.configPath,
      configFound: config.paths.configFound,
      lastSessionId: dir ? lastSessionPointer(dir) : null,
      sessions: manager.sessions.size,
      tools: registry.names(),
      skills: [...skills.values()].map((skill) => ({ name: skill.name, description: skill.description }))
    });
  }

  async function chat(req, res) {
    const body = await readJSON(req);
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) return badRequest(res, 'message must be a non-empty string');
    if (message.length > MAX_MESSAGE_CHARS) return badRequest(res, `message exceeds ${MAX_MESSAGE_CHARS} characters`);
    if (typeof body.sessionId !== 'string' || !body.sessionId) return badRequest(res, 'sessionId is required');
    let session;
    try {
      session = manager.get(body.sessionId);
    } catch {
      return badRequest(res, 'Invalid session id');
    }
    if (session.busy) return sendJSON(res, 409, { error: 'A turn is already running in this session' });

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no'
    });
    let finished = false;
    const write = (event) => {
      if (finished || res.writableEnded || res.destroyed) return;
      try {
        res.write(JSON.stringify(event) + '\n');
      } catch {
        // The client went away; the close handler aborts the turn.
      }
    };
    res.on('close', () => {
      if (!finished) session.abort();
    });

    try {
      await session.runTurn(message, write);
    } catch (error) {
      if (error?.name === 'AbortError') write({ type: 'aborted' });
      else write({ type: 'error', message: error?.message || String(error) });
    } finally {
      finished = true;
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  }

  async function chatAbort(req, res) {
    const body = await readJSON(req);
    if (typeof body.sessionId !== 'string' || !body.sessionId) return badRequest(res, 'sessionId is required');
    try {
      manager.get(body.sessionId).abort();
    } catch {
      return badRequest(res, 'Invalid session id');
    }
    sendJSON(res, 200, { ok: true });
  }

  async function approval(req, res, path) {
    const id = segment(path, '/api/approvals/');
    if (!id) return sendJSON(res, 404, { error: 'Unknown approval' });
    const body = await readJSON(req);
    const resolved = manager.resolveApproval(id, Boolean(body.approved));
    if (!resolved) return sendJSON(res, 404, { error: 'Unknown or expired approval' });
    sendJSON(res, 200, { ok: true });
  }

  function sessionsList(res) {
    const dir = memoryDir();
    if (!dir) return sendJSON(res, 200, { memoryEnabled: false, sessions: [] });
    const sessions = listSessions(dir).map((session) => ({
      ...session,
      active: manager.sessions.has(session.id),
      busy: manager.sessions.get(session.id)?.busy || false
    }));
    sendJSON(res, 200, { memoryEnabled: true, sessions });
  }

  async function sessionStart(req, res) {
    const body = await readJSON(req);
    if (body.id !== undefined && typeof body.id !== 'string') return badRequest(res, 'id must be a string');
    let session;
    try {
      session = body.id ? manager.get(body.id) : manager.create();
    } catch {
      return badRequest(res, 'Invalid session id');
    }
    const dir = memoryDir();
    sendJSON(res, 200, {
      id: session.sessionId,
      messages: dir ? readSessionEvents(dir, session.sessionId) : []
    });
  }

  function sessionGet(res, path) {
    const id = segment(path, '/api/sessions/');
    if (!id) return sendJSON(res, 404, { error: 'Unknown session' });
    const dir = memoryDir();
    let messages;
    try {
      messages = dir ? readSessionEvents(dir, id) : [];
    } catch {
      return badRequest(res, 'Invalid session id');
    }
    sendJSON(res, 200, { id, messages });
  }

  function factsList(res) {
    const store = manager.factStore;
    if (!store) return badRequest(res, 'memory is disabled');
    store.reloadFacts();
    const facts = [...store.facts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => ({ key, value: entry.value, at: entry.at }));
    sendJSON(res, 200, { facts });
  }

  async function factPut(req, res) {
    const store = manager.factStore;
    if (!store) return badRequest(res, 'memory is disabled');
    const body = await readJSON(req);
    if (typeof body.key !== 'string' || typeof body.value !== 'string') {
      return badRequest(res, 'key and value must be strings');
    }
    let fact;
    try {
      fact = store.remember(body.key, body.value);
    } catch (error) {
      return badRequest(res, error.message);
    }
    sendJSON(res, 200, { fact });
  }

  function factDelete(res, path) {
    const store = manager.factStore;
    if (!store) return badRequest(res, 'memory is disabled');
    const key = segment(path, '/api/facts/');
    if (!key) return badRequest(res, 'key is required');
    sendJSON(res, 200, { removed: store.deleteFact(key) });
  }

  async function audit(res, url) {
    const dir = memoryDir();
    if (!dir) return badRequest(res, 'memory is disabled');
    const path = join(dir, 'audit.jsonl');
    if (!existsSync(path)) return sendJSON(res, 200, { entries: [], total: 0, limit: AUDIT_LIMIT_DEFAULT });

    const limitRaw = Number(url.searchParams.get('limit') ?? AUDIT_LIMIT_DEFAULT);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, AUDIT_LIMIT_MAX) : AUDIT_LIMIT_DEFAULT;
    const tool = url.searchParams.get('tool') || '';
    const ok = url.searchParams.get('ok') || '';

    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      return sendJSON(res, 500, { error: `Could not read the audit log: ${error.message}` });
    }
    const matching = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (tool && entry.tool !== tool) continue;
      if (ok === 'true' && entry.ok !== true) continue;
      if (ok === 'false' && entry.ok !== false) continue;
      matching.push(entry);
    }
    const entries = matching.slice(-limit).reverse();
    sendJSON(res, 200, { entries, total: matching.length, limit });
  }

  function configGet(res) {
    sendJSON(res, 200, configPayload());
  }

  async function configPut(req, res) {
    if (manager.anyBusy()) {
      return sendJSON(res, 409, { error: 'Cannot reload the configuration while a turn is running' });
    }
    const body = await readJSON(req);
    const incoming = body.config;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return badRequest(res, 'config must be a JSON object');
    }
    // API key handling: null clears, ""/absent keeps the stored value. The
    // masked value never round-trips from the browser.
    if (incoming.provider && typeof incoming.provider === 'object' && !Array.isArray(incoming.provider)) {
      const key = incoming.provider.apiKey;
      if (key === null) {
        delete incoming.provider.apiKey;
      } else if (key === undefined || key === '') {
        const existing = readRawConfigSafe().raw;
        const existingKey = existing?.provider && typeof existing.provider === 'object' ? existing.provider.apiKey : undefined;
        if (typeof existingKey === 'string' && existingKey) incoming.provider.apiKey = existingKey;
        else delete incoming.provider.apiKey;
      } else if (typeof key !== 'string') {
        return badRequest(res, 'provider.apiKey must be a string or null');
      }
    }
    try {
      validateRawConfig(incoming, { cwd: state.cwd, configPath: state.config.paths.configPath });
    } catch (error) {
      return badRequest(res, error.message);
    }
    try {
      writeConfigFile(state.config.paths.configPath, incoming);
      state.config = loadConfig({ flags: state.flags, cwd: state.cwd });
    } catch (error) {
      return sendJSON(res, 500, { error: `Could not save the config: ${error.message}` });
    }
    manager.reload(state.config);
    sendJSON(res, 200, configPayload());
  }

  // Router ------------------------------------------------------------------

  async function handle(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    try {
      if (path === '/api/status' && method === 'GET') {
        status(res);
        return true;
      }
      if (path === '/api/chat' && method === 'POST') {
        await chat(req, res);
        return true;
      }
      if (path === '/api/chat/abort' && method === 'POST') {
        await chatAbort(req, res);
        return true;
      }
      if (path.startsWith('/api/approvals/') && method === 'POST') {
        await approval(req, res, path);
        return true;
      }
      if (path === '/api/sessions' && method === 'GET') {
        sessionsList(res);
        return true;
      }
      if (path === '/api/sessions' && method === 'POST') {
        await sessionStart(req, res);
        return true;
      }
      if (path.startsWith('/api/sessions/') && method === 'GET') {
        sessionGet(res, path);
        return true;
      }
      if (path === '/api/facts' && method === 'GET') {
        factsList(res);
        return true;
      }
      if (path === '/api/facts' && method === 'PUT') {
        await factPut(req, res);
        return true;
      }
      if (path.startsWith('/api/facts/') && method === 'DELETE') {
        factDelete(res, path);
        return true;
      }
      if (path === '/api/audit' && method === 'GET') {
        await audit(res, url);
        return true;
      }
      if (path === '/api/config' && method === 'GET') {
        configGet(res);
        return true;
      }
      if (path === '/api/config' && method === 'PUT') {
        await configPut(req, res);
        return true;
      }
      return false;
    } catch (error) {
      sendJSON(res, error.status ?? 500, { error: error.message || String(error) });
      return true;
    }
  }

  return { handle };
}
