// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// Web sessions: one Agent + Memory + tool registry per conversation.
//
// The CLI builds and owns a single Agent for its whole process. The web
// server instead keeps one WebSession per conversation, all composed from
// the same modules the CLI uses:
//
//   WebSession   provider + registry + agent + memory for one session id
//   SessionManager   lookup/creation of WebSessions and the shared fact store
//
// Approval is bridged to the browser: instead of a y/N prompt, the session
// emits { type: "approval", id, description } through its event stream and
// waits for resolveApproval(id, approved) from an HTTP request. Without an
// answer it denies after APPROVAL_TIMEOUT_MS, and it denies immediately when
// the turn is aborted.

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '../agent.mjs';
import { Memory, newSessionId, sanitizeSessionId } from '../memory.mjs';
import { buildSystemPrompt } from '../prompt.mjs';
import { Provider } from '../provider.mjs';
import { discoverSkills } from '../skills.mjs';
import { createRegistry } from '../tools/index.mjs';
import { collapseWhitespace } from '../util.mjs';

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export class WebSession {
  constructor({ config, cwd, sessionId }) {
    this.config = config;
    this.cwd = cwd;
    this.listeners = new Set();
    this.pendingApprovals = new Map();
    this.busy = false;
    this.controller = null;
    this.#createMemory(sessionId);
    this.#build();
    this.agent.messages = this.memory ? this.memory.readSession(this.sessionId) : [];
  }

  #createMemory(sessionId) {
    this.memory = this.config.memory.enabled ? new Memory({ dir: this.config.memory.dir }) : null;
    const requested = sessionId ? sanitizeSessionId(sessionId) : newSessionId();
    this.sessionId = this.memory ? this.memory.startSession(requested) : requested;
  }

  #build() {
    this.skills = discoverSkills(this.config.skills.paths);
    this.provider = new Provider(this.config);
    this.registry = createRegistry({ config: this.config, memory: this.memory, skills: this.skills, cwd: this.cwd });
    this.agent = new Agent({
      provider: this.provider,
      registry: this.registry,
      config: this.config,
      emit: (event) => this.emit(event),
      approve: (description) => this.#approve(description)
    });
    this.#refreshSystemPrompt();
  }

  #refreshSystemPrompt() {
    this.agent.setSystem(buildSystemPrompt({ config: this.config, skills: this.skills, memory: this.memory, cwd: this.cwd }));
  }

  // Event fan-out to the active chat stream(s).
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A dead stream must never break the turn.
      }
    }
  }

  // Run one user turn, forwarding every agent event to `emit`. Only one turn
  // may run per session at a time.
  async runTurn(input, emit) {
    if (this.busy) {
      const error = new Error('A turn is already running in this session');
      error.status = 409;
      throw error;
    }
    this.busy = true;
    this.controller = new AbortController();
    const forward = (event) => {
      try {
        emit(event);
      } catch {
        // Ignore write failures on a closed stream.
      }
    };
    this.listeners.add(forward);
    try {
      this.memory?.reloadFacts();
      this.#refreshSystemPrompt();
      this.memory?.appendEvent('user', input);
      const result = await this.agent.run(input, { signal: this.controller.signal });
      this.memory?.appendEvent('assistant', result.text);
      return result;
    } finally {
      this.listeners.delete(forward);
      this.busy = false;
      this.controller = null;
      this.#denyPending();
    }
  }

  abort() {
    this.controller?.abort();
    this.#denyPending();
  }

  // Approval bridge ---------------------------------------------------------

  #approve(description) {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id);
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(id, {
        resolve: (approved) => {
          clearTimeout(timer);
          this.pendingApprovals.delete(id);
          resolve(approved);
        }
      });
      this.emit({ type: 'approval', id, description, automatic: false });
    });
  }

  resolveApproval(id, approved) {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return false;
    pending.resolve(Boolean(approved));
    this.emit({ type: 'approval_result', id, approved: Boolean(approved) });
    return true;
  }

  #denyPending() {
    for (const pending of [...this.pendingApprovals.values()]) pending.resolve(false);
  }

  // Rebuild everything but the conversation itself (/reload semantics).
  reload(config) {
    this.config = config;
    const messages = this.agent.messages;
    const sessionId = this.sessionId;
    this.#createMemory(sessionId);
    this.#build();
    this.agent.messages = messages;
  }

  info() {
    return { id: this.sessionId, busy: this.busy, messages: this.agent.messages.length };
  }
}

export class SessionManager {
  constructor({ config, cwd }) {
    this.config = config;
    this.cwd = cwd;
    this.sessions = new Map();
    this.factStore = config.memory.enabled ? new Memory({ dir: config.memory.dir }) : null;
  }

  // Get or create the session with this id (invalid ids throw).
  get(id) {
    const clean = sanitizeSessionId(id);
    if (!this.sessions.has(clean)) {
      this.sessions.set(clean, new WebSession({ config: this.config, cwd: this.cwd, sessionId: clean }));
    }
    return this.sessions.get(clean);
  }

  create(id) {
    return this.get(id || newSessionId());
  }

  // Delete one stored conversation and drop its in-memory session. Throws
  // with status 409 when a turn is still running in it.
  deleteSession(id) {
    const clean = sanitizeSessionId(id);
    const session = this.sessions.get(clean);
    if (session?.busy) {
      const error = new Error('A turn is running in this session');
      error.status = 409;
      throw error;
    }
    this.sessions.delete(clean);
    const removed = this.factStore ? this.factStore.deleteSession(clean) : false;
    const dir = this.config.memory.enabled ? this.config.memory.dir : null;
    return { removed, lastSessionId: dir ? lastSessionPointer(dir) : null };
  }

  anyBusy() {
    return [...this.sessions.values()].some((session) => session.busy);
  }

  resolveApproval(id, approved) {
    for (const session of this.sessions.values()) {
      if (session.resolveApproval(id, approved)) return true;
    }
    return false;
  }

  reload(config) {
    this.config = config;
    this.factStore = config.memory.enabled ? new Memory({ dir: config.memory.dir }) : null;
    for (const session of this.sessions.values()) session.reload(config);
  }
}

// Disk helpers for the browsing endpoints -----------------------------------

// The session id stored in last-session.txt, or null.
export function lastSessionPointer(dir) {
  const path = join(dir, 'last-session.txt');
  if (!existsSync(path)) return null;
  const id = readFileSync(path, 'utf8').trim();
  return id || null;
}

// All sessions with a message count, a short title and the update time,
// newest first.
export function listSessions(dir) {
  const sessionsDir = join(dir, 'sessions');
  if (!existsSync(sessionsDir)) return [];
  const out = [];
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(sessionsDir, name);
    const stat = statSync(path);
    let count = 0;
    let title = '';
    let updatedAt = stat.mtime.toISOString();
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.role !== 'user' && entry.role !== 'assistant') continue;
        count++;
        if (!title && entry.role === 'user') title = collapseWhitespace(String(entry.content ?? '')).slice(0, 90);
        if (entry.ts) updatedAt = entry.ts;
      } catch {
        // Skip damaged lines.
      }
    }
    out.push({ id: name.replace(/\.jsonl$/, ''), messages: count, title, updatedAt });
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// One session's messages including timestamps, for transcript display.
export function readSessionEvents(dir, id) {
  const path = join(dir, 'sessions', `${sanitizeSessionId(id)}.jsonl`);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.role === 'user' || entry.role === 'assistant') {
        out.push({ ts: entry.ts || '', role: entry.role, content: String(entry.content ?? '') });
      }
    } catch {
      // Skip damaged lines.
    }
  }
  return out;
}
