// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk Duisterwinkel
// Open a URL in the user's default browser.
//
// Node has no built-in browser launcher, so this shells out to the platform
// command: xdg-open on Linux, open on macOS and start on Windows. The child
// is detached and unreferenced so it cannot keep the server alive, and every
// failure (no display, command missing) is swallowed: the URL is already on
// screen, so the server must keep running.

import { spawn } from 'node:child_process';

export function browserCommand(platform, url) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const [command, args] = browserCommand(platform, url);
  try {
    const child = spawnImpl(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
