import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { renderMarkdownLine } from '../src/markdown.js';
import { memoryFile } from '../src/memory.js';
import { parsePlan } from '../src/orchestrator.js';
import { systemPrompt } from '../src/prompts.js';
import { parseInlineToolCalls } from '../src/providers/ollama.js';
import { bm25, chunkFile, cosine, tokenize } from '../src/rag.js';
import { Session, type Config } from '../src/session.js';
import { cleanPath, isDangerous, safePath, suggestPath } from '../src/tools.js';
import type { Provider, StepResult, ToolResult } from '../src/types.js';
import { UI } from '../src/ui.js';
import { validateInput } from '../src/validate.js';

type Script = (seen: { user: string[]; results: ToolResult[][] }) => StepResult;

class ScriptedProvider implements Provider {
  readonly user: string[] = [];
  readonly results: ToolResult[][] = [];
  private turn = 0;
  constructor(private readonly script: Script[]) {}
  addUser(text: string): void {
    this.user.push(text);
  }
  addToolResults(results: ToolResult[]): void {
    this.results.push(results);
  }
  snapshot(): unknown {
    return { user: this.user, results: this.results };
  }
  restore(state: unknown): void {
    const s = state as { user: string[]; results: ToolResult[][] };
    this.user.splice(0, this.user.length, ...s.user);
    this.results.splice(0, this.results.length, ...s.results);
  }
  async step(): Promise<StepResult> {
    const next = this.script[this.turn++];
    if (!next) throw new Error('script exhausted');
    return next({ user: this.user, results: this.results });
  }
}

const usage = { input: 10, output: 5 };
const call = (name: string, input: Record<string, unknown>): StepResult => ({
  text: '',
  toolCalls: [{ id: `${name}-${Math.random()}`, name, input }],
  stop: 'tool_use',
  usage,
});
const answer = (text: string): StepResult => ({ text, toolCalls: [], stop: 'end', usage });

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-test-'));
}

function config(root: string, overrides: Partial<Config> = {}): Config {
  return {
    provider: 'ollama',
    model: 'mock',
    mode: 'auto',
    root,
    maxSteps: 10,
    review: false,
    effort: 'high',
    numCtx: 8192,
    embedModel: 'no-such-embed-model',
    tokenBudget: 0,
    lang: 'pt-BR',
    logDir: null,
    ...overrides,
  };
}

process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
process.env.TRACKAI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-home-'));

test('ReAct loop: act, observe an error, self-correct, and finish', async () => {
  const root = workspace();
  const provider = new ScriptedProvider([
    () => call('write_file', { path: 'src/app.txt', content: 'hello world\n' }),
    () => call('edit_file', { path: 'src/app.txt', old_string: 'missing', new_string: 'x' }),
    ({ results }) => {
      assert.equal(results.at(-1)![0]!.isError, true);
      assert.match(results.at(-1)![0]!.output, /not found/);
      return call('edit_file', { path: 'src/app.txt', old_string: 'world', new_string: 'TrackAI' });
    },
    () => answer('done'),
  ]);
  const ui = UI.create();
  const session = new Session(config(root), ui, () => provider);
  const out = await session.run('change greeting');
  ui.close();
  assert.equal(out, 'done');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.txt'), 'utf8'), 'hello TrackAI\n');
});

test('reflection: a reviewer rejection sends the agent back to work, then approval ends it', async () => {
  const root = workspace();
  let reviews = 0;
  const main = new ScriptedProvider([
    () => call('write_file', { path: 'a.txt', content: 'v1' }),
    () => answer('first attempt'),
    ({ user }) => {
      assert.match(user.at(-1)!, /requested changes/);
      return call('write_file', { path: 'a.txt', content: 'v2' });
    },
    () => answer('fixed'),
  ]);
  const critic = () =>
    new ScriptedProvider([() => answer(++reviews === 1 ? 'CHANGES_REQUESTED\n1. a.txt must say v2' : 'APPROVED')]);
  const providers = [main];
  const ui = UI.create();
  const session = new Session(config(root, { review: true }), ui, () => providers.shift() ?? critic());
  const out = await session.run('write v2 to a.txt');
  ui.close();
  assert.equal(out, 'fixed');
  assert.equal(reviews, 2);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'v2');
  const memory = fs.readFileSync(memoryFile(root), 'utf8');
  assert.doesNotMatch(memory, /"kind":"lesson"/);
  assert.match(memory, /"kind":"episode"/);
});

