import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bestOf, pickBest } from '../src/attempts.js';
import type { Config } from '../src/session.js';
import type { Provider, StepResult, ToolResult } from '../src/types.js';
import { UI } from '../src/ui.js';

process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
process.env.TRACKAI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-home-'));

const usage = { input: 1, output: 1 };
const write = (p: string, content: string): StepResult => ({
  text: '',
  toolCalls: [{ id: Math.random().toString(), name: 'write_file', input: { path: p, content } }],
  stop: 'tool_use',
  usage,
});
const done = (text: string): StepResult => ({ text, toolCalls: [], stop: 'end', usage });

function scripted(steps: StepResult[]): Provider {
  let i = 0;
  return { addUser() {}, addToolResults(_r: ToolResult[]) {}, snapshot: () => null, restore() {}, step: async () => steps[i++] ?? done('fim') };
}

test('pickBest prefers finished, tested, smallest diffs', () => {
  const c = (index: number, files: number, tests: 'pass' | 'fail' | 'none', error?: string) => ({ index, files: Array(files).fill('f'), lines: files * 3, tests, error });
  assert.equal(pickBest([c(1, 4, 'pass'), c(2, 2, 'pass'), c(3, 1, 'fail')])!.index, 2);
  assert.equal(pickBest([c(1, 1, 'pass', 'Limite'), c(2, 3, 'pass')])!.index, 2);
  assert.equal(pickBest([c(1, 0, 'none'), c(2, 2, 'none')])!.index, 2);
});

test('bestOf runs isolated attempts, applies only the smallest passing one and cleans up', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-best-'));
  const sh = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module","scripts":{"test":"node test.mjs"}}');
  fs.writeFileSync(path.join(root, 'test.mjs'), "import fs from 'node:fs'; if (!fs.existsSync('feature.js')) process.exit(1);\n");
  sh('init', '-q');
  sh('add', '.');
  sh('commit', '-qm', 'init');
  fs.writeFileSync(path.join(root, 'wip.txt'), 'uncommitted work of the user\n');

  const plans = [
    [write('feature.js', 'export const f = 1;\n'), write('backend/extra.js', 'export {};\n'), done('A: com extra')],
    [write('feature.js', 'export const f = 1;\n'), done('B: mínimo')],
  ];
  const cfg: Config = {
    provider: 'ollama', model: 'mock', mode: 'auto', root, maxSteps: 10, review: false, effort: 'high',
    numCtx: 8192, embedModel: 'none', tokenBudget: 0, lang: 'pt-BR', logDir: null,
  };
  const ui = UI.create();
  const result = await bestOf(cfg, ui, 'crie a feature', 2, () => scripted(plans.shift() ?? []));
  ui.close();

  assert.equal(result.answer, 'B: mínimo');
  assert.equal(fs.existsSync(path.join(root, 'feature.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'backend/extra.js')), false);
  assert.equal(fs.readFileSync(path.join(root, 'wip.txt'), 'utf8'), 'uncommitted work of the user\n');
  assert.match(result.summary, /Escolhida a tentativa 2/);
  assert.equal(sh('worktree', 'list').trim().split('\n').length, 1);
});
