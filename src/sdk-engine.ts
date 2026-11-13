import { query, type HookCallback, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentUI } from './agent-ui.js';
import { languageName } from './prompts.js';
import { isReadOnlyCommand, programOf } from './shell.js';
import type { Mode } from './tools.js';
import { clip, isDangerous, readsSecrets } from './tools.js';
import type { Usage } from './types.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SECRET_DENIAL = 'Secrets (.env contents, container environment) are off limits. Do not try another way to read them; if a step needs them, say so in your final answer and continue without it.';

export interface SdkRun {
  root: string;
  provider: 'ollama' | 'anthropic';
  model: string;
  mode: Mode;
  lang: string;
  maxSteps: number;
  resume?: string;
  tools?: string[];
  outputSchema?: object;
  allowed: Set<string>;
  signal: AbortSignal;
}

export interface SdkResult {
  answer: string;
  sessionId: string | undefined;
  usage: Usage;
  structured?: unknown;
}

export function sdkEnv(provider: SdkRun['provider'], model: string, env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  if (provider === 'anthropic') return { ...env };
  return {
    ...env,
    ANTHROPIC_BASE_URL: env.OLLAMA_HOST ?? 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

type Verdict = { allow: true } | { allow: false; reason: string } | { ask: string; key: string | null; secret: boolean };

export function judgeTool(name: string, input: Record<string, unknown>, mode: Mode, allowed: Set<string>): Verdict {
  const command = name === 'Bash' ? String(input.command ?? '') : '';
  const target = String(input.file_path ?? input.path ?? input.notebook_path ?? '');
  const secret = readsSecrets(command || `cat ${target}`);
  const writes = WRITE_TOOLS.has(name) || name.startsWith('mcp__') || (name === 'Bash' && !isReadOnlyCommand(command));
  const danger = secret || (command !== '' && isDangerous(command));
  if (!writes && !danger) return { allow: true };
  if (mode === 'read-only' && !secret) return { allow: false, reason: `Permission denied: "${name}" is not allowed in read-only mode. Continue with read-only tools and describe the change instead.` };
  if (mode === 'auto' && !danger) return { allow: true };
  const key = danger ? null : name === 'Bash' ? `bash:${programOf(command)}` : name.startsWith('mcp__') ? name : 'files';
  if (key && allowed.has(key)) return { allow: true };
  const prefix = secret ? '⚠ acesso a segredos (.env, variáveis de container) — ' : danger ? '⚠ comando potencialmente destrutivo — ' : '';
  return { ask: `${prefix}Permitir ${name} ${clip(JSON.stringify(input), 200)}?`, key, secret };
}

function permissionHook(run: SdkRun, ui: AgentUI): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const verdict = judgeTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, run.mode, run.allowed);
    const decide = (allow: boolean, reason?: string) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: allow ? ('allow' as const) : ('deny' as const), ...(reason ? { permissionDecisionReason: reason } : {}) },
    });
    if ('allow' in verdict) return verdict.allow ? decide(true) : decide(false, verdict.reason);
    const decision = await ui.confirm(verdict.ask, run.signal, verdict.key ? 'sempre nesta sessão' : undefined).catch(() => 'no' as const);
    if (decision === 'always' && verdict.key) run.allowed.add(verdict.key);
    if (decision !== 'no') return decide(true);
    return decide(false, verdict.secret ? SECRET_DENIAL : `The user denied this ${input.tool_name} call. Do not retry the same call; choose another approach or explain what you need.`);
  };
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}

export function show(message: SDKMessage, ui: AgentUI, children: Map<string, AgentUI>): void {
  const parent = 'parent_tool_use_id' in message ? message.parent_tool_use_id : null;
  let target = ui;
  if (parent) {
    if (!children.has(parent)) children.set(parent, ui.child(`subagente#${children.size + 1}`));
    target = children.get(parent)!;
  }
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') target.text(block.text);
      else if (block.type === 'thinking') target.thinking(block.thinking);
      else if (block.type === 'tool_use') target.tool(block.name, clip(JSON.stringify(block.input), 300));
    }
  } else if (message.type === 'user' && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type === 'tool_result') target.observation(!block.is_error, clip(blockText(block.content), 2000));
    }
  }
}

export async function runSdk(task: string, run: SdkRun, ui: AgentUI): Promise<SdkResult> {
  const controller = new AbortController();
  run.signal.addEventListener('abort', () => controller.abort(), { once: true });
  const options: Options = {
    cwd: run.root,
    model: run.model,
    env: sdkEnv(run.provider, run.model),
    abortController: controller,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: `Always answer the user in ${languageName(run.lang)}.` },
    permissionMode: 'default',
    hooks: { PreToolUse: [{ hooks: [permissionHook(run, ui)] }] },
    ...(run.maxSteps > 0 ? { maxTurns: run.maxSteps } : {}),
    ...(run.resume ? { resume: run.resume } : {}),
    ...(run.tools ? { tools: [...new Set(run.tools.map((t) => t.replace(/\(.*$/, '')))], allowedTools: run.tools } : {}),
    ...(run.outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: run.outputSchema as Record<string, unknown> } } : {}),
  };
  const children = new Map<string, AgentUI>();
  let sessionId: string | undefined = run.resume;
  const usage: Usage = { input: 0, output: 0 };
  let answer = '';
  let structured: unknown;
  try {
    for await (const message of query({ prompt: task, options })) {
      if ('session_id' in message && message.session_id) sessionId = message.session_id;
      show(message, ui, children);
      if (message.type === 'result') {
        const models = Object.values(message.modelUsage);
        usage.input = models.reduce((sum, m) => sum + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0);
        usage.output = models.reduce((sum, m) => sum + m.outputTokens, 0);
        answer = message.subtype === 'success' ? message.result : `Limite ou erro do Agent SDK (${message.subtype}): ${message.errors.join('; ')}`;
        if (message.subtype === 'success') structured = message.structured_output;
      }
    }
  } catch (e) {
    if (run.signal.aborted) return { answer: 'Interrompido pelo usuário.', sessionId, usage };
    throw e;
  }
  return { answer, sessionId, usage, structured };
}
