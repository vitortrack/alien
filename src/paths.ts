import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function trackaiHome(): string {
  return process.env.TRACKAI_HOME ?? path.join(os.homedir(), '.trackai');
}

export function projectDataDir(root: string): string {
  const id = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 10);
  return path.join(trackaiHome(), 'projects', `${path.basename(root)}-${id}`);
}
