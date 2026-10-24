// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
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
//   POST   /api/sessions/:id/read-only  change the conversation's read-only mode
//   DELETE /api/sessions/:id        remove one stored conversation
//   GET    /api/facts               list saved facts
//   PUT    /api/facts               add/update a fact {key, value}
//   DELETE /api/facts/:key          remove a fact by exact key
//   GET    /api/audit               audit log entries (limit/tool/ok filter)
//   DELETE /api/audit?olderThanWeeks=N  prune audit entries older than N weeks (1-9)
//   GET    /api/config              raw + effective config (key redacted)
//   PUT    /api/config              validate, save and live-reload config
//
// The chat stream uses the same event objects as the CLI's --json mode,
// plus "approval", "approval_result" and "aborted".

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { estimatePromptTokens } from '../context.mjs';
import { loadConfig } from '../config.mjs';
import { buildSystemPrompt } from '../prompt.mjs';
import { discoverSkills } from '../skills.mjs';
import { createRegistry } from '../tools/index.mjs';
import { mask } from '../util.mjs';
import { IMAGE_MIME_TYPES, parseImageDataUrl } from '../images.mjs';
import { AUDIT_PRUNE_MAX_WEEKS } from '../memory.mjs';
import { lastSessionPointer, listSessions, readSessionEvents } from './session.mjs';
import { readConfigFile, validateRawConfig, writeConfigFile } from '../config-file.mjs';

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

  async function readJSON(req, limit = REQUEST_BODY_LIMIT) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) {
        const error = new Error(`Request body too large (limit ${limit} bytes)`);
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

  // Image data URLs inflate bytes by roughly 4/3. Keep the chat route's body
  // limit tied to the configured image limits; every other route keeps the
  // small default limit.
  function chatBodyLimit() {
    const images = state.config.images;
    if (!images?.enabled) return REQUEST_BODY_LIMIT;
    return Math.max(REQUEST_BODY_LIMIT, Math.ceil((images.maxImages * images.maxBytes * 4) / 3) + 1024 * 1024);
  }

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
      contextTokens: config.agent.contextTokens,
      compact: config.agent.compact,
      compactAt: config.agent.compactAt,
      images: {
        enabled: config.images.enabled,
        maxImages: config.images.maxImages,
        maxBytes: config.images.maxBytes,
        detail: config.images.detail,
        types: [...IMAGE_MIME_TYPES]
      },
      readOnly: config.tools.readOnly,
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
    const body = await readJSON(req, chatBodyLimit());
    if (body.message !== undefined && typeof body.message !== 'string') {
      return badRequest(res, 'message must be a string');
    }
    const message = body.message ?? '';
    if (message.length > MAX_MESSAGE_CHARS) return badRequest(res, `message exceeds ${MAX_MESSAGE_CHARS} characters`);
    if (typeof body.sessionId !== 'string' || !body.sessionId) return badRequest(res, 'sessionId is required');

    const rawImages = body.images === undefined ? [] : body.images;
    if (!Array.isArray(rawImages)) return badRequest(res, 'images must be an array');
    if (rawImages.length > 0) {
      if (!state.config.images.enabled) return badRequest(res, 'image input is disabled (images.enabled)');
      if (rawImages.length > state.config.images.maxImages) {
        return sendJSON(res, 413, { error: `Too many images: ${rawImages.length}; the limit is ${state.config.images.maxImages} (images.maxImages)` });
      }
    }
    if (!message.trim() && rawImages.length === 0) return badRequest(res, 'message must be a non-empty string when no images are attached');

    const images = [];
    for (const raw of rawImages) {
      try {
        images.push(parseImageDataUrl(raw, { maxBytes: state.config.images.maxBytes }));
      } catch (error) {
        return sendJSON(res, error.status ?? 400, { error: error.message });
      }
    }

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
      await session.runTurn(message, write, { images });
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
      readOnly: session.readOnly,
      messages: dir ? readSessionEvents(dir, session.sessionId) : [],
      contextTokens: session.contextTokens()
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
    // A live session knows its exact message array (including tool traffic).
    // For a stored transcript, rebuild the same fixed prompt the agent will
    // use (system prompt + tool schemas + summary) so the gauge is comparable
    // before the session becomes live.
    const live = manager.sessions.get(id);
    const readOnly = live ? live.readOnly : Boolean(state.config.tools.readOnly);
    let contextTokens;
    if (live) {
      contextTokens = live.contextTokens();
    } else {
      // The transcript above shows the full history (including the marker),
      // but the prompt a resumed agent would send is the newest summary plus
      // the messages that survived it.
      const summary = manager.factStore ? manager.factStore.readSummary(id) : '';
      const plain = manager.factStore
        ? manager.factStore.readSession(id)
        : messages.filter((message) => message.role === 'user' || message.role === 'assistant');
      const skills = discoverSkills(state.config.skills.paths);
      const system = buildSystemPrompt({
        config: state.config,
        skills,
        memory: manager.factStore,
        cwd: state.cwd,
        readOnly
      });
      const registry = createRegistry({
        config: state.config,
        memory: manager.factStore,
        skills,
        cwd: state.cwd
      });
      contextTokens = estimatePromptTokens({
        system,
        summary,
        tools: registry.schemas({ readOnly }),
        messages: plain,
        imageTokens: state.config.images.tokensPerImage
      });
    }
    sendJSON(res, 200, { id, readOnly, messages, contextTokens });
  }

  async function sessionReadOnly(req, res, path) {
    const match = /^\/api\/sessions\/([^/]+)\/read-only$/.exec(path);
    if (!match) return sendJSON(res, 404, { error: 'Unknown session' });
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return badRequest(res, 'Invalid session id');
    }
    const body = await readJSON(req);
    if (typeof body.enabled !== 'boolean') return badRequest(res, 'enabled must be a boolean');
    let session;
    try {
      session = manager.get(id);
    } catch {
      return badRequest(res, 'Invalid session id');
    }
    try {
      sendJSON(res, 200, session.setReadOnly(body.enabled));
    } catch (error) {
      if (error.status === 409) return sendJSON(res, 409, { error: error.message });
      return sendJSON(res, error.status ?? 500, { error: error.message || String(error) });
    }
  }

  function sessionDelete(res, path) {
    const dir = memoryDir();
    if (!dir) return badRequest(res, 'memory is disabled');
    const id = segment(path, '/api/sessions/');
    if (!id) return sendJSON(res, 404, { error: 'Unknown session' });
    let result;
    try {
      result = manager.deleteSession(id);
    } catch (error) {
      if (error.status === 409) return sendJSON(res, 409, { error: error.message });
      return badRequest(res, 'Invalid session id');
    }
    sendJSON(res, 200, result);
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

  function auditPrune(res, url) {
    const store = manager.factStore;
    if (!store) return badRequest(res, 'memory is disabled');
    if (manager.anyBusy()) {
      return sendJSON(res, 409, { error: 'Cannot prune the audit log while a turn is running' });
    }
    const raw = url.searchParams.get('olderThanWeeks');
    if (raw === null || raw.trim() === '') return badRequest(res, 'olderThanWeeks is required');
    const olderThanWeeks = Number(raw);
    if (!Number.isInteger(olderThanWeeks) || olderThanWeeks < 1 || olderThanWeeks > AUDIT_PRUNE_MAX_WEEKS) {
      return badRequest(res, `olderThanWeeks must be an integer from 1 to ${AUDIT_PRUNE_MAX_WEEKS}`);
    }
    try {
      sendJSON(res, 200, store.pruneAudit({ olderThanWeeks }));
    } catch (error) {
      sendJSON(res, 500, { error: `Could not prune the audit log: ${error.message}` });
    }
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
      if (path.startsWith('/api/sessions/') && path.endsWith('/read-only') && method === 'POST') {
        await sessionReadOnly(req, res, path);
        return true;
      }
      if (path.startsWith('/api/sessions/') && method === 'GET') {
        sessionGet(res, path);
        return true;
      }
      if (path.startsWith('/api/sessions/') && method === 'DELETE') {
        sessionDelete(res, path);
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
      if (path === '/api/audit' && method === 'DELETE') {
        auditPrune(res, url);
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