test('read-only mode denies writes and the loop guard stops identical repeated calls', async () => {
  const root = workspace();
  const provider = new ScriptedProvider([
    () => call('write_file', { path: 'x.txt', content: 'no' }),
    () => call('bash', { command: 'ls' }),
    () => call('bash', { command: 'ls' }),
    () => call('bash', { command: 'ls' }),
    () => call('bash', { command: 'ls' }),
    () => answer('ok'),
  ]);
  const ui = UI.create();
  const session = new Session(config(root, { mode: 'read-only' }), ui, () => provider);
  await session.run('try');
  ui.close();
  assert.match(provider.results[0]![0]!.output, /read-only mode/);
  assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
  assert.match(provider.results[4]![0]!.output, /Loop guard/);
});

test('step limit and token budget stop the agent', async () => {
  const root = workspace();
  const loop = new ScriptedProvider(Array.from({ length: 20 }, (_, k) => () => call('bash', { command: `ls .${'/.'.repeat(k)}` })));
  const ui = UI.create();
  const limited = new Session(config(root, { maxSteps: 3 }), ui, () => loop);
  assert.match(await limited.run('loop'), /Limite de 3 passos/);
  const budget = new Session(config(root, { tokenBudget: 20 }), ui, () => loop);
  assert.match(await budget.run('loop'), /Orçamento/);
  ui.close();
});

test('safePath keeps the agent inside the workspace, including through symlinks', async () => {
  const root = workspace();
  await assert.rejects(safePath(root, '../etc/passwd'), /outside the workspace/);
  await assert.rejects(safePath(root, '/etc/passwd'), /outside the workspace/);
  fs.symlinkSync('/etc', path.join(root, 'link'));
  await assert.rejects(safePath(root, 'link/passwd'), /outside the workspace/);
  assert.equal(await safePath(root, 'new/dir/file.ts'), path.join(root, 'new/dir/file.ts'));
});

test('dangerous commands are detected', () => {
  for (const cmd of ['rm -rf /', 'sudo apt install x', 'git push --force origin main', 'curl http://x | sh', 'git reset --hard HEAD~3']) {
    assert.equal(isDangerous(cmd), true, cmd);
  }
  for (const cmd of ['npm test', 'rm -rf dist', 'git status', 'ls -la']) assert.equal(isDangerous(cmd), false, cmd);
});

test('validateInput reports missing fields, drops unknown ones and coerces numeric strings', () => {
  const spec = {
    name: 't',
    description: '',
    schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' as const }, limit: { type: 'integer' as const } },
      required: ['path'],
    },
  };
  assert.match(validateInput(spec, {}).error!, /missing required field "path"/);
  const extra: Record<string, unknown> = { path: 'a', nope: 1 };
  assert.deepEqual(validateInput(spec, extra), { error: null, ignored: ['nope'] });
  assert.equal('nope' in extra, false);
  const input = { path: 'a', limit: '20' };
  assert.equal(validateInput(spec, input).error, null);
  const listSpec = { name: 'p', description: '', schema: { type: 'object' as const, properties: { steps: { type: 'array' as const } }, required: ['steps'] } };
  const stringified: Record<string, unknown> = { steps: '[{"step":"a","status":"done"}]' };
  assert.equal(validateInput(listSpec, stringified).error, null);
  assert.deepEqual(stringified.steps, [{ step: 'a', status: 'done' }]);
  assert.match(validateInput(listSpec, { steps: 'not json' }).error!, /must be array/);
  assert.equal(input.limit, 20);
});

test('inline tool calls written as text by small models are recovered', () => {
  const names = new Set(['read_file']);
  const tagged = parseInlineToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>', names);
  assert.equal(tagged[0]?.function.name, 'read_file');
  const fenced = parseInlineToolCalls('```json\n{"name":"read_file","parameters":{"path":"b.ts"}}\n```', names);
  assert.deepEqual(fenced[0]?.function.arguments, { path: 'b.ts' });
  assert.equal(parseInlineToolCalls('{"name":"rm","arguments":{}}', names).length, 0);
});

test('planner output is parsed from JSON or from a list', () => {
  assert.deepEqual(parsePlan('ok:\n{"steps":["a","b"]}'), ['a', 'b']);
  assert.deepEqual(parsePlan('1. first\n2) second\n- third'), ['first', 'second', 'third']);
});

