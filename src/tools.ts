import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyEdit, snippet } from './editing.js';
import type { MemoryStore } from './memory.js';
import { isReadOnlyCommand, programOf } from './shell.js';
import type { CodeIndex } from './rag.js';
import { readSkill, type Skill } from './skills.js';
import { syntaxError } from './syntax.js';
import type { Input, ToolSpec } from './types.js';

const execFileP = promisify(execFile);

export type Mode = 'ask' | 'auto' | 'read-only';
export type PlanStatus = 'pending' | 'in_progress' | 'done';
export type PlanItem = { step: string; status: PlanStatus };
export type DelegateRole = 'explorer' | 'worker';
export type Decision = 'yes' | 'no' | 'always';
export type ToolGroup = 'web' | 'memory' | 'search';

const TOOL_GROUPS: Record<ToolGroup, string> = {
  web: 'fetches a URL (documentation, APIs)',
  memory: 'saves notes for future sessions',
  search: 'semantic search over an embedding index of the codebase (slow on first use: it indexes the whole repository)',
};

export interface ToolContext {
  readonly root: string;
  readonly mode: Mode;
  readonly signal: AbortSignal;
  readonly codeIndex: CodeIndex;
  readonly memory: MemoryStore;
  readonly skills: Skill[];
  readonly files: Map<string, number>;
  readonly allowed: Set<string>;
  readonly testEditsAllowed: boolean;
  readonly testOriginals: Map<string, string | null>;
  confirm(question: string, alwaysLabel?: string): Promise<Decision>;
  setPlan(plan: PlanItem[]): void;
  delegate(role: DelegateRole, task: string): Promise<string>;
  afterRpc?(name: string, input: Input): Promise<string>;
}

export interface Tool extends ToolSpec {
  readOnly: boolean;
  group?: ToolGroup;
  run(input: Input, ctx: ToolContext): Promise<string>;
}

