import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Loader } from 'esbuild';

const execFileP = promisify(execFile);

const LOADERS: Record<string, Loader> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.json': 'json',
};

type EsbuildError = { text: string; location?: { line: number; column: number; lineText: string } | null };

export async function syntaxError(file: string, content: string): Promise<string | null> {
  const ext = path.extname(file).toLowerCase();
  const loader = LOADERS[ext];
  if (loader) {
    const esbuild = await import('esbuild').catch(() => null);
    if (!esbuild) return null;
    try {
      await esbuild.transform(content, { loader, sourcefile: path.basename(file) });
      return null;
    } catch (e) {
      const errors = (e as { errors?: EsbuildError[] }).errors ?? [];
      if (!errors.length) return String(e);
      return errors
        .slice(0, 3)
        .map((err) => (err.location ? `line ${err.location.line}:${err.location.column + 1} ${err.text}\n      ${err.location.lineText}` : err.text))
        .join('\n');
    }
  }
  if (ext === '.py') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alien-syntax-'));
    const tmp = path.join(dir, 'check.py');
    try {
      await fs.writeFile(tmp, content);
      await execFileP('python3', ['-B', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[2])', tmp, path.basename(file)]);
      return null;
    } catch (e) {
      const stderr = (e as { stderr?: string; code?: unknown }).stderr;
      if (!stderr) return null;
      return stderr.trim().split('\n').slice(-3).join('\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  return null;
}
