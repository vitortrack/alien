import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentUI } from '../src/agent-ui.js';
import { judgeTool, sdkEnv, show, type ShowState } from '../src/sdk-engine.js';

test('sdk engine: ollama points the Agent SDK at the local Anthropic-compatible endpoint with the chosen model everywhere', () => {
  const env = sdkEnv('ollama', 'glm-5.3-flash:cloud', { PATH: '/bin', OLLAMA_HOST: 'http://h:1' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://h:1');
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash:cloud');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'glm-5.3-flash:cloud');
  assert.deepEqual(sdkEnv('anthropic', 'claude-opus-5-5', { PATH: '/bin' }), { PATH: '/bin' });
});

test('sdk engine: reads pass, writes follow the mode, secrets and destructive commands always ask', () => {
  const none = new Set<string>();
  assert.deepEqual(judgeTool('Read', { file_path: 'a.ts' }, 'ask', none), { allow: true });
  assert.deepEqual(judgeTool('Bash', { command: 'git status' }, 'read-only', none), { allow: true });
  assert.equal(judgeTool('Edit', { file_path: 'a.ts' }, 'auto', none).hasOwnProperty('allow'), true);
  assert.match((judgeTool('Write', { file_path: 'a.ts' }, 'read-only', none) as { reason: string }).reason, /read-only mode/);
  assert.equal((judgeTool('Edit', { file_path: 'a.ts' }, 'ask', none) as { key: string }).key, 'files');
  assert.deepEqual(judgeTool('Edit', { file_path: 'a.ts' }, 'ask', new Set(['files'])), { allow: true });
  const secret = judgeTool('Read', { file_path: 'api/.env' }, 'auto', none) as { ask: string; secret: boolean; key: null };
  assert.equal(secret.secret, true);
  assert.equal(secret.key, null);
  assert.deepEqual(judgeTool('Read', { file_path: 'api/.env.example' }, 'auto', none), { allow: true });
  assert.equal(judgeTool('Bash', { command: 'sudo rm -rf /' }, 'auto', none).hasOwnProperty('ask'), true);
  assert.match((judgeTool('mcp__detro-db__executar', { sql: 'delete from x' }, 'read-only', none) as { reason: string }).reason, /read-only mode/);
  assert.equal((judgeTool('mcp__detro-db__executar', {}, 'ask', none) as { key: string }).key, 'mcp__detro-db__executar');
  assert.equal(judgeTool('Bash', { command: 'docker inspect api | grep env' }, 'auto', new Set(['bash:docker'])).hasOwnProperty('ask'), true);
});

test('sdk engine: streamed thinking and text reach the UI live and are not repeated by the final assistant message', () => {
  const seen: string[] = [];
  const ui = {
    text: (d: string) => seen.push(`text:${d}`),
    thinking: (d: string) => seen.push(`think:${d}`),
    tool: (n: string) => seen.push(`tool:${n}`),
    observation: () => undefined,
    child: () => ui,
  } as unknown as AgentUI;
  const state: ShowState = { children: new Map(), streamed: false };
  const delta = (d: object) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: d } }) as unknown as SDKMessage;
  show(delta({ type: 'thinking_delta', thinking: 'hmm' }), ui, state);
  show(delta({ type: 'text_delta', text: 'oi' }), ui, state);
  show({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'oi' }, { type: 'tool_use', name: 'Read', input: {} }] } } as unknown as SDKMessage, ui, state);
  assert.deepEqual(seen, ['think:hmm', 'text:oi', 'tool:Read']);
});