const MAX_OUTPUT = 20_000;
export const SAVE_OVER = 1_500;
const OFFLOAD_HEAD = 2_400;
const OFFLOAD_TAIL = 3_600;
const RPC_TOOLS = ['read_file', 'grep', 'glob', 'list_dir', 'bash'];
const MAX_RPC_CALLS = 50;
const SCRATCH_DIR = '.alien';
const OUTLINE_OVER = 300;
const WINDOW = 100;
const GREP_SUMMARY_OVER = 30;
const DECLARATION = /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|const|let|def)\s+[\w$]+|^(  |\t)?@(Get|Post|Put|Patch|Delete|Controller|Injectable|Module)\b|^(  |\t)((public|private|protected|static|readonly|async)\s+)*(def\s+)?[\w$]+\s*\([^)]*\)\s*(:\s*[^{=]+)?[{:]\s*$/;
const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.alien'];
const IGNORED = new RegExp(`(^|/)(${IGNORED_DIRS.map((d) => d.replace('.', '\\.')).join('|')})(/|$)`);

const DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*\s+(\/|~|\$HOME|\*)(\s|$)/i,
  /\bmkfs\b/,
  /\bdd\s+[^|]*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bgit\s+push\b[^\n]*(--force\b|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bsudo\b/,
  /\bchmod\s+-R\s+777\b/,
  /\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/,
  />\s*\/dev\/sd[a-z]/,
];

export function isDangerous(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

const SECRETS: RegExp[] = [
  /\b(cat|less|more|head|tail|grep|rg|sed|awk|cut|source|cp|base64|xxd|strings)\b[^|;&\n]*\.env(?![\w.-]*example)\b/,
  /(^|[\s;&(])(\.|<)\s*\S*\.env(?![\w.-]*example)\b/,
  /\bdocker\s+(inspect|exec)\b[^\n]*\benv\b/i,
  /\bprintenv\b/,
];

export function readsSecrets(text: string): boolean {
  return SECRETS.some((re) => re.test(text));
}

export function clip(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n... [${text.length - max} characters omitted] ...\n${text.slice(-half)}`;
}

export async function writeScratch(root: string, name: string): Promise<{ file: string; write(text: string): Promise<void> }> {
  const file = path.join(SCRATCH_DIR, name);
  const abs = path.join(root, file);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(path.join(root, SCRATCH_DIR, '.gitignore'), '*\n');
  return { file, write: (text) => fs.writeFile(abs, text) };
}

export async function offload(text: string, root: string, name: string): Promise<{ text: string; file?: string }> {
  if (text.length <= SAVE_OVER) return { text };
  const scratch = await writeScratch(root, name);
  await scratch.write(text);
  if (text.length <= MAX_OUTPUT) return { text, file: scratch.file };
  const lines = text.split('\n').length;
  return { file: scratch.file, text: `${text.slice(0, OFFLOAD_HEAD)}\n... [output too long: ${text.length} characters, ${lines} lines. The full output is saved in ${scratch.file}: grep it or read the lines you need with read_file offset/limit instead of running the command again] ...\n${text.slice(-OFFLOAD_TAIL)}` };
}

export function toolLoader(deferred: Tool[], load: (names: string[]) => void): Tool {
  const groups = [...new Set(deferred.flatMap((t) => (t.group ? [t.group] : [])))];
  const members = (group: string) => deferred.filter((t) => t.group === group).map((t) => t.name);
  return {
    name: 'load_tools',
    readOnly: true,
    description: `Load more tools when your plan reaches a step that needs them; they stay available from then on. Groups: ${groups.map((g) => `"${g}" ${TOOL_GROUPS[g]} (${members(g).join(', ')})`).join('; ')}.`,
    schema: { type: 'object', properties: { group: { type: 'string', enum: groups } }, required: ['group'] },
    async run(i) {
      const names = members(str(i, 'group'));
      load(names);
      return `Loaded: ${names.join(', ')}. Call them directly from now on.`;
    },
  };
}

export function describeInput(input: Input, max = 80): string {
  return Object.entries(input)
    .map(([k, v]) => {
      const raw = typeof v === 'string' ? v : JSON.stringify(v);
      const flat = raw.replace(/\s+/g, ' ');
      return `${k}=${flat.length > max ? `${flat.slice(0, max)}…` : flat}`;
    })
    .join(' ');
}

function insideRoot(root: string, target: string, original: string): void {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path "${original}" is outside the workspace (${root}). Use a path inside it.`);
  }
}

export function cleanPath(p: string): string {
  return p.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
}

export async function suggestPath(root: string, raw: string): Promise<string> {
  const first = cleanPath(raw).split(/\s+/)[0] ?? '';
  const found: string[] = [];
  const exists = (p: string) => fs.access(path.resolve(root, p)).then(() => true, () => false);
  if (first && first !== cleanPath(raw) && (await exists(first))) found.push(first);
  const base = path.basename(first);
  if (!found.length && base && !/[*?[\]{}]/.test(base)) {
    for await (const f of fs.glob(`**/${base}`, { cwd: root, exclude: (name: string) => IGNORED.test(name) })) {
      found.push(f);
      if (found.length >= 3) break;
    }
  }
  return found.length ? ` Did you mean: ${found.join(', ')}?` : '';
}

export async function safePath(root: string, rawPath: string): Promise<string> {
  const p = cleanPath(rawPath);
  const abs = path.resolve(root, p);
  insideRoot(root, abs, p);
  const realRoot = await fs.realpath(root);
  let probe = abs;
  for (;;) {
    try {
      insideRoot(realRoot, await fs.realpath(probe), p);
      return abs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      probe = path.dirname(probe);
    }
  }
}

const FILE_TOOLS = new Set(['write_file', 'edit_file']);

function permissionScope(tool: Tool, input: Input): { key: string; label: string } {
  if (FILE_TOOLS.has(tool.name)) return { key: 'files', label: 'alterações em arquivos' };
  if (tool.name === 'bash') {
    const program = programOf(str(input, 'command'));
    return { key: `bash:${program}`, label: `comandos ${program}` };
  }
  if (tool.name === 'run_code') return { key: 'run_code', label: 'execução de scripts' };
  return { key: tool.name, label: tool.name };
}

export async function permit(tool: Tool, input: Input, ctx: ToolContext): Promise<string | null> {
  const command = tool.name === 'bash' ? str(input, 'command') : '';
  const secret = readsSecrets(command || `cat ${str(input, 'path')}`);
  if (tool.readOnly && !secret) return null;
  const danger = secret || (command !== '' && isDangerous(command));
  if (command && !danger && isReadOnlyCommand(command)) return null;
  if (ctx.mode === 'read-only') {
    return `Permission denied: "${tool.name}" is not allowed in read-only mode. Continue with read-only tools and describe the change instead.`;
  }
  if (ctx.mode === 'auto' && !danger) return null;
  const scope = permissionScope(tool, input);
  if (!danger && ctx.allowed.has(scope.key)) return null;
  let prefix = danger ? '⚠ comando potencialmente destrutivo — ' : '';
  if (secret) prefix = '⚠ acesso a segredos (.env, variáveis de container) — ';
  const decision = await ctx.confirm(`${prefix}Permitir ${tool.name} ${describeInput(input, 200)}?`, danger ? undefined : scope.label).catch(() => 'no' as const);
  if (decision === 'always' && !danger) ctx.allowed.add(scope.key);
  if (decision !== 'no') return null;
  if (secret) return 'Secrets (.env contents, container environment) are off limits. Do not try another way to read them; if a step needs them, say so in your final answer and continue without it.';
  return `The user denied this ${tool.name} call. Do not retry the same call; choose another approach or explain what you need.`;
}

const str = (i: Input, k: string): string => i[k] as string;
const num = (i: Input, k: string, fallback: number): number => (i[k] as number | undefined) ?? fallback;
const opt = (i: Input, k: string): string | undefined => i[k] as string | undefined;

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

type RpcRequest = { id: number; name: string; args: Input };
type RpcReply = { output: string } | { error: string };

const RPC_PRELUDE =
  "const __calls = new Map(); let __id = 0; process.on('message', (m) => { const p = __calls.get(m.id); __calls.delete(m.id); if (!__calls.size) process.channel.unref(); if ('error' in m) p.reject(new Error(m.error)); else p.resolve(m.output); }); process.channel.unref(); globalThis.tools = new Proxy({}, { get: (_, name) => (args = {}) => new Promise((resolve, reject) => { const id = ++__id; __calls.set(id, { resolve, reject }); process.channel.ref(); process.send({ id, name, args }); }) });\n";

function rpcHandler(ctx: ToolContext): (m: RpcRequest) => Promise<RpcReply> {
  let calls = 0;
  return async (m) => {
    if (++calls > MAX_RPC_CALLS) return { error: `Limit of ${MAX_RPC_CALLS} tool calls per script reached.` };
    const tool = RPC_TOOLS.includes(m.name) ? allTools.find((t) => t.name === m.name) : undefined;
    if (!tool) return { error: `tools.${m.name} is not available in run_code. Available: ${RPC_TOOLS.join(', ')}.` };
    const denied = await permit(tool, m.args ?? {}, ctx);
    if (denied) return { error: denied };
    try {
      const output = await tool.run(m.args ?? {}, ctx);
      const extra = (await ctx.afterRpc?.(m.name, m.args ?? {})) ?? '';
      return { output: extra ? `${output}\n\n${extra}` : output };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
}

function runBash(command: string, ctx: ToolContext, timeoutMs: number): Promise<string> {
  return runProcess('bash', ['-c', command], ctx, timeoutMs);
}

function runProcess(file: string, args: string[], ctx: ToolContext, timeoutMs: number, rpc?: (m: RpcRequest) => Promise<RpcReply>): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: ctx.root, detached: true, stdio: rpc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    if (rpc) child.on('message', (m: RpcRequest) => void rpc(m).then((reply) => child.connected && child.send({ id: m.id, ...reply })));
    let out = '';
    let stopped: string | null = null;
    const killGroup = (reason: string) => {
      stopped ??= reason;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const onAbort = () => killGroup('interrupted by the user');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => killGroup(`killed after ${timeoutMs / 1000}s timeout (whole process group)`), timeoutMs);
    const done = (status: string) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolve(`${out.trimEnd() || '(no output)'}\n[${status}]`);
    };
    child.on('error', (e) => done(`failed to start: ${e.message}`));
    child.on('close', (code, sig) => done(stopped ?? `exit code ${code ?? sig}`));
  });
}