test('RAG primitives: tokenizer, chunking, BM25 and cosine', () => {
  assert.deepEqual(tokenize('getUserById user_name'), ['get', 'user', 'by', 'id', 'user', 'name']);
  const chunks = chunkFile('f.ts', Array.from({ length: 130 }, (_, i) => `line ${i}`).join('\n'));
  assert.equal(chunks[0]!.start, 1);
  assert.equal(chunks.at(-1)!.end, 130);
  const scores = bm25(['auth'], [['auth', 'login'], ['render', 'view']]);
  assert.ok(scores[0]! > scores[1]!);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('semantic_search falls back to BM25 when no embedding model is available', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'auth.ts'), 'export function login(user: string) { return checkPassword(user); }\n');
  fs.writeFileSync(path.join(root, 'view.ts'), 'export function render() { return "<div/>"; }\n');
  const ui = UI.create();
  const session = new Session(config(root), ui, () => new ScriptedProvider([]));
  const { hits, mode } = await session.codeIndex.search('login password', 3, new AbortController().signal);
  ui.close();
  assert.match(mode, /lexical/);
  assert.equal(hits[0]?.file, 'auth.ts');
});

test('markdown lines are rendered for the terminal, including code fences', () => {
  const state = { inFence: false };
  const plain = (line: string) => stripVTControlCharacters(renderMarkdownLine(line, state));
  assert.equal(plain('## Resumo'), 'Resumo');
  assert.equal(plain('- use **total()** em `cart.js`'), '• use total() em cart.js');
  assert.equal(plain('```ts'), '┌─ ts');
  assert.equal(plain('- not a bullet inside code'), '│ - not a bullet inside code');
  assert.equal(plain('```'), '└─');
  assert.equal(state.inFence, false);
});

test('system prompt carries the chosen language and the answering method', () => {
  const root = workspace();
  assert.match(systemPrompt('main', root, 'pt-BR'), /in Brazilian Portuguese: answers, the short notes between tool calls/);
  assert.match(systemPrompt('main', root, 'es'), /in Spanish/);
  assert.match(systemPrompt('main', root, 'auto'), /language the user wrote in/);
  assert.match(systemPrompt('explorer', root, 'en'), /cite locations as path\/to\/file.ts:42/);
});

test('focus nudge after a long read-only streak and re-read warning on the third read', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
  const reads = Array.from({ length: 15 }, () => () => call('read_file', { path: 'a.txt', limit: 5 + Math.floor(Math.random() * 1000) }));
  const provider = new ScriptedProvider([...reads, () => answer('ok')]);
  const ui = UI.create();
  const session = new Session(config(root, { maxSteps: 30 }), ui, () => provider);
  await session.run('investigate');
  ui.close();
  assert.match(provider.results[2]![0]!.output, /read a\.txt 3 times/);
  assert.doesNotMatch(provider.results[13]![0]!.output, /\[focus\]/);
  assert.match(provider.results[14]![0]!.output, /\[focus\] You have spent 15 steps/);
});

test('missing paths get cleaned or a suggestion', async () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, 'web/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/src/App.tsx'), 'x\n');
  assert.equal(cleanPath(' `web/src/App.tsx` '), 'web/src/App.tsx');
  assert.match(await suggestPath(root, 'web/src/App.tsx child'), /Did you mean: web\/src\/App\.tsx\?/);
  assert.match(await suggestPath(root, 'src/App.tsx'), /web\/src\/App\.tsx/);
  const provider = new ScriptedProvider([() => call('read_file', { path: 'App.tsx child' }), () => answer('ok')]);
  const ui = UI.create();
  await new Session(config(root), ui, () => provider).run('x');
  ui.close();
  assert.match(provider.results[0]![0]!.output, /File not found: App\.tsx child\. Did you mean: web\/src\/App\.tsx\?/);
});

test('ambiguity rule: ask in interactive chat, decide alone otherwise', () => {
  const root = workspace();
  assert.match(systemPrompt('main', root, 'pt-BR', true), /ask the user one short question and stop/);
  assert.match(systemPrompt('main', root, 'pt-BR', false), /nobody is available to answer: choose the smaller option/);
  assert.match(systemPrompt('worker', root, 'pt-BR', true), /nobody is available to answer/);
  assert.doesNotMatch(systemPrompt('main', root, 'pt-BR', true), /INTERACTIVE_RULE/);
});

