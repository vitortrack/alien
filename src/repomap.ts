import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const TIMEOUT_MS = 8_000;

function scriptPath(): string | null {
  const here = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return [path.join(here, '../py/repomap.py'), path.join(here, 'py/repomap.py')].find((p) => fs.existsSync(p)) ?? null;
}

export async function repoMap(root: string, request: string, signal?: AbortSignal): Promise<string> {
  const script = scriptPath();
  if (!script) return '';
  try {
    const { stdout } = await execFileP('python3', ['-I', script, root, request], { timeout: TIMEOUT_MS, maxBuffer: 1_000_000, signal });
    return stdout.trim();
  } catch {
    return '';
  }
}
