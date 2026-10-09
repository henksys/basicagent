// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
// Approval helper for policy-restricted operations (guarded writes, shell
// commands). The CLI decides the mode:
//
//   REPL        interactive question, default answer is "no"
//   one-shot    deny by default; --yes approves automatically
//   --json      same as one-shot, plus an approval event for the script
//
// The returned function has the signature (description: string) => Promise<boolean>.

export function createApproval({ interactive = false, yes = false, question, onEvent = () => {}, onNotice = () => {} } = {}) {
  return async function approve(description) {
    if (yes) {
      onEvent({ type: 'approval', description, approved: true, automatic: true });
      return true;
    }
    if (!interactive) {
      onEvent({ type: 'approval', description, approved: false, automatic: true });
      onNotice(`Approval required for: ${description}\nThis run cannot ask (one-shot mode). Re-run with --yes to allow approvals, or use the interactive REPL.`);
      return false;
    }
    const answer = String(await question(`Approve this action?\n  ${description}\n[y/N] `)).trim().toLowerCase();
    const approved = answer === 'y' || answer === 'yes';
    onEvent({ type: 'approval', description, approved, automatic: false });
    return approved;
  };
}