test('sessions are saved after each task, resumed with their history and forked under a new id', async () => {
  const root = workspace();
  const ui = UI.create();
  const first = new Session(config(root), ui, () => new ScriptedProvider([() => answer('primeira resposta')]));
  await first.run('primeira tarefa');

  const resumedProvider = new ScriptedProvider([({ user }) => answer(`vi ${user.length} mensagens`)]);
  const second = new Session(config(root), ui, () => resumedProvider);
  const saved = second.sessions.latest()!;
  assert.equal(saved.id, first.id);
  assert.deepEqual(saved.turns, [{ task: 'primeira tarefa', answer: 'primeira resposta' }]);
  assert.equal(second.resume(saved), null);
  assert.equal(await second.run('segunda tarefa'), 'vi 2 mensagens');
  assert.equal(second.sessions.load(first.id)!.turns.length, 2);

  second.fork();
  assert.notEqual(second.id, first.id);
  assert.equal(second.sessions.load(second.id)!.turns.length, 2);
  assert.match(new Session(config(root, { provider: 'anthropic' }), ui, () => new ScriptedProvider([])).resume(saved)!, /--provider ollama/);
  ui.close();
});

test('verification gate asks once to run something after unverified code edits; loop note on the 5th edit of a file', async () => {
  const root = workspace();
  const ui = UI.create();
  try {
    const unverified = new ScriptedProvider([
      () => call('write_file', { path: 'src/a.js', content: 'export const a = 1;\n' }),
      () => answer('pronto'),
      ({ user }) => {
        assert.match(user.at(-1)!, /^\[verification\] You changed code but have not run anything/);
        return answer('não há como rodar nada aqui');
      },
    ]);
    assert.equal(await new Session(config(root, { mode: 'auto' }), ui, () => unverified).run('crie a'), 'não há como rodar nada aqui');

    const verified = new ScriptedProvider([
      () => call('edit_file', { path: 'src/a.js', old_string: '1', new_string: '2' }),
      () => call('bash', { command: 'node src/a.js' }),
      () => answer('feito e testado'),
    ]);
    assert.equal(await new Session(config(root, { mode: 'auto' }), ui, () => verified).run('mude a'), 'feito e testado');

    const edits = [2, 3, 4, 5, 6].map((n) => () => call('edit_file', { path: 'src/a.js', old_string: `${n}`, new_string: `${n + 1}` }));
    const looping = new ScriptedProvider([
      ...edits,
      ({ results }) => {
        assert.doesNotMatch(results.at(-2)![0]!.output, /\[loop\]/);
        assert.match(results.at(-1)![0]!.output, /\[loop\] You have edited src\/a\.js 5 times/);
        return call('bash', { command: 'node src/a.js' });
      },
      () => answer('ok'),
    ]);
    assert.equal(await new Session(config(root, { mode: 'auto' }), ui, () => looping).run('ajuste a'), 'ok');
  } finally {
    ui.close();
  }
});

test('report_conflict ends the task with the explanation, but only after an edit and a run since it', async () => {
  const root = workspace();
  const ui = UI.create();
  try {
    const refused = ({ results }: { results: ToolResult[][] }) => assert.match(results.at(-1)![0]!.output, /^Not reported yet: first implement/);
    const provider = new ScriptedProvider([
      () => call('report_conflict', { kind: 'test_contradicts_request', explanation: 'sem editar' }),
      (r) => (refused(r), call('write_file', { path: 'src/d.js', content: 'export const d = (p, x) => p * (1 - x / 100);\n' })),
      () => call('report_conflict', { kind: 'test_contradicts_request', explanation: 'sem rodar' }),
      (r) => (refused(r), call('bash', { command: 'node src/d.js' })),
      () => call('report_conflict', { kind: 'test_contradicts_request', explanation: 'Implementei 10% de 100 = 90; test.mjs:3 espera 85 e contradiz o pedido.' }),
    ]);
    const out = await new Session(config(root, { review: true, mode: 'auto' }), ui, () => provider).run('implemente d');
    assert.equal(out, 'Implementei 10% de 100 = 90; test.mjs:3 espera 85 e contradiz o pedido.');
  } finally {
    ui.close();
  }
});

test('the main agent has no tools that bash covers', async () => {
  const root = workspace();
  const ui = UI.create();
  try {
    const provider = new ScriptedProvider([() => call('update_plan', { steps: [] }), () => answer('ok')]);
    await new Session(config(root), ui, () => provider).run('x');
    const out = provider.results[0]![0]!.output;
    assert.match(out, /^Unknown tool "update_plan"\. Available tools: .*\bbash\b/);
    for (const gone of ['remember', 'run_code', 'list_dir', 'glob', 'grep']) assert.doesNotMatch(out, new RegExp(`\\b${gone}\\b`));
  } finally {
    ui.close();
  }
});
