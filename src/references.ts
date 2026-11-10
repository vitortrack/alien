import fs from 'node:fs/promises';
import path from 'node:path';

const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const CODE = /\.([mc]?[jt]sx?|py|vue|svelte)$/;
const IGNORED = /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|\.trackai|__pycache__|\.venv|venv)(\/|$)/;
const MAX_FILES = 5000;
const MAX_LINES = 120;
const JS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*|^\s*import\s+)['"]([^'"]+)['"]/;
const PY_FROM = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)/;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/;

type Source = { file: string; lines: string[] };

async function codeFiles(root: string): Promise<Source[]> {
  const out: Source[] = [];
  for await (const file of fs.glob('**/*', { cwd: root, exclude: (name: string) => IGNORED.test(name) })) {
    if (!CODE.test(file) || IGNORED.test(file)) continue;
    const text = await fs.readFile(path.join(root, file), 'utf8').catch(() => '');
    if (text.length > 400_000) continue;
    out.push({ file: file.split(path.sep).join('/'), lines: text.split(/\r?\n/) });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function resolveJs(from: string, spec: string, known: Set<string>): string | null {
  let base: string;
  if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else if (spec.startsWith('@/') && `/${from}`.includes('/src/')) base = `/${from}`.slice(1, `/${from}`.indexOf('/src/') + 5) + spec.slice(2);
  else return null;
  const stem = base.replace(/\.[mc]?[jt]sx?$/, '');
  return [base, ...JS_EXT.map((e) => stem + e), ...JS_EXT.map((e) => `${base}/index${e}`)].find((c) => known.has(c)) ?? null;
}

function resolvePy(from: string, dots: string, module: string, known: Set<string>): string | null {
  let dir = dots ? path.posix.dirname(from) : '';
  for (let k = 1; k < dots.length; k++) dir = path.posix.dirname(dir);
  const rel = [dir === '.' ? '' : dir, ...module.split('.').filter(Boolean)].filter(Boolean).join('/');
  if (!rel) return null;
  return [`${rel}.py`, `${rel}/__init__.py`, `src/${rel}.py`, `src/${rel}/__init__.py`].find((c) => known.has(c)) ?? null;
}

function importsOf(src: Source, known: Set<string>): { target: string; line: number }[] {
  const found: { target: string; line: number }[] = [];
  src.lines.forEach((text, k) => {
    const add = (t: string | null) => t && t !== src.file && found.push({ target: t, line: k + 1 });
    if (!src.file.endsWith('.py')) {
      const m = JS_IMPORT.exec(text);
      if (m) add(resolveJs(src.file, m[1]!, known));
      return;
    }
    const from = PY_FROM.exec(text);
    if (from) {
      add(resolvePy(src.file, from[1]!, from[2]!, known));
      for (const name of from[3]!.replace(/[()]/g, '').split(',')) add(resolvePy(src.file, from[1]!, `${from[2]}.${name.trim().split(/\s+/)[0]}`, known));
      return;
    }
    const imp = PY_IMPORT.exec(text);
    if (imp) for (const name of imp[1]!.split(',')) add(resolvePy(src.file, '', name.trim(), known));
  });
  return found;
}

function importersOf(target: string, sources: Source[], known: Set<string>): string[] {
  return sources.flatMap((s) => importsOf(s, known).filter((i) => i.target === target).map((i) => `${s.file}:${i.line}  ${s.lines[i.line - 1]!.trim()}`));
}

export async function references(root: string, target: string): Promise<string> {
  const sources = await codeFiles(root);
  const known = new Set(sources.map((s) => s.file));
  const asFile = target.replace(/^\.\//, '');
  if (known.has(asFile)) {
    const importers = importersOf(asFile, sources, known);
    return importers.length ? `Files that import ${asFile} (${importers.length}):\n${importers.join('\n')}` : `Nothing in the repository imports ${asFile}.`;
  }
  const symbol = target.split('.').pop()!;
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) throw new Error('Give a symbol name (function, class, variable) or the path of a code file in the workspace.');
  const word = new RegExp(`(^|[^\\w$])${symbol.replace(/\$/g, '\\$')}(?![\\w$])`);
  const decl = new RegExp(`\\b(function\\*?|class|const|let|var|def|interface|type|enum)\\s+${symbol.replace(/\$/g, '\\$')}(?![\\w$])`);
  const defs: string[] = [];
  const uses: string[] = [];
  const definedIn = new Set<string>();
  for (const s of sources) {
    s.lines.forEach((text, k) => {
      if (!word.test(text)) return;
      const entry = `${s.file}:${k + 1}  ${text.trim().slice(0, 200)}`;
      if (decl.test(text)) {
        defs.push(entry);
        definedIn.add(s.file);
      } else uses.push(entry);
    });
  }
  if (!defs.length && !uses.length) return `No code file mentions ${symbol}.`;
  const parts = [defs.length ? `Defined (${defs.length}):\n${defs.join('\n')}` : `No definition of ${symbol} found in code files (it may come from a dependency).`];
  const shown = uses.slice(0, MAX_LINES);
  parts.push(uses.length ? `References (${uses.length} lines in ${new Set(uses.map((u) => u.split(':')[0])).size} files):\n${shown.join('\n')}${uses.length > shown.length ? `\n... ${uses.length - shown.length} more` : ''}` : `No references to ${symbol} outside its definition.`);
  for (const file of definedIn) {
    const importers = importersOf(file, sources, known).map((l) => l.split('  ')[0]);
    parts.push(importers.length ? `Files that import ${file}: ${importers.join(', ')}` : `Nothing imports ${file}.`);
  }
  return parts.join('\n\n');
}
