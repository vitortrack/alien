import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactAt, OllamaProvider } from '../src/providers/ollama.js';
import type { StepRequest } from '../src/types.js';

type Message = { role: string; content: string };

function stubOllama(promptTokens: number): { chats: Message[][]; summaries: number } {
  const seen = { chats: [] as Message[][], summaries: 0 };
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { stream: boolean; messages: Message[] };
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ model_info: { 'm.context_length': 1000 }, remote_host: 'cloud' }));
    if (!body.stream) {
      seen.summaries++;
      return new Response(JSON.stringify({ message: { content: 'checkpoint summary' } }));
    }
    seen.chats.push(body.messages);
    const chunk = { message: { tool_calls: [{ function: { name: 'bash', arguments: { command: 'ls' } } }] }, done: true, prompt_eval_count: promptTokens, eval_count: 1 };
    return new Response(`${JSON.stringify(chunk)}\n`);
  }) as typeof fetch;
  return seen;
}

test('compaction runs in a single long task and keeps the original request verbatim', async () => {
  const task = `Implement the card.\n${'- acceptance criterion\n'.repeat(400)}- LAST CRITERION: export blocks pending photos`;
  const seen = stubOllama(900);
  const provider = new OllamaProvider('glm:cloud', 1000);
  const req: StepRequest = { system: 's', task, changedFiles: ['src/a.ts'], tools: [{ name: 'bash', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  provider.addUser(task);
  let compactions = 0;
  for (let i = 0; i < 8; i++) {
    const r = await provider.step(req);
    if (r.compacted) compactions++;
    provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: 'ok', isError: false })));
  }
  assert.ok(seen.summaries > 0, 'compaction never ran');
  assert.equal(compactions, seen.summaries);
  const last = seen.chats.at(-1)!;
  assert.ok(last.some((m) => m.role === 'user' && m.content.includes(task)), 'original request lost after compaction');
  const checkpoint = last.find((m) => m.content.includes('checkpoint summary'))!;
  assert.match(checkpoint.content, /Do not explore the project again/);
  assert.match(checkpoint.content, /Files you already changed in this task: src\/a\.ts/);
  assert.notEqual(last[1]?.role, 'tool', 'history must not start with an orphan tool result');
});

test('cloud models compact at a fixed token cap; small local windows keep the ratio', () => {
  assert.equal(compactAt(262_144), 150_000);
  assert.equal(compactAt(8192), 6144);
});

test('observations older than the last 10 are masked in blocks of 10, so the prefix stays stable between steps', async () => {
  const seen = stubOllama(10);
  const provider = new OllamaProvider('glm:cloud', 1000);
  const req: StepRequest = { system: 's', tools: [{ name: 'bash', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  provider.addUser('task');
  const masked = () => seen.chats.at(-1)!.filter((m) => m.role === 'tool' && m.content.includes('elided')).length;
  for (let i = 0; i < 25; i++) {
    const r = await provider.step(req);
    provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: `out ${i} ${'x'.repeat(2000)}`, isError: false })));
  }
  await provider.step(req);
  assert.equal(masked(), 10);
  provider.addToolResults([{ id: 'z', name: 'bash', output: 'y'.repeat(2000), isError: false }]);
  await provider.step(req);
  assert.equal(masked(), 10);
});
