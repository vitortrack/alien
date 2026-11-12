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

test('images go to the model only when it has vision; the history keeps them for a later vision model', async () => {
  const sent: { images?: string[] }[][] = [];
  const stub = (capabilities: string[]) => {
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      if (url.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities }));
      sent.push((JSON.parse(init.body) as { messages: { images?: string[] }[] }).messages);
      return new Response(`${JSON.stringify({ message: { content: 'ok' }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`);
    }) as typeof fetch;
  };
  const req: StepRequest = { system: 's', tools: [], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  stub(['completion', 'vision']);
  const seeing = new OllamaProvider('glm:cloud', 1000);
  seeing.addUser('what is in the print?', [{ mime: 'image/png', data: 'aGVsbG8=' }]);
  await seeing.step(req);
  assert.deepEqual(sent.at(-1)![1]!.images, ['aGVsbG8=']);
  stub(['completion']);
  const blind = new OllamaProvider('qwen3:8b', 1000);
  blind.restore(seeing.snapshot());
  await blind.step(req);
  assert.equal(sent.at(-1)![1]!.images, undefined);
  assert.deepEqual((blind.snapshot() as { history: { images?: string[] }[] }).history[0]!.images, ['aGVsbG8=']);
});

test('prune: identical tool outputs keep only the newest copy; old big tool-call arguments shrink in blocks', async () => {
  const sent: { role: string; content: string; tool_calls?: { function: { arguments: Record<string, string> } }[] }[][] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ model_info: { 'm.context_length': 100000 }, remote_host: 'cloud' }));
    sent.push((JSON.parse(init.body) as { messages: (typeof sent)[number] }).messages);
    const chunk = { message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a.ts', content: 'c'.repeat(5000) } } }] }, done: true, prompt_eval_count: 10, eval_count: 1 };
    return new Response(`${JSON.stringify(chunk)}\n`);
  }) as typeof fetch;
  const provider = new OllamaProvider('glm:cloud', 1000);
  const req: StepRequest = { system: 's', tools: [{ name: 'write_file', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: () => {} };
  provider.addUser('task');
  const same = `same output ${'z'.repeat(300)}`;
  for (let i = 0; i < 21; i++) {
    const r = await provider.step(req);
    provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: i === 3 || i === 20 ? same : `out ${i}`, isError: false })));
  }
  await provider.step(req);
  const last = sent.at(-1)!;
  const tools = last.filter((m) => m.role === 'tool');
  assert.match(tools[3]!.content, /^\[identical to a later output of this tool/);
  assert.equal(tools[20]!.content, same);
  const args = last.filter((m) => m.tool_calls).map((m) => m.tool_calls![0]!.function.arguments.content!);
  assert.equal(args.filter((a) => a.includes('characters elided')).length, 10);
  assert.ok(args.slice(0, 10).every((a) => a.length < 400) && args.slice(10).every((a) => a.length === 5000));
  assert.equal(last.filter((m) => m.tool_calls)[0]!.tool_calls![0]!.function.arguments.path, 'a.ts');
});

test('think tags in content become reasoning even when split across chunks; prose that only mentions them stays text', async () => {
  const { ThinkSplitter } = await import('../src/providers/ollama.js');
  const run = (chunks: string[]) => {
    const s = new ThinkSplitter();
    const out = { text: '', thinking: '' };
    for (const c of [...chunks.map((c) => s.push(c)), s.flush()]) {
      out.text += c.text;
      out.thinking += c.thinking;
    }
    return out;
  };
  assert.deepEqual(run(['\n<th', 'ink>plan the ', 'fix</thi', 'nk>\n\nDone.']), { text: 'Done.', thinking: 'plan the fix' });
  assert.deepEqual(run(['<mm:think>a</mm:think>b']), { text: 'b', thinking: 'a' });
  assert.deepEqual(run(['Use the <think> tag ', 'here.']), { text: 'Use the <think> tag here.', thinking: '' });
  assert.deepEqual(run(['<think>never closed']), { text: '', thinking: 'never closed' });
  assert.deepEqual(run(['plain']), { text: 'plain', thinking: '' });
});

test('reasoning is replayed to the model on later steps; old blocks drop it with the argument shrink', async () => {
  const sent: { role: string; content: string; thinking?: string }[][] = [];
  let n = 0;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: ['thinking'], model_info: { 'm.context_length': 100000 }, remote_host: 'cloud' }));
    sent.push((JSON.parse(init.body) as { messages: (typeof sent)[number] }).messages);
    const i = n++;
    const chunks = [
      { message: { content: `<think>reason ${i}</think>` } },
      { message: { tool_calls: [{ function: { name: 'bash', arguments: { command: 'ls' } } }] }, done: true, prompt_eval_count: 10, eval_count: 1 },
    ];
    return new Response(chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
  }) as typeof fetch;
  const provider = new OllamaProvider('glm:cloud', 1000);
  const thoughts: string[] = [];
  const req: StepRequest = { system: 's', tools: [{ name: 'bash', description: 'd', schema: { type: 'object', properties: {}, required: [] } }], signal: new AbortController().signal, onText: () => {}, onThinking: (d) => thoughts.push(d) };
  provider.addUser('task');
  for (let i = 0; i < 21; i++) {
    const r = await provider.step(req);
    assert.equal(r.text, '');
    provider.addToolResults(r.toolCalls.map((c) => ({ id: c.id, name: c.name, output: `out ${i}`, isError: false })));
  }
  await provider.step(req);
  assert.equal(thoughts[0], 'reason 0');
  const assistants = sent.at(-1)!.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 21);
  assert.equal(assistants.slice(0, 10).filter((m) => m.thinking).length, 0);
  assert.deepEqual(assistants.slice(10).map((m) => m.thinking), Array.from({ length: 11 }, (_, k) => `reason ${k + 10}`));
  assert.ok(assistants.every((m) => !m.content.includes('<think>')));
});
