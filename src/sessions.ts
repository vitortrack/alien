import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { projectDataDir } from './paths.js';
import type { PlanItem } from './tools.js';
import type { Usage } from './types.js';

export interface Turn {
  task: string;
  answer: string;
}

export interface SavedSession {
  id: string;
  title: string;
  created: string;
  updated: string;
  provider: string;
  model: string;
  turns: Turn[];
  plan: PlanItem[];
  usage: Usage;
  history: unknown;
}

export const newSessionId = (): string => `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomUUID().slice(0, 4)}`;

export class SessionStore {
  private readonly dir: string;

  constructor(root: string) {
    this.dir = path.join(projectDataDir(root), 'sessions');
  }

  save(session: SavedSession): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${session.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(session));
    fs.renameSync(`${file}.tmp`, file);
  }

  load(id: string): SavedSession | null {
    if (!/^[\w-]+$/.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as SavedSession;
    } catch {
      return null;
    }
  }

  list(limit = 20): SavedSession[] {
    const files = fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')) : [];
    return files
      .map((f) => ({ id: f.slice(0, -5), mtime: fs.statSync(path.join(this.dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((f) => this.load(f.id))
      .filter((s): s is SavedSession => s !== null);
  }

  latest(): SavedSession | null {
    return this.list(1)[0] ?? null;
  }
}
