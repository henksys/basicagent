// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// Conversation and fact persistence.
//
// Two plain-text stores live under the data directory (default
// ~/.local/share/basicagent, created with mode 0700):
//
//   facts.jsonl            durable key/value facts saved by the remember tool
//   sessions/<id>.jsonl    one JSON object per user/assistant message
//   last-session.txt       id of the most recent session (for --continue)
//
// Everything is JSON Lines: human readable, easy to grep, easy to delete.
// Only user and assistant text is stored; tool calls/results are intentionally
// not replayed on resume.
//
// Fact operations rewrite facts.jsonl atomically (write temp + rename) so a
// crash cannot leave a half-written file.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { bounded } from './util.mjs';

const MAX_EVENT_BYTES = 24000;

export function sanitizeSessionId(input) {
  const id = String(input ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '-');
  if (!id || id === '.' || id === '..') throw new Error('Session id may only contain letters, numbers, dot, underscore and dash');
  return id.slice(0, 100);
}

export function newSessionId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${random}`;
}

export class Memory {
  constructor({ dir }) {
    this.dir = dir;
    this.sessionsDir = join(dir, 'sessions');
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    this.factsPath = join(dir, 'facts.jsonl');
    this.lastSessionPath = join(dir, 'last-session.txt');
    this.auditPath = join(dir, 'audit.jsonl');
    this.facts = this.#loadFacts();
    this.sessionId = null;
    this.buffer = [];
  }

  #loadFacts() {
    const facts = new Map();
    if (!existsSync(this.factsPath)) return facts;
    for (const line of readFileSync(this.factsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.key === 'string') facts.set(entry.key, { value: String(entry.value ?? ''), at: entry.at || '' });
      } catch {
        // Ignore damaged lines instead of failing the whole session.
      }
    }
    return facts;
  }

  #saveFacts() {
    const lines = [...this.facts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => JSON.stringify({ key, value: entry.value, at: entry.at }));
    const tmp = `${this.factsPath}.tmp`;
    writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
    renameSync(tmp, this.factsPath);
  }

  // Session lifecycle ------------------------------------------------------

  startSession(id = newSessionId()) {
    this.sessionId = sanitizeSessionId(id);
    const file = join(this.sessionsDir, `${this.sessionId}.jsonl`);
    if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
    writeFileSync(this.lastSessionPath, `${this.sessionId}\n`, { mode: 0o600 });
    this.buffer = [];
    return this.sessionId;
  }

  // Resume the most recent session. Returns its user/assistant messages, or
  // null when there is nothing to resume.
  continueSession() {
    if (!existsSync(this.lastSessionPath)) return null;
    const id = readFileSync(this.lastSessionPath, 'utf8').trim();
    if (!id) return null;
    try {
      return { id: this.startSession(id), messages: this.readSession(id) };
    } catch {
      return null;
    }
  }

  readSession(id) {
    const file = join(this.sessionsDir, `${sanitizeSessionId(id)}.jsonl`);
    if (!existsSync(file)) return [];
    const messages = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.role === 'user' || entry.role === 'assistant') messages.push({ role: entry.role, content: String(entry.content ?? '') });
      } catch {
        // Skip damaged lines.
      }
    }
    return messages;
  }

  appendEvent(role, content) {
    if (!this.sessionId || !content) return;
    const entry = { ts: new Date().toISOString(), role, content: bounded(content, MAX_EVENT_BYTES) };
    this.buffer.push(entry);
    writeFileSync(join(this.sessionsDir, `${this.sessionId}.jsonl`), JSON.stringify(entry) + '\n', { flag: 'a', mode: 0o600 });
  }

  // Facts ------------------------------------------------------------------

  // Re-read facts.jsonl from disk. Used by long-running processes (the web
  // server) when another session may have changed the shared fact store.
  reloadFacts() {
    this.facts = this.#loadFacts();
    return this.facts.size;
  }

  // Remove one fact by its exact key. Returns true when it existed.
  deleteFact(key) {
    const existed = this.facts.delete(String(key ?? ''));
    if (existed) this.#saveFacts();
    return existed;
  }

  remember(key, value) {
    const cleanKey = bounded(String(key ?? '').trim(), 200);
    const cleanValue = bounded(String(value ?? '').trim(), 3000);
    if (!cleanKey || !cleanValue) throw new Error('Both key and value are required');
    const fact = { key: cleanKey, value: cleanValue, at: new Date().toISOString() };
    this.facts.set(cleanKey, fact);
    this.#saveFacts();
    return fact;
  }

  // Case-insensitive substring search over facts, sessions and audit logs.
  // Returns at most 8 matches, newest first, as short snippets.
  search(query) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return [];
    const results = [];
    const remember = (at, source, text) => {
      if (results.length < 8 && String(text).toLowerCase().includes(needle)) {
        results.push({ at, source, snippet: bounded(String(text), 300) });
      }
    };

    for (const [key, entry] of this.facts) remember(entry.at, `fact:${key}`, `${key}: ${entry.value}`);

    const sessionFiles = existsSync(this.sessionsDir)
      ? readdirSync(this.sessionsDir).filter((name) => name.endsWith('.jsonl')).sort().reverse().slice(0, 50)
      : [];
    for (const file of sessionFiles) {
      for (const line of readFileSync(join(this.sessionsDir, file), 'utf8').split('\n')) {
        if (!line.trim() || !line.toLowerCase().includes(needle)) continue;
        try {
          const entry = JSON.parse(line);
          remember(entry.ts, `session:${file.replace(/\.jsonl$/, '')}`, `${entry.role}: ${entry.content}`);
        } catch {
          // Skip damaged lines.
        }
      }
    }
    return results;
  }

  // Remove every fact and session line containing the literal substring.
  // Returns how many records were removed.
  forget(query) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) throw new Error('Specify what to forget');
    let removed = 0;

    for (const [key, entry] of [...this.facts]) {
      if (key.toLowerCase().includes(needle) || entry.value.toLowerCase().includes(needle)) {
        this.facts.delete(key);
        removed++;
      }
    }
    if (removed) this.#saveFacts();

    if (existsSync(this.sessionsDir)) {
      for (const file of readdirSync(this.sessionsDir).filter((name) => name.endsWith('.jsonl'))) {
        const path = join(this.sessionsDir, file);
        const kept = readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => {
            if (!line.trim()) return true;
            const match = line.toLowerCase().includes(needle);
            if (match) removed++;
            return !match;
          });
        writeFileSync(`${path}.tmp`, kept.join('\n'), { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
      }
    }
    return removed;
  }

  // Facts formatted for the system prompt. Returns '' when there are none.
  factsContext(maxBytes = 4000) {
    if (this.facts.size === 0) return '';
    const lines = [...this.facts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `- ${key}: ${entry.value}`);
    return bounded(lines.join('\n'), maxBytes);
  }

  close() {
    // Node flushes synchronous appends, nothing to do. Kept for symmetry.
  }
}
