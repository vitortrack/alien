import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Criterion, Judge } from '../src/contract.js';
import { gateFor, orderedChecks } from '../src/gate.js';
import { digest } from '../src/rhi.js';

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-gate-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'old\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

function judge(reply: unknown): Judge & { prompts: string[]; tools: string[][] } {
  const j = {
    costUsd: 0,
    prompts: [] as string[],
    tools: [] as string[][],
    async ask<R>(prompt: string, _s: object, tools: string[]): Promise<R> {
      j.prompts.push(prompt);
      j.tools.push(tools);
      return reply as R;
    },
  };
  return j;
}

test('gate: written in one call from the request and the file list, without tools, then checked against the current code', async () => {
  const root = repo();
  const checks: Criterion[] = [
    { text: 'a.txt says new', check: 'grep -q new a.txt', guard: false },
    { text: 'already true', check: 'grep -q old a.txt', guard: false },
    { text: 'build passes', check: 'true', guard: true },
    { text: 'broken guard', check: 'false', guard: true },
  ];
  const j = judge({ slices: [{ title: 'all', spec: '', files: [], criteria: checks }] });
  const file = path.join(root, '.trackai', 'gate.json');
  const gate = await gateFor(root, 'make a.txt say new', j, file);
  assert.deepEqual(gate.map((c) => c.text), ['a.txt says new', 'build passes']);
  assert.deepEqual(j.tools[0], []);
  assert.match(j.prompts[0]!, /make a\.txt say new/);
  assert.match(j.prompts[0]!, /\ba\.txt\b/);
  assert.match(j.prompts[0]!, /Do not explore/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), gate);
});

test('gate: a saved gate file is reused for the whole card without calling the judge again', async () => {
  const root = repo();
  const file = path.join(root, 'gate.json');
  const saved: Criterion[] = [{ text: 'x', check: 'true', guard: false }];
  fs.writeFileSync(file, JSON.stringify(saved));
  const j = judge({ slices: [] });
  assert.deepEqual(await gateFor(root, 'anything', j, file), saved);
  assert.equal(j.prompts.length, 0);
});

test('gate: cheap criteria run first and the slow guards only when every criterion passes', async () => {
  const root = repo();
  const marker = path.join(root, 'guard-ran');
  const gate: Criterion[] = [
    { text: 'type-check', check: `touch ${marker}`, guard: true },
    { text: 'a.txt says new', check: 'grep -q new a.txt', guard: false },
  ];
  const first = await orderedChecks(root, gate);
  assert.equal(first.filter((r) => !r.pass).length, 1);
  assert.equal(fs.existsSync(marker), false);
  fs.writeFileSync(path.join(root, 'a.txt'), 'new\n');
  const second = await orderedChecks(root, gate);
  assert.equal(second.every((r) => r.pass), true);
  assert.equal(fs.existsSync(marker), true);
});

test('digest: the reference documents are summarized for the request, inline and without tools', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-docs-'));
  const doc = path.join(dir, 'spike.txt');
  fs.writeFileSync(doc, 'LADO = 472\nirrelevant history');
  const j = judge({ digest: '- LADO = 472 (spike.txt)' });
  assert.equal(await digest(j, 'crop to the card size', [doc]), '- LADO = 472 (spike.txt)');
  assert.match(j.prompts[0]!, /<document path=".*spike\.txt">\nLADO = 472/);
  assert.match(j.prompts[0]!, /crop to the card size/);
  assert.deepEqual(j.tools[0], []);
});

test('gate: the project instructions go into the prompt so rules like "every change has tests" become checks', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Toda alteração entrega testes de todos os cenários.');
  const j = judge({ slices: [{ title: 'all', spec: '', files: [], criteria: [] }] });
  await gateFor(root, 'make a.txt say new', j);
  assert.match(j.prompts[0]!, /<project_instructions>[\s\S]*testes de todos os cenários/);
});
