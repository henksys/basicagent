// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// Memory tools: remember, search_memory and forget.
//
// These are thin wrappers over src/memory.mjs so the model can persist
// explicit user facts and search past sessions. Only registered when memory
// is enabled in the config.

export function memoryTools({ memory }) {
  return [
    {
      name: 'remember',
      allowedInReadOnly: true, // memory tools are deliberately exempt
      description:
        'Save an explicit durable user preference as a key/value pair. ' +
        'Only store facts the user actually stated; never guesses. Overwrites an existing key.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' }, value: { type: 'string' } },
        required: ['key', 'value'],
        additionalProperties: false
      },
      run: async ({ key, value }) => memory.remember(key, value)
    },
    {
      name: 'search_memory',
      allowedInReadOnly: true,
      description: 'Search saved facts and past conversation sessions for a literal substring. Use for questions about earlier conversations or saved preferences.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
      },
      run: async ({ query }) => {
        const matches = memory.search(query);
        return { matches, found: matches.length > 0 };
      }
    },
    {
      name: 'forget',
      allowedInReadOnly: true, // memory tools are deliberately exempt
      description:
        'Remove every saved fact and session line containing a literal substring. ' +
        'Search first to find the exact stored text. Returns how many records were removed.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
      },
      run: async ({ query }) => {
        const removed = memory.forget(query);
        return { removed, forgotten: removed > 0 };
      }
    }
  ];
}
