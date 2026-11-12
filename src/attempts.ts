import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentUI } from './agent-ui.js';
import { Session, type Config, type ProviderFactory } from './session.js';
import type { Usage } from './types.js';

const execFileP = promisify(execFile);
const TEST_TIMEOUT_MS = 300_000;

type Candidate = {
  index: number;
  dir: string;
  answer: string;
  error?: string;
  files: string[];
  lines: number;
  patch: string;
  tests: 'pass' | 'fail' | 'none';
  usage: Usage;
};

export type BestOfResult = { answer: string; summary: string; usage: Usage };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-c', 'user.email=alien@local', '-c', 'user.name=Alien', ...args], {
    cwd,
    maxBuffer: 200_000_000,
  });
  return stdout;
}

async function isGitRepo(root: string): Promise<boolean> {
  return git(root, 'rev-parse', '--is-inside-work-tree').then(
    (out) => out.trim() === 'true',
    () => false,
  );
}

async function linkDependencies(root: string, dir: string): Promise<void> {
  const out = await execFileP('find', [root, '-maxdepth', '3', '-name', 'node_modules', '-type', 'd', '-not', '-path', '*/node_modules/*'], {
    maxBuffer: 10_000_000,
  }).catch(() => ({ stdout: '' }));
  for (const abs of out.stdout.split('\n').filter(Boolean)) {
    const target = path.join(dir, path.relative(root, abs));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(abs, target, 'dir').catch(() => undefined);
  }
}

async function createWorkspace(root: string, index: number): Promise<string> {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'alien-attempt-')), `attempt-${index}`);
  await git(root, 'worktree', 'add', '--detach', dir, 'HEAD');
  const pending = await git(root, 'diff', 'HEAD', '--binary');
  if (pending.trim()) {
    const patch = path.join(path.dirname(dir), 'pending.patch');
    await fs.writeFile(patch, pending);
    await git(dir, 'apply', '--binary', patch);
  }
  const untracked = (await git(root, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  for (const file of untracked) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(dir, file));
  }
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'alien attempt base');
  await linkDependencies(root, dir);
  return dir;
}

async function testCommand(dir: string): Promise<string[] | null> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return ['npm', 'test', '--silent'];
  } catch {
    // no package.json
  }
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  if (entries.some((f) => /^test_.*\.py$|_test\.py$/.test(f))) return ['python3', '-B', '-m', 'unittest', '-q'];
  return null;
}

async function runTests(dir: string): Promise<'pass' | 'fail' | 'none'> {
  const cmd = await testCommand(dir);
  if (!cmd) return 'none';
  return execFileP(cmd[0]!, cmd.slice(1), { cwd: dir, timeout: TEST_TIMEOUT_MS, maxBuffer: 50_000_000 }).then(
    () => 'pass' as const,
    () => 'fail' as const,
  );
}

async function collect(candidate: Candidate): Promise<void> {
  await git(candidate.dir, 'add', '-A');
  await git(candidate.dir, 'reset', '-q', '--', ...['node_modules']).catch(() => undefined);
  candidate.patch = await git(candidate.dir, 'diff', '--cached', '--binary', 'HEAD', '--', '.', ':(exclude)**/node_modules', ':(exclude)node_modules');
  const stat = await git(candidate.dir, 'diff', '--cached', '--numstat', 'HEAD', '--', '.', ':(exclude)**/node_modules', ':(exclude)node_modules');
  const rows = stat.split('\n').filter(Boolean).map((l) => l.split('\t'));
  candidate.files = rows.map((r) => r[2]!);
  candidate.lines = rows.reduce((sum, r) => sum + (Number(r[0]) || 0) + (Number(r[1]) || 0), 0);
  candidate.tests = candidate.files.length ? await runTests(candidate.dir) : 'none';
}

export function pickBest<T extends Pick<Candidate, 'error' | 'files' | 'lines' | 'tests' | 'index'>>(candidates: T[]): T | undefined {
  const rank = (c: T) => [c.error ? 1 : 0, c.files.length ? 0 : 1, c.tests === 'fail' ? 1 : 0, c.files.length, c.lines, c.index];
  return [...candidates].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return 0;
  })[0];
}

export async function bestOf(cfg: Config, ui: AgentUI, task: string, n: number, makeProvider?: ProviderFactory, signal?: AbortSignal): Promise<BestOfResult> {
  const usage: Usage = { input: 0, output: 0 };
  if (n <= 1 || !(await isGitRepo(cfg.root))) {
    if (n > 1) ui.warn('melhor de N precisa de um repositório git; rodando uma tentativa só');
    const session = new Session(cfg, ui, makeProvider);
    signal?.addEventListener('abort', () => session.abort(), { once: true });
    const answer = await session.run(task);
    return { answer, summary: '', usage: session.usage };
  }

  ui.phase(`Melhor de ${n}: tentativas em paralelo em cópias isoladas do projeto`);
  const dirs = await Promise.all(Array.from({ length: n }, (_, k) => createWorkspace(cfg.root, k + 1)));
  const candidates: Candidate[] = [];
  try {
    await Promise.all(
      dirs.map(async (dir, k) => {
        const child = ui.child(`tentativa ${k + 1}`);
        const session = new Session({ ...cfg, root: dir, interactive: false, logDir: cfg.logDir }, child, makeProvider);
        signal?.addEventListener('abort', () => session.abort(), { once: true });
        const candidate: Candidate = { index: k + 1, dir, answer: '', files: [], lines: 0, patch: '', tests: 'none', usage: session.usage };
        candidates.push(candidate);
        try {
          candidate.answer = await session.run(task);
          if (/^(Interrompido|Limite|Orçamento|O modelo recusou)/.test(candidate.answer)) candidate.error = candidate.answer;
        } catch (e) {
          candidate.error = e instanceof Error ? e.message : String(e);
        }
        await collect(candidate);
        child.info(`${candidate.files.length} arquivo(s), ${candidate.lines} linhas, testes: ${candidate.tests}${candidate.error ? ` · ${candidate.error.slice(0, 80)}` : ''}`);
      }),
    );
    for (const c of candidates) {
      usage.input += c.usage.input;
      usage.output += c.usage.output;
    }
    const best = pickBest(candidates);
    if (!best) return { answer: 'Nenhuma tentativa concluiu.', summary: '', usage };
    if (best.patch.trim()) {
      const patchFile = path.join(path.dirname(best.dir), 'chosen.patch');
      await fs.writeFile(patchFile, best.patch);
      await git(cfg.root, 'apply', '--binary', patchFile);
    }
    const table = [...candidates]
      .sort((a, b) => a.index - b.index)
      .map((c) => `${c === best ? '→' : ' '} tentativa ${c.index}: ${c.files.length} arquivo(s), ${c.lines} linhas, testes ${c.tests}${c.error ? ', não concluiu' : ''}`)
      .join('\n');
    const summary = `Escolhida a tentativa ${best.index} (passa nos testes com o menor diff):\n${table}\nArquivos aplicados: ${best.files.join(', ') || 'nenhum'}`;
    ui.info(summary);
    return { answer: best.answer, summary, usage };
  } finally {
    for (const dir of dirs) {
      await git(cfg.root, 'worktree', 'remove', '--force', dir).catch(() => undefined);
      await fs.rm(path.dirname(dir), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
