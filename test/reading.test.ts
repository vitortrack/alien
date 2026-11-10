import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allTools, type ToolContext } from '../src/tools.js';

const tool = (name: string) => allTools.find((t) => t.name === name)!;
function context(root: string): ToolContext {
  return { root, signal: new AbortController().signal, files: new Map() } as unknown as ToolContext;
}

test('read_file: a big file without a range comes back as an outline plus the first 100 lines', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-read-'));
  const body = Array.from({ length: 400 }, (_, k) => (k === 250 ? 'export function target(x: number) {' : `  const v${k} = ${k};`));
  fs.writeFileSync(path.join(root, 'big.ts'), body.join('\n'));
  const out = await tool('read_file').run({ path: 'big.ts' }, context(root));
  assert.match(out, /\[outline: declarations with their line numbers[^\n]*\n\s+251\texport function target/);
  assert.match(out, /\[big\.ts: lines 1-100 of 400\]/);
  assert.match(out, /continue with offset=101/);
  const ranged = await tool('read_file').run({ path: 'big.ts', offset: 240, limit: 20 }, context(root));
  assert.doesNotMatch(ranged, /\[outline/);
  assert.match(ranged, /lines 240-259 of 400/);
});

test('grep: many matches come back summarized per file; few matches come back in full', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-grep-'));
  for (let f = 0; f < 5; f++) fs.writeFileSync(path.join(root, `f${f}.ts`), Array.from({ length: 10 }, (_, k) => `photo ${f}.${k}`).join('\n'));
  const many = await tool('grep').run({ pattern: 'photo' }, context(root));
  assert.match(many, /^50 matches in 5 files/);
  assert.match(many, /f0\.ts \(10\): 1:photo 0\.0/);
  const few = await tool('grep').run({ pattern: 'photo 3\\.[12]' }, context(root));
  assert.equal(few.split('\n').length, 2);
});
