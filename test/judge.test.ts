import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { agentJudge, schemaError } from '../src/judge.js';
import { Session, type Config } from '../src/session.js';
import type { Provider, StepRequest, StepResult, ToolResult } from '../src/types.js';
import { UI } from '../src/ui.js';

process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
process.env.TRACKAI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-home-'));
const ui = UI.create();
after(() => ui.close());

const SCHEMA = { type: 'object', properties: { winner: { type: 'string', enum: ['A', 'B', 'tie'] }, notes: { type: 'array', items: { type: 'string' } } }, required: ['winner', 'notes'], additionalProperties: false };
const usage = { input: 10, output: 5 };
const answer = (text: string): StepResult => ({ text, toolCalls: [], stop: 'end', usage });

class Scripted implements Provider {
  readonly user: string[] = [];
  readonly requests: StepRequest[] = [];
  constructor(private readonly steps: ((user: string[]) => StepResult)[]) {}
  addUser(t: string): void {
    this.user.push(t);
  }
  addToolResults(_r: ToolResult[]): void {}
  snapshot(): unknown {
    return {};
  }
  restore(): void {}
  async step(req: StepRequest): Promise<StepResult> {
    this.requests.push(req);
    return this.steps.shift()!(this.user);
  }
}

function session(providers: Scripted[]): Session {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-judge-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  const cfg: Config = { provider: 'ollama', model: 'mock', mode: 'auto', root, maxSteps: 10, review: false, effort: 'high', numCtx: 8192, embedModel: 'none', tokenBudget: 0, lang: 'pt-BR', logDir: null };
  const queue: Scripted[] = [new Scripted([]), ...providers];
  return new Session(cfg, ui, () => queue.shift()!);
}

test('schemaError: required keys, types, enums and array items', () => {
  assert.equal(schemaError({ winner: 'A', notes: ['x'] }, SCHEMA), null);
  assert.match(schemaError({ notes: [] }, SCHEMA)!, /winner/);
  assert.match(schemaError({ winner: 'C', notes: [] }, SCHEMA)!, /winner.*A, B, tie/);
  assert.match(schemaError({ winner: 'A', notes: [1] }, SCHEMA)!, /notes\[0\].*string/);
});

test('agent judge without tools: one call with no tools, JSON taken from the answer and checked against the schema', async () => {
  const p = new Scripted([() => answer('Here it is:\n```json\n{"winner":"B","notes":["covers 2"]}\n```')]);
  const s = session([p]);
  const out = await agentJudge(s).ask<{ winner: string }>('compare these', SCHEMA, []);
  assert.deepEqual(out, { winner: 'B', notes: ['covers 2'] });
  assert.deepEqual(p.requests[0]!.tools, []);
  assert.match(p.user[0]!, /compare these/);
  assert.match(p.user[0]!, /"winner"/);
});

test('agent judge: an answer that breaks the schema is sent back with the error until it is valid', async () => {
  const p = new Scripted([
    () => answer('{"winner":"maybe","notes":[]}'),
    (user) => {
      assert.match(user.at(-1)!, /winner/);
      return answer('{"winner":"tie","notes":[]}');
    },
  ]);
  assert.deepEqual(await agentJudge(session([p])).ask('compare', SCHEMA, []), { winner: 'tie', notes: [] });
});

test('agent judge: gives up with an explanation after repeated invalid answers', async () => {
  const p = new Scripted([() => answer('no json'), () => answer('still none'), () => answer('nope')]);
  await assert.rejects(agentJudge(session([p])).ask('compare', SCHEMA, []), /JSON/);
});

test('agent judge with tools: a read-only TrackAI agent explores the workspace and ends with the JSON', async () => {
  const explorer = new Scripted([
    () => ({ text: '', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.txt' } }], stop: 'tool_use', usage }),
    () => answer('{"winner":"A","notes":["read a.txt"]}'),
  ]);
  const s = session([explorer]);
  const out = await agentJudge(s).ask('look at the repo', SCHEMA, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(out, { winner: 'A', notes: ['read a.txt'] });
  const names = explorer.requests[0]!.tools.map((t) => t.name);
  assert.ok(names.includes('read_file'));
  assert.ok(!names.includes('write_file') && !names.includes('edit_file') && !names.includes('bash'));
});
