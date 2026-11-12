import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function alienHome(): string {
  return process.env.ALIEN_HOME ?? path.join(os.homedir(), '.alien');
}

export function projectDataDir(root: string): string {
  const id = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 10);
  return path.join(alienHome(), 'projects', `${path.basename(root)}-${id}`);
}
