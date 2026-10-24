// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateMessageTokens } from '../src/context.mjs';
import {
  attachmentFromBuffer,
  buildUserContent,
  contentToText,
  formatBytes,
  formatUserEvent,
  parseImageDataUrl,
  readImageFile,
  sniffImageType
} from '../src/images.mjs';

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const webpBytes = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '),
  Buffer.from([0x00, 0x00, 0x00, 0x00])
]);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'basicagent-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sniffImageType recognizes the three supported formats from magic bytes', () => {
  assert.equal(sniffImageType(pngBytes), 'image/png');
  assert.equal(sniffImageType(jpegBytes), 'image/jpeg');
  assert.equal(sniffImageType(webpBytes), 'image/webp');
  assert.equal(sniffImageType(Buffer.from('GIF89a')), null);
  assert.equal(sniffImageType(Buffer.from('hello')), null);
});

test('attachmentFromBuffer uses the sniffed type, not the file extension', () => {
  const attachment = attachmentFromBuffer(jpegBytes, { name: 'photo.txt' });
  assert.equal(attachment.name, 'photo.txt');
  assert.equal(attachment.mediaType, 'image/jpeg');
  assert.match(attachment.dataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(attachment.bytes, jpegBytes.length);
});

test('unsupported and oversized images are rejected with useful errors', () => {
  assert.throws(() => attachmentFromBuffer(Buffer.from('GIF89a'), { name: 'anim.gif' }), /PNG, JPEG or WebP/);
  assert.throws(
    () => attachmentFromBuffer(Buffer.concat([pngBytes, Buffer.alloc(20)]), { name: 'big.png', maxBytes: 12 }),
    (error) => error.status === 413 && /limit is 12 B/.test(error.message)
  );
  assert.throws(() => attachmentFromBuffer(Buffer.alloc(0), { name: 'empty.png' }), /empty/);
});

test('readImageFile checks the size before reading and resolves against cwd', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'shot.png'), pngBytes);
  writeFileSync(join(dir, 'big.png'), Buffer.concat([pngBytes, Buffer.alloc(100)]));

  const attachment = await readImageFile('shot.png', { cwd: dir, maxBytes: 1024 });
  assert.equal(attachment.name, 'shot.png');
  assert.equal(attachment.mediaType, 'image/png');

  await assert.rejects(
    () => readImageFile('big.png', { cwd: dir, maxBytes: 20 }),
    (error) => error.status === 413 && /limit is 20 B/.test(error.message)
  );
  await assert.rejects(() => readImageFile('missing.png', { cwd: dir }), /not found/);
});

test('parseImageDataUrl accepts browser uploads and ignores a misleading MIME hint', () => {
  const attachment = parseImageDataUrl(
    { name: 'pasted.png', dataUrl: `data:image/jpeg;base64,${pngBytes.toString('base64')}` },
    { maxBytes: 1024 }
  );
  assert.equal(attachment.name, 'pasted.png');
  assert.equal(attachment.mediaType, 'image/png');
  assert.match(attachment.dataUrl, /^data:image\/png;base64,/);

  assert.throws(() => parseImageDataUrl('data:text/plain;base64,aGVsbG8=', { name: 'x.txt' }), /PNG, JPEG or WebP/);
  assert.throws(() => parseImageDataUrl({ name: 'huge.png', dataUrl: `data:image/png;base64,${Buffer.alloc(100).toString('base64')}` }, { maxBytes: 20 }), (error) => error.status === 413);
});

test('buildUserContent omits the text part when there is no text', () => {
  const attachment = attachmentFromBuffer(pngBytes, { name: 'shot.png' });
  const content = buildUserContent('', [attachment]);
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'image_url');

  const withText = buildUserContent('What is this?', [attachment], { detail: 'high' });
  assert.deepEqual(withText[0], { type: 'text', text: 'What is this?' });
  assert.equal(withText[1].image_url.detail, 'high');
});

test('image messages use a fixed token estimate instead of the base64 size', () => {
  const huge = 'A'.repeat(1_000_000);
  const estimate = estimateMessageTokens({
    role: 'user',
    content: [
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${huge}` } }
    ]
  });
  assert.ok(estimate < 2000, `expected an image estimate, got ${estimate}`);
  assert.ok(estimate > 1200, 'the image still has a meaningful cost');
});

test('session markers and summaries never contain base64', () => {
  const attachment = attachmentFromBuffer(pngBytes, { name: 'shot.png' });
  const event = formatUserEvent('What is this?', [attachment]);
  assert.equal(event, 'What is this?\n[image: shot.png]');
  assert.equal(contentToText([{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: attachment.dataUrl } }]), 'hello\n[image]');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MiB');
});