async function mtime(file: string): Promise<number> {
  return (await fs.stat(file)).mtimeMs;
}

const INLINE_CONTENT_LINES = 200;

async function showCurrent(ctx: ToolContext, file: string, content: string, problem: string, retry: string): Promise<Error> {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > INLINE_CONTENT_LINES) return new Error(`${problem} Read it with read_file, then ${retry}.`);
  ctx.files.set(file, await mtime(file));
  const body = lines.map((line, k) => `${String(k + 1).padStart(5)}\t${line}`).join('\n');
  return new Error(`${problem} Its current content is below (this counts as reading it); ${retry} now, without calling read_file:\n${body}`);
}

async function ensureFresh(ctx: ToolContext, file: string, shown: string, content: string, retry: string): Promise<void> {
  const seen = ctx.files.get(file);
  if (seen === undefined) throw await showCurrent(ctx, file, content, `You have not read ${shown} yet.`, retry);
  if ((await mtime(file)) !== seen) {
    throw await showCurrent(ctx, file, content, `${shown} changed since you last read it (by a command, the user or another agent).`, retry);
  }
}

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|(^|\/)test[^/]*\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const ASSERTION = /\bassert|\bexpect\s*\(|\.should\b|\.to(Be|Equal|Throw)\b/;
const LITERALS = /(['"`])(?:\\.|(?!\1).)*\1|\b\d+(?:\.\d+)?\b/g;
const SKIPS = /process\.exit\s*\(\s*0?\s*\)|\.skip\s*\(|\bx(it|describe|test)\s*\(|SkipTest|pytest\.skip|unittest\.skip|@skip\b/;
const TEST_REQUEST =
  /\b(escrev|cri|adicion|inclu|atualiz|alter|corrij|ajust|mud|refator|renome|remov|apag|reescrev|add|writ|creat|updat|chang|fix|renam|remov|delet|rewrit|edit)\w*\s+(?:\S+\s+){0,3}?(test|teste|spec)/i;

export const allowsTestEdits = (task: string): boolean => TEST_REQUEST.test(task);

const signature = (line: string): string => (line.match(LITERALS) ?? []).join('|');

function testGuard(shown: string, before: string | null, after: string, ctx: ToolContext): string | null {
  if (ctx.testEditsAllowed || !TEST_FILE.test(shown)) return null;
  if (!ctx.testOriginals.has(shown)) ctx.testOriginals.set(shown, before);
  const original = ctx.testOriginals.get(shown) ?? '';
  const afterLines = after.split('\n').map((l) => l.trim());
  const kept = new Set(afterLines);
  const keptSignatures = new Set(afterLines.filter((l) => ASSERTION.test(l)).map(signature));
  const changed = original
    .split('\n')
    .map((l) => l.trim())
    .find((l) => ASSERTION.test(l) && !kept.has(l) && !keptSignatures.has(signature(l)));
  const conflict = 'If an existing test contradicts the request, do not change it: implement what the request says and call report_conflict with the evidence.';
  if (changed) {
    return `Change NOT applied: ${shown} is a test file and this edit changes or removes the existing assertion "${changed}". The request does not ask to change tests, so existing assertions are read-only (you may add new tests). ${conflict}`;
  }
  const beforeLines = new Set(original.split('\n').map((l) => l.trim()));
  const skip = afterLines.find((l) => SKIPS.test(l) && !beforeLines.has(l));
  if (skip) return `Change NOT applied: "${skip}" would skip or short-circuit tests in ${shown}. ${conflict}`;
  return null;
}

const NUMBERED = /^(\d+)[-_]/;

async function numberingWarning(file: string): Promise<string> {
  const own = path.basename(file).match(NUMBERED)?.[1];
  if (!own) return '';
  const siblings = (await fs.readdir(path.dirname(file)).catch(() => [] as string[])).filter((f) => f !== path.basename(file));
  const taken = siblings.filter((f) => f.match(NUMBERED)?.[1] === own);
  if (!taken.length) return '';
  const next = Math.max(...siblings.map((f) => Number(f.match(NUMBERED)?.[1] ?? 0))) + 1;
  return `\nWarning: the number ${own} is already used by ${taken.join(', ')} in this directory; the next free number is ${String(next).padStart(own.length, '0')}. Rename this file unless sharing the number is intended.`;
}

async function guardedWrite(ctx: ToolContext, file: string, shown: string, before: string | null, after: string): Promise<string> {
  const broken = await syntaxError(file, after);
  if (broken && before !== null && !(await syntaxError(file, before))) {
    throw new Error(`Change NOT applied: it would introduce a syntax error in ${shown}:\n${broken}\nFix the replacement text and try again.`);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, after);
  ctx.files.set(file, await mtime(file));
  return broken ? `\nWarning: ${shown} has a syntax error:\n${broken}` : '';
}

export const allTools: Tool[] = [
  {
    name: 'read_file',
    readOnly: true,
    description:
      'Read a UTF-8 text file from the workspace. Returns numbered lines (use the numbers to cite file:line). Large files are paged: use offset/limit, or grep first to find the right line range. You must read a file before editing it.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        offset: { type: 'integer', description: '1-based line to start from (default 1)' },
        limit: { type: 'integer', description: 'Maximum number of lines to return (default 400)' },
      },
      required: ['path'],
    },
    async run(i, ctx) {
      const file = await safePath(ctx.root, str(i, 'path'));
      const content = await fs.readFile(file, 'utf8');
      if (content.includes('\0')) throw new Error('This is a binary file and cannot be read as text.');
      ctx.files.set(file, await mtime(file));
      const lines = content.replace(/\r\n/g, '\n').split('\n');
      const outline = i.offset === undefined && i.limit === undefined && lines.length > OUTLINE_OVER;
      const start = Math.min(Math.max(1, num(i, 'offset', 1)), Math.max(1, lines.length));
      const slice = lines.slice(start - 1, start - 1 + (outline ? WINDOW : num(i, 'limit', 400)));
      const end = start + slice.length - 1;
      const body = slice.map((line, k) => `${String(start + k).padStart(5)}\t${line}`).join('\n');
      const crlf = content.includes('\r\n') ? '\n[file uses CRLF line endings; edit_file and write_file keep them automatically, so edit normally]' : '';
      if (start === 1 && end >= lines.length) return clip((body || '(empty file)') + crlf);
      const declarations = outline
        ? lines.flatMap((line, k) => (DECLARATION.test(line) ? [`${String(k + 1).padStart(5)}\t${line.trim().slice(0, 140)}`] : [])).slice(0, 80)
        : [];
      const map = declarations.length ? `[outline: declarations with their line numbers; read the range you need with offset/limit]\n${declarations.join('\n')}\n` : '';
      const header = `${map}[${str(i, 'path')}: lines ${start}-${end} of ${lines.length}${start > 1 ? `; ${start - 1} lines above` : ''}]`;
      const footer = end < lines.length ? `\n[${lines.length - end} more lines below; continue with offset=${end + 1}]` : '';
      return clip(`${header}\n${body}${footer}${crlf}`);
    },
  },
  {
    name: 'list_dir',
    readOnly: true,
    description: 'List the entries of a directory in the workspace. Directories end with "/".',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory relative to the workspace root (default ".")' } },
      required: [],
    },
    async run(i, ctx) {
      const entries = await fs.readdir(await safePath(ctx.root, opt(i, 'path') ?? '.'), { withFileTypes: true });
      return (
        entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join('\n') || '(empty directory)'
      );
    },
  },
  {
    name: 'glob',
    readOnly: true,
    description: 'Find files by glob pattern (e.g. "src/**/*.ts"). Ignores node_modules, .git and build output.',
    schema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Glob pattern relative to the workspace root' } },
      required: ['pattern'],
    },
    async run(i, ctx) {
      const pattern = str(i, 'pattern');
      if (path.isAbsolute(pattern) || pattern.split('/').includes('..')) {
        throw new Error('The pattern must be relative to the workspace and cannot contain "..".');
      }
      const found: string[] = [];
      for await (const file of fs.glob(pattern, { cwd: ctx.root, exclude: (name: string) => IGNORED.test(name) })) {
        found.push(file);
        if (found.length >= 500) break;
      }
      return found.sort().join('\n') || 'No files matched.';
    },
  },
  {
    name: 'grep',
    readOnly: true,
    description: 'Search file contents with an extended regular expression. Returns "file:line:text" matches.',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regular expression (grep -E syntax)' },
        path: { type: 'string', description: 'File or directory to search (default ".")' },
        include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts"' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search' },
      },
      required: ['pattern'],
    },
    async run(i, ctx) {
      const target = await safePath(ctx.root, opt(i, 'path') ?? '.');
      const args = ['-rnIE', ...IGNORED_DIRS.map((d) => `--exclude-dir=${d}`)];
      const include = opt(i, 'include');
      if (include) args.push(`--include=${include}`);
      if (i.ignore_case === true) args.push('-i');
      args.push('-e', str(i, 'pattern'), path.relative(ctx.root, target) || '.');
      try {
        const { stdout } = await execFileP('grep', args, { cwd: ctx.root, maxBuffer: 50_000_000, signal: ctx.signal });
        const lines = stdout.split('\n').filter(Boolean);
        if (lines.length <= GREP_SUMMARY_OVER) return lines.join('\n');
        const byFile = new Map<string, { count: number; first: string }>();
        for (const line of lines) {
          const file = line.slice(0, line.indexOf(':'));
          const entry = byFile.get(file);
          if (entry) entry.count++;
          else byFile.set(file, { count: 1, first: line.slice(file.length + 1).slice(0, 160) });
        }
        const files = [...byFile].slice(0, 100).map(([file, e]) => `${file} (${e.count}): ${e.first}`);
        const more = byFile.size > 100 ? `\n... ${byFile.size - 100} more files` : '';
        return `${lines.length} matches in ${byFile.size} files; per file: count and first match. Narrow with path/include, or read the range you need:\n${files.join('\n')}${more}`;
      } catch (e) {
        if ((e as { code?: unknown }).code === 1) return 'No matches.';
        throw e;
      }
    },
  },
  {
    name: 'write_file',
    readOnly: false,
    description:
      'Create a new file, or completely rewrite one you have already read. Creates parent directories. For changes to existing files prefer edit_file. If the new content has errors the type checker can see in that file alone (missing import, undeclared name, broken syntax), the write is reverted and the errors are returned: include every import and declaration the file needs in the same write.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
    async run(i, ctx) {
      const shown = str(i, 'path');
      const file = await safePath(ctx.root, shown);
      const before = await fs.readFile(file, 'utf8').catch(() => null);
      if (before !== null) await ensureFresh(ctx, file, shown, before, 'call write_file again with the full new content');
      const crlf = before !== null && before.includes('\r\n');
      const content = crlf ? str(i, 'content').replace(/\r?\n/g, '\r\n') : str(i, 'content');
      const blocked = testGuard(shown, before, content, ctx);
      if (blocked) throw new Error(blocked);
      const warning = await guardedWrite(ctx, file, shown, before, content);
      const numbering = before === null ? await numberingWarning(file) : '';
      return `${before === null ? 'Created' : 'Rewrote'} ${shown} (${str(i, 'content').split('\n').length} lines).${warning}${numbering}`;
    },
  },
  {
    name: 'edit_file',
    readOnly: false,
    description:
      'Replace text in a file you have read. old_string should be copied from read_file output (without the line-number prefix) and identify exactly one place; include a few surrounding lines when needed. Small whitespace/indentation differences are tolerated, and CRLF line endings and tab indentation are preserved automatically. Set replace_all=true to change every occurrence. Returns the edited region with line numbers so you can check it. Precondition checked after every edit: if the edit leaves errors the type checker can see in that file alone, it is reverted and the file stays unchanged. So to rename a name, change its declaration and every use in the file in the same call (replace_all=true on the name), never the declaration alone; to add a call to something new, add its import in the same edit or first.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root' },
        old_string: { type: 'string', description: 'Existing text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async run(i, ctx) {
      const shown = str(i, 'path');
      const file = await safePath(ctx.root, shown);
      const before = await fs.readFile(file, 'utf8').catch(() => null);
      if (before === null) throw new Error(`${shown} does not exist. Create it with write_file.`);
      const neverRead = !ctx.files.has(file);
      if (!neverRead) await ensureFresh(ctx, file, shown, before, 'call edit_file again with old_string copied from it');
      const result = applyEdit(before, str(i, 'old_string'), str(i, 'new_string'), i.replace_all === true);
      if (neverRead && (!result.ok || result.strategy !== 'exact')) {
        throw await showCurrent(ctx, file, before, `old_string does not match ${shown} exactly and you have not read this file yet.`, 'call edit_file again with old_string copied from it');
      }
      if (!result.ok) throw new Error(result.error);
      const blocked = testGuard(shown, before, result.content, ctx);
      if (blocked) throw new Error(blocked);
      const warning = await guardedWrite(ctx, file, shown, before, result.content);
      const how = result.strategy === 'exact' ? '' : ` (matched ${result.strategy})`;
      const count = result.count > 1 ? `${result.count} replacements` : '1 replacement';
      return `Edited ${shown}: ${count}${how}.${warning}\n${snippet(result.content, result.firstLine, result.lastLine)}\nCheck the snippet for wrong indentation or duplicated lines.`;
    },
  },
  {
    name: 'bash',
    readOnly: false,
    description:
      'Run a shell command in the workspace root (non-interactive, no stdin). Use it to build, test, type-check, run git, or inspect the system. Reading with cat, sed, grep or ls does not change any file, so it is not progress on the task: write the change with edit_file or write_file. Long output is saved to a file under .alien/ and you get its head, tail and path: grep or page that file instead of running the command again.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run' },
        timeout_seconds: { type: 'integer', description: 'Timeout in seconds (default 120, max 600)' },
      },
      required: ['command'],
    },
    run(i, ctx) {
      const seconds = Math.min(600, Math.max(1, num(i, 'timeout_seconds', 120)));
      return runBash(str(i, 'command'), ctx, seconds * 1000);
    },
  },
  {
    name: 'web_fetch',
    readOnly: true,
    group: 'web',
    description: 'Fetch a public http(s) URL and return its content as plain text (HTML is stripped). Useful for docs.',
    schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
      required: ['url'],
    },
    async run(i, ctx) {
      const url = new URL(str(i, 'url'));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs are allowed.');
      const res = await fetch(url, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
        headers: { 'user-agent': 'Alien/0.1 (+coding agent)' },
      });
      const body = await res.text();
      const text = (res.headers.get('content-type') ?? '').includes('html') ? htmlToText(body) : body;
      return `HTTP ${res.status} ${url.href}\n\n${text}`;
    },
  },
  {
    name: 'update_plan',
    readOnly: true,
    description:
      'Create or update your task plan. Send the full list every time. Keep exactly one step in_progress while working; mark steps done as soon as they are finished.',
    schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Ordered plan steps',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['steps'],
    },
    async run(i, ctx) {
      const statuses: PlanStatus[] = ['pending', 'in_progress', 'done'];
      const plan = (i.steps as unknown[]).map((raw, k) => {
        const item = raw as Partial<PlanItem>;
        if (typeof item?.step !== 'string' || !statuses.includes(item.status as PlanStatus)) {
          throw new Error(`steps[${k}] must be {step: string, status: pending|in_progress|done}.`);
        }
        return { step: item.step, status: item.status as PlanStatus };
      });
      ctx.setPlan(plan);
      return `Plan updated: ${plan.filter((p) => p.status === 'done').length}/${plan.length} done.`;
    },
  },
  {
    name: 'delegate',
    readOnly: true,
    description:
      'Hand a self-contained subtask to a sub-agent with a fresh context and get its report back. role "explorer": read-only research across many files (cheap on your context). role "worker": an independent implementation task. Give complete instructions: the sub-agent knows nothing about this conversation. Several explorer calls in the same turn run in parallel.',
    schema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['explorer', 'worker'] },
        task: { type: 'string', description: 'Complete, self-contained instructions and the expected report format' },
      },
      required: ['role', 'task'],
    },
    run(i, ctx) {
      return ctx.delegate(str(i, 'role') as DelegateRole, str(i, 'task'));
    },
  },
  {
    name: 'semantic_search',
    readOnly: true,
    group: 'search',
    description:
      'Search the codebase by meaning (RAG: vector embeddings + BM25 over indexed chunks). Use it first when you do not know where something lives; use grep for exact identifiers. Write the query as the question followed by likely English identifiers and domain words that would appear in the code, e.g. "onde o CPF é validado | validate cpf document validator isValidCpf". The index updates itself incrementally.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question plus likely English identifiers/keywords found in the code' },
        k: { type: 'integer', description: 'Number of chunks to return (default 8, max 20)' },
      },
      required: ['query'],
    },
    async run(i, ctx) {
      const { hits, mode } = await ctx.codeIndex.search(str(i, 'query'), Math.min(20, Math.max(1, num(i, 'k', 8))), ctx.signal);
      if (!hits.length) return `No results (${mode}).`;
      const body = hits
        .map((h) => `── ${h.file}:${h.start}-${h.end} (score ${h.score.toFixed(2)})\n${h.text.split('\n').slice(0, 25).join('\n')}`)
        .join('\n\n');
      return `Search mode: ${mode}\n\n${body}`;
    },
  },
  {
    name: 'run_code',
    readOnly: false,
    description:
      'Execute a short Python or Node.js (ES module) script with the workspace root as working directory, so relative paths and imports like ./src/x.js resolve against the project. Only what the script prints comes back to you. In Node, `await tools.read_file({path, offset, limit})`, `tools.grep({pattern, path, include})`, `tools.glob({pattern})`, `tools.list_dir({path})` and `tools.bash({command})` return the same text as those tools (up to 50 calls per script): chain several reads, searches or checks in one script and print only what you need, instead of one tool call per step.',
    schema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'node'] },
        code: { type: 'string', description: 'Complete script source' },
        timeout_seconds: { type: 'integer', description: 'Timeout in seconds (default 60, max 600)' },
      },
      required: ['language', 'code'],
    },
    run(i, ctx) {
      const quoted = `'${str(i, 'code').replace(/'/g, `'\\''`)}'`;
      const seconds = Math.min(600, Math.max(1, num(i, 'timeout_seconds', 60)));
      if (str(i, 'language') === 'python') return runBash(`python3 -c ${quoted}`, ctx, seconds * 1000);
      return runProcess('node', ['--input-type=module', '-e', RPC_PRELUDE + str(i, 'code')], ctx, seconds * 1000, rpcHandler(ctx));
    },
  },
  {
    name: 'skill',
    readOnly: true,
    description: 'Load a skill listed in <skills>: its full instructions, or one of its other files. Load it before acting on a task that matches its description, then follow it.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name as listed in <skills>' },
        file: { type: 'string', description: 'Optional: another file inside the skill folder, as listed when the skill was loaded' },
      },
      required: ['name'],
    },
    run(i, ctx) {
      return Promise.resolve(clip(readSkill(ctx.skills, str(i, 'name'), opt(i, 'file'))));
    },
  },
  {
    name: 'report_conflict',
    readOnly: true,
    description:
      'Stop and report to the user that the request cannot be done as asked: a test, spec or existing behavior contradicts the request, or it needs changes the request rules out. Use it instead of working around the conflict (never edit tests to make them pass, never special-case inputs or hard-code expected values). Do what the request asks first, then report. Never use it to deliver a normal final answer: when the task is done without a conflict, just answer in text. Your explanation becomes the final answer: say what you did, the exact evidence (file:line, expected vs. requested) and what the user can decide.',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['test_contradicts_request', 'out_of_scope', 'impossible'] },
        explanation: { type: 'string', description: 'Final answer for the user, in their language' },
      },
      required: ['kind', 'explanation'],
    },
    async run(i) {
      return str(i, 'explanation');
    },
  },
  {
    name: 'remember',
    readOnly: true,
    group: 'memory',
    description:
      'Save something to long-term memory (vector store, kept outside the workspace) so future sessions can recall it. kind "fact": stable project knowledge (conventions, commands, architecture, user preferences). kind "lesson": a mistake or insight worth not repeating. Never store secrets.',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One concise, self-contained statement' },
        kind: { type: 'string', enum: ['fact', 'lesson'] },
      },
      required: ['text', 'kind'],
    },
    async run(i, ctx) {
      await ctx.memory.add(str(i, 'kind') as 'fact' | 'lesson', str(i, 'text'), ctx.signal);
      return 'Saved to long-term memory.';
    },
  },
  {
    name: 'recall',
    readOnly: true,
    description: 'Search long-term memory (facts, lessons and past task episodes) for anything relevant to a query.',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What you want to remember' } },
      required: ['query'],
    },
    async run(i, ctx) {
      const found = await ctx.memory.recall(str(i, 'query'), 8, ctx.signal);
      return found.length ? found.map((m) => `[${m.kind} · ${m.at.slice(0, 10)}] ${m.text}`).join('\n') : 'Nothing relevant in memory.';
    },
  },
];
