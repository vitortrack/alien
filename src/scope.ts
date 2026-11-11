import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const PERSISTENCE = ['salv', 'grav', 'persist', 'save'];
const UI = ['tela', 'página', 'pagina', 'menu', 'formulário', 'formulario', 'botão', 'botao', 'campo', 'listagem', 'screen', 'page', 'form', 'button', 'front'];

const SYNONYMS: Record<string, string[]> = {
  api: ['api', 'endpoint', 'backend', 'servidor', 'server', 'rota da api', ...PERSISTENCE],
  backend: ['backend', 'back-end', 'servidor', 'server', 'api', 'endpoint', 'permiss', ...PERSISTENCE],
  server: ['backend', 'servidor', 'server', 'api', ...PERSISTENCE],
  db: ['banco', 'database', 'migration', 'migração', 'migracao', 'tabela', 'sql', 'schema', 'db', ...PERSISTENCE],
  migrations: ['banco', 'migration', 'migração', 'migracao', 'schema', 'tabela', ...PERSISTENCE],
  web: UI,
  frontend: UI,
  front: UI,
  client: UI,
  ui: UI,
  infra: ['infra', 'deploy', 'docker', 'terraform'],
  config: ['config', 'configuração', 'configuracao'],
};

export function areaOf(file: string): string {
  const parts = file.split('/');
  return parts.length > 1 ? parts[0]! : '.';
}

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(spec|test)\.[cm]?[jt]sx?$/;

export function scopeReport(task: string, changed: string[]): string | null {
  const files = changed.filter((f) => !TEST_FILE.test(f));
  if (!files.length) return null;
  const byArea = new Map<string, string[]>();
  for (const f of files) byArea.set(areaOf(f), [...(byArea.get(areaOf(f)) ?? []), f]);
  if (byArea.size < 2) return null;
  const main = [...byArea.entries()].sort((a, b) => b[1].length - a[1].length)[0]![0];
  const text = task.toLowerCase();
  const mentioned = (area: string) => [area.toLowerCase(), ...(SYNONYMS[area.toLowerCase()] ?? [])].some((w) => text.includes(w));
  const extra = [...byArea.keys()].filter((a) => a !== main && a !== '.' && !mentioned(a));
  if (!extra.length) return null;
  const summary = [...byArea.entries()].map(([a, fs]) => `${a}/ (${fs.length})`).join(', ');
  const list = extra.flatMap((a) => byArea.get(a)!).map((f) => `- ${f}`).join('\n');
  return `[scope check] Your changes touch: ${summary}. The request does not mention ${extra.map((a) => `${a}/`).join(' or ')}. Files there:\n${list}\nFor each of these files: if the requested behavior works without it, undo that change now (git checkout -- <file> for edited files, delete files you created) and mention it as a suggestion instead. Keep a file only if you can point to the code in the requested flow that breaks without it. Decide by reading the code (grep its usages); do not revert files temporarily or create probe copies to test it. Then give your final answer.`;
}

export async function changedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, maxBuffer: 20_000_000 });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^"|"$/g, ''))
      .map((l) => (l.includes(' -> ') ? l.split(' -> ')[1]! : l));
  } catch {
    return [];
  }
}

const MAX_DIFF = 40_000;

export async function workspaceDiff(root: string): Promise<string | null> {
  try {
    const { stdout: diff } = await execFileP('git', ['diff', 'HEAD', '--no-color'], { cwd: root, maxBuffer: 20_000_000 });
    const { stdout: others } = await execFileP('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 20_000_000 });
    const added = await Promise.all(
      others
        .split('\n')
        .filter(Boolean)
        .map(async (f) => {
          const text = await fs.readFile(path.join(root, f), 'utf8').catch(() => '\0');
          return `--- new file: ${f}\n${text.includes('\0') ? '(binary or unreadable)' : text}`;
        }),
    );
    const text = [diff, ...added].join('\n').trim();
    return text && text.length <= MAX_DIFF ? text : null;
  } catch {
    return null;
  }
}

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'TRACKAI.md'];
const MAX_INSTRUCTIONS = 8_000;

export async function nestedInstructions(root: string, file: string, seen: Set<string>): Promise<string> {
  const out: string[] = [];
  let dir = path.dirname(path.resolve(root, file));
  const chain: string[] = [];
  while (dir.startsWith(root) && dir !== root) {
    chain.unshift(dir);
    dir = path.dirname(dir);
  }
  for (const d of chain) {
    for (const name of INSTRUCTION_FILES) {
      const p = path.join(d, name);
      if (seen.has(p)) continue;
      const text = await fs.readFile(p, 'utf8').catch(() => null);
      if (text === null) continue;
      seen.add(p);
      out.push(`[instructions from ${path.relative(root, p)} — they apply to files under ${path.relative(root, d)}/]\n${text.slice(0, MAX_INSTRUCTIONS).trim()}`);
    }
  }
  return out.join('\n\n');
}
