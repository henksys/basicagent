// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// Image attachments for vision-capable chat models.
//
// Images travel as OpenAI Chat Completions content parts:
//
//   { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
//
// That shape works with OpenAI-compatible cloud APIs, Ollama's
// /v1/chat/completions endpoint and llama.cpp's server. Only base64 data URLs
// are used: Ollama rejects remote image URLs, and a data URL is the one form
// every provider accepts.
//
// The file extension is never trusted. The bytes are checked for a PNG, JPEG
// or WebP signature, and the provider receives the sniffed MIME type. Those
// three formats are the intersection supported by OpenAI, Ollama and
// llama.cpp; GIF works on OpenAI but is rejected by Ollama, so it is left out
// deliberately.

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { resolveUserPath } from './util.mjs';

export const IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_IMAGE_MAX_COUNT = 4;
export const DEFAULT_IMAGE_DETAIL = 'auto';
export const DEFAULT_IMAGE_TOKENS = 1200;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Human-readable size for errors and the REPL. Base64 and JSON sizes are not
// interesting to the user; the decoded file size is.
export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Math.max(0, Number(bytes) || 0);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${index === 0 ? value : value.toFixed(1)} ${units[index]}`;
}

// Identify one of the supported formats from its magic bytes. Returns null
// for everything else, including GIF and SVG.
export function sniffImageType(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function cleanName(name) {
  const raw = String(name ?? '').replace(/\\/g, '/');
  return basename(raw).replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 200) || 'image';
}

function sizeError(name, bytes, maxBytes) {
  const error = new Error(
    `Image "${name}" is ${formatBytes(bytes)}; the limit is ${formatBytes(maxBytes)} (images.maxBytes)`
  );
  error.status = 413;
  return error;
}

// Validate one decoded image buffer and turn it into the attachment shape used
// by the agent. `dataUrl` is the only form sent to providers.
export function attachmentFromBuffer(buffer, { name = 'image', maxBytes = DEFAULT_IMAGE_MAX_BYTES } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const clean = cleanName(name);
  if (bytes.length === 0) throw new Error(`Image "${clean}" is empty`);
  if (bytes.length > maxBytes) throw sizeError(clean, bytes.length, maxBytes);
  const mediaType = sniffImageType(bytes);
  if (!mediaType) {
    throw new Error(`Image "${clean}" is not a supported image (PNG, JPEG or WebP)`);
  }
  return {
    name: clean,
    mediaType,
    bytes: bytes.length,
    dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`
  };
}

// Read a user-supplied path. stat() runs first so an oversized file is
// rejected without being loaded into memory.
export async function readImageFile(input, { maxBytes = DEFAULT_IMAGE_MAX_BYTES, cwd = process.cwd() } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('An image path is required');
  const path = resolveUserPath(input.trim(), cwd);
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Image not found: ${path}`);
    throw new Error(`Could not read image ${path}: ${error.message}`);
  }
  if (!stats.isFile()) throw new Error(`Not a regular file: ${path}`);
  if (stats.size === 0) throw new Error(`Image "${basename(path)}" is empty`);
  if (stats.size > maxBytes) throw sizeError(basename(path), stats.size, maxBytes);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(`Could not read image ${path}: ${error.message}`);
  }
  return attachmentFromBuffer(bytes, { name: basename(path), maxBytes });
}

// Parse a browser upload. The client sends { name, dataUrl }, but a bare data
// URL string is accepted as well. The declared MIME type is only a hint; the
// bytes decide which type is actually sent.
export function parseImageDataUrl(value, { maxBytes = DEFAULT_IMAGE_MAX_BYTES, name = '' } = {}) {
  let dataUrl = value;
  let uploadName = name;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    uploadName = value.name || uploadName;
    dataUrl = value.dataUrl ?? value.url ?? '';
  }
  if (typeof dataUrl !== 'string') throw new Error('Image must be a base64 data URL');
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) throw new Error(`Image "${cleanName(uploadName)}" must be a base64 data URL`);

  const base64 = match[2].replace(/\s+/g, '');
  // Check the encoded length before decoding so a huge upload cannot allocate
  // a large buffer just to be rejected afterwards.
  const maxEncoded = Math.ceil(maxBytes / 3) * 4;
  if (base64.length > maxEncoded) {
    throw sizeError(cleanName(uploadName), Math.ceil((base64.length * 3) / 4), maxBytes);
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new Error(`Image "${cleanName(uploadName)}" is empty`);
  // Buffer's base64 decoder is forgiving; require canonical input so malformed
  // data is not silently accepted.
  if (bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) {
    throw new Error(`Image "${cleanName(uploadName)}" contains invalid base64 data`);
  }
  return attachmentFromBuffer(bytes, { name: uploadName, maxBytes });
}

// Build the message content for one user turn. Text-only turns stay plain
// strings so providers that are weak with content arrays are not affected.
export function buildUserContent(text, attachments, { detail = DEFAULT_IMAGE_DETAIL } = {}) {
  if (!attachments?.length) return text;
  const parts = [];
  if (text) parts.push({ type: 'text', text: String(text) });
  for (const attachment of attachments) {
    if (!attachment?.dataUrl) throw new Error('Invalid image attachment');
    const imageUrl = { url: attachment.dataUrl };
    // "auto" is the provider default. Omitting it avoids sending an unknown
    // field to stricter compatible servers.
    if (detail === 'low' || detail === 'high') imageUrl.detail = detail;
    parts.push({ type: 'image_url', image_url: imageUrl });
  }
  return parts;
}

// A compact marker for session files, transcripts and summaries. Base64 is
// never persisted or sent to the summarizer.
export function imagePlaceholder(attachment) {
  return `[image: ${attachment?.name || 'image'}]`;
}

// What the session log records for a user turn with attachments.
export function formatUserEvent(text, attachments = []) {
  const marker = attachments.map(imagePlaceholder).join(' ');
  return [String(text ?? '').trim(), marker].filter(Boolean).join('\n');
}

// Plain text for compaction. Content arrays are rendered without their base64.
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return String(part.text ?? '');
        if (part?.type === 'image_url') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(content ?? '');
}
