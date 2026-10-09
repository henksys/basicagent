// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Henk
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, parseSkillFile, discoverSkills, skillIndexText, loadSkillTool } from '../src/skills.mjs';

test('parses plain, folded and literal frontmatter', () => {
  const plain = parseFrontmatter('---\nname: demo\ndescription: One line.\n---\nBody here.\n');
  assert.equal(plain.meta.name, 'demo');
  assert.equal(plain.meta.description, 'One line.');
  assert.equal(plain.body, 'Body here.\n');

  const folded = parseFrontmatter('---\nname: f\ndescription: >\n  line one\n  line two\n\n  new paragraph\n---\nrest');
  assert.equal(folded.meta.description, 'line one line two\nnew paragraph');

  const literal = parseFrontmatter('---\nname: l\ndescription: |\n  first\n  second\n---\nrest');
  assert.equal(literal.meta.description, 'first\nsecond');
});

test('files without frontmatter pass through untouched', () => {
  const { meta, body } = parseFrontmatter('# Just a document\n');
  assert.deepEqual(meta, {});
  assert.equal(body, '# Just a document\n');
});

test('parseSkillFile falls back to the first body line for a description', () => {
  const skill = parseSkillFile('# My skill\nThis is what it does.\n', 'fallback');
  assert.equal(skill.name, 'fallback');
  assert.equal(skill.description, 'This is what it does.');
});

test('discovers skills, keeps the first duplicate and skips broken files', () => {
  const root1 = mkdtempSync(join(tmpdir(), 'basicagent-skills-a-'));
  const root2 = mkdtempSync(join(tmpdir(), 'basicagent-skills-b-'));
  try {
    mkdirSync(join(root1, 'alpha'));
    mkdirSync(join(root1, 'broken'));
    mkdirSync(join(root2, 'beta'));
    mkdirSync(join(root2, 'alpha'));
    writeFileSync(join(root1, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: first alpha\n---\nbody alpha');
    writeFileSync(join(root2, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: >\n  folded\n  beta\n---\nbody beta');
    writeFileSync(join(root2, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: second alpha\n---\nbody');
    writeFileSync(join(root1, 'broken', 'SKILL.md'), 'not even close');

    const skills = discoverSkills([root1, root2, join(root1, 'does-not-exist')]);
    assert.deepEqual([...skills.keys()].sort(), ['alpha', 'beta', 'broken']);
    assert.equal(skills.get('alpha').description, 'first alpha');
    assert.equal(skills.get('beta').description, 'folded beta');
    assert.match(skillIndexText(skills), /- beta: folded beta/);
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test('load_skill returns the body and directory, unknown names fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basicagent-skill-tool-'));
  try {
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nDo the demo thing.');
    const skills = discoverSkills([dir]);
    const tool = loadSkillTool(skills);

    const result = await tool.run({ name: 'demo' }, {});
    assert.equal(result.name, 'demo');
    assert.equal(result.dir, join(dir, 'demo'));
    assert.equal(result.instructions, 'Do the demo thing.');
    await assert.rejects(() => tool.run({ name: 'nope' }, {}), /Unknown skill/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery follows symlinked skill directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'basicagent-skills-link-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'basicagent-skills-real-'));
  try {
    mkdirSync(join(elsewhere, 'linked-skill'));
    writeFileSync(join(elsewhere, 'linked-skill', 'SKILL.md'), '---\nname: linked\ndescription: via symlink\n---\nbody');
    symlinkSync(join(elsewhere, 'linked-skill'), join(root, 'linked'));

    const skills = discoverSkills([root]);
    assert.equal(skills.get('linked').description, 'via symlink');
    assert.equal(skills.get('linked').path, join(root, 'linked', 'SKILL.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
