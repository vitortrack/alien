import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Judge } from '../src/contract.js';
import { compare, refine, type Verdict } from '../src/rhi.js';
import { Session, type Config } from '../src/session.js';
import type { Provider, StepRequest, StepResult, ToolResult } from '../src/types.js';
import { UI } from '../src/ui.js';

process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
process.env.ALIEN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alien-home-'));

function fakeJudge<T>(reply: T): Judge & { prompts: string[]; tools: string[][] } {
  const judge = {
    costUsd: 0,
    prompts: [] as string[],
    tools: [] as string[][],
    async ask<R>(prompt: string, _schema: object, tools: string[]): Promise<R> {
      judge.prompts.push(prompt);
      judge.tools.push(tools);
      return reply as unknown as R;
    },
  };
  return judge;
}

test('rhi compare: one pairwise judgment over both outputs, truncated by the same rule', async () => {
  const judge = fakeJudge<Verdict>({ winner: 'B', rationale: 'B covers item 2' });
  const long = 'x'.repeat(200_000);
  const verdict = await compare(judge, 'make the widget', `diff A\n${long}`, 'diff B');
  assert.deepEqual(verdict, { winner: 'B', rationale: 'B covers item 2' });
  const prompt = judge.prompts[0]!;
  assert.match(prompt, /<request>\nmake the widget\n<\/request>/);
  assert.match(prompt, /<output_A>\ndiff A/);
  assert.match(prompt, /<output_B>\ndiff B\n<\/output_B>/);
  assert.match(prompt, /truncated/);
  assert.ok(prompt.length < 120_000);
  assert.deepEqual(judge.tools[0], []);
});

test('rhi refine: rewrites only the task harness from evidence and the pairwise history, for a single agent', async () => {
  const judge = fakeJudge({ harness: 'Steps:\n1. migration first', changes: ['ordered steps'], evidence_used: ['gate: 2 checks failed'] });
  const history: Verdict[] = [{ winner: 'A', rationale: 'A kept the CHECK' }];
  const out = await refine(judge, 'make the widget', '', 'gate: 2 checks failed', history);
  assert.equal(out.harness, 'Steps:\n1. migration first');
  const prompt = judge.prompts[0]!;
  assert.match(prompt, /<current_harness>\n\(empty\)\n<\/current_harness>/);
  assert.match(prompt, /gate: 2 checks failed/);
  assert.match(prompt, /1\. winner: A — A kept the CHECK/);
  assert.match(prompt, /single agent/);
  assert.match(prompt, /Do not change the request/);
});

class Scripted implements Provider {
  readonly user: string[] = [];
  constructor(private readonly steps: ((user: string[]) => StepResult)[]) {}
  addUser(t: string): void {
    this.user.push(t);
  }
  addToolResults(_r: ToolResult[]): void {}
  snapshot(): unknown {
    return {};
  }
  restore(): void {}
  async step(_req: StepRequest): Promise<StepResult> {
    return this.steps.shift()!(this.user);
  }
}

test('task harness: the refined harness text opens the task, before the request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alien-test-'));
  const cfg: Config = { provider: 'ollama', model: 'mock', mode: 'auto', root, maxSteps: 5, review: false, effort: 'high', numCtx: 8192, embedModel: 'none', tokenBudget: 0, lang: 'pt-BR', logDir: null, harness: 'Steps:\n1. migration first' };
  const provider = new Scripted([
    (user) => {
      assert.match(user[0]!, /^<task_harness>\nSteps:\n1\. migration first\n<\/task_harness>\n\nmake the widget/);
      return { text: 'ok', toolCalls: [], stop: 'end', usage: { input: 1, output: 1 } };
    },
  ]);
  const ui = UI.create();
  assert.equal(await new Session(cfg, ui, () => provider).run('make the widget'), 'ok');
  ui.close();
});
