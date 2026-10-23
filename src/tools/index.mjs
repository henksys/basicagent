// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// Tool registry: validation, dispatch and the audit log.
//
// Every tool is a plain object:
//   { name, description, parameters (JSON schema), run(args, ctx) }
//
// The registry exposes them to the model in OpenAI function-calling format
// and validates arguments before running anything. Unknown arguments and
// wrong types are rejected with an error the model can read and correct,
// which keeps weak local models from silently doing the wrong thing.
//
// Read-only mode is enforced here: schemas({ readOnly: true }) omits tools
// whose allowedInReadOnly is not true, and execute() refuses them even if a
// model calls one from conversation history.
//
// Every executed call is appended to audit.jsonl in the data directory:
//   { ts, tool, args (bounded), ok, error, durationMs, approvals }
// Approval requests made during the call are recorded with their answer, and
// an audit write that fails is reported once instead of silently dropped.

import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bounded, previewJSON } from '../util.mjs';
import { fileTools } from './files.mjs';
import { shellTools } from './shell.mjs';
import { webTools } from './web.mjs';
import { memoryTools } from './memory-tools.mjs';
import { loadSkillTool } from '../skills.mjs';

// Minimal JSON-schema argument validation (the subset our tools use).
export function validateArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Arguments must be a JSON object');
  }
  const properties = schema.properties || {};
  const required = schema.required || [];
  for (const key of required) {
    if (args[key] === undefined) throw new Error(`Missing required argument "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec) {
      if (schema.additionalProperties === false) throw new Error(`Unknown argument "${key}"`);
      continue;
    }
    switch (spec.type) {
      case 'string':
        if (typeof value !== 'string') throw new Error(`Argument "${key}" must be a string`);
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Argument "${key}" must be a number`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') throw new Error(`Argument "${key}" must be a boolean`);
        break;
      case 'array':
        if (!Array.isArray(value)) throw new Error(`Argument "${key}" must be an array`);
        if (spec.items?.type === 'string' && value.some((item) => typeof item !== 'string')) {
          throw new Error(`Argument "${key}" must be an array of strings`);
        }
        break;
      case 'object':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Argument "${key}" must be an object`);
        break;
      default:
        break;
    }
  }
}

export function createRegistry({ config, memory, skills, cwd, onAuditError = () => {} }) {
  const tools = new Map();
  const add = (tool) => {
    if (tools.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    tools.set(tool.name, tool);
  };

  for (const tool of fileTools({ config, cwd })) add(tool);
  for (const tool of shellTools({ config, cwd })) add(tool);
  for (const tool of webTools({ config })) add(tool);
  if (memory && config.memory.enabled) for (const tool of memoryTools({ memory })) add(tool);
  if (skills?.size) add(loadSkillTool(skills, { maxResultChars: config.agent.maxResultChars }));

  const auditPath = memory && config.memory.enabled ? join(memory.dir, 'audit.jsonl') : null;
  let auditReady = false;
  let auditFailed = false;

  async function audit(entry) {
    if (!auditPath) return;
    try {
      if (!auditReady) {
        await mkdir(memory.dir, { recursive: true, mode: 0o700 });
        auditReady = true;
      }
      await appendFile(auditPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (error) {
      // Auditing must never break a tool call, but a broken audit log is worth
      // reporting: without it there is no record of what the agent did.
      if (!auditFailed) {
        auditFailed = true;
        onAuditError(`Could not write the audit log (${error.message}); tool calls will not be recorded.`);
      }
    }
  }

  return {
    // Tool schemas in OpenAI function-calling format. In read-only mode,
    // mutating tools are omitted entirely so the model never sees them.
    schemas({ readOnly = false } = {}) {
      return [...tools.values()]
        .filter((tool) => !readOnly || tool.allowedInReadOnly === true)
        .map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters }
        }));
    },

    names({ readOnly = false } = {}) {
      return [...tools.values()]
        .filter((tool) => !readOnly || tool.allowedInReadOnly === true)
        .map((tool) => tool.name);
    },

    // Run one tool. ctx carries { signal, approve, readOnly } from the caller.
    async execute(name, args, ctx) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Unknown tool "${name}". Available tools: ${[...tools.keys()].join(', ')}`);
      if (ctx?.readOnly && tool.allowedInReadOnly !== true) {
        throw new Error(`Tool "${name}" is not available in read-only mode`);
      }
      validateArgs(tool.parameters, args);
      const started = Date.now();
      const approvals = [];
      const baseApprove = typeof ctx?.approve === 'function' ? ctx.approve : async () => false;
      const wrappedCtx = {
        ...ctx,
        approve: async (description) => {
          const approved = await baseApprove(description);
          approvals.push({ description: bounded(description, 500), approved });
          return approved;
        }
      };
      try {
        const result = await tool.run(args, wrappedCtx);
        await audit({ ts: new Date().toISOString(), tool: name, args: previewJSON(args, 2000), ok: true, durationMs: Date.now() - started, approvals });
        return result;
      } catch (error) {
        await audit({ ts: new Date().toISOString(), tool: name, args: previewJSON(args, 2000), ok: false, error: bounded(error.message, 500), durationMs: Date.now() - started, approvals });
        throw error;
      }
    }
  };
}
