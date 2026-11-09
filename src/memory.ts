import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { projectDataDir } from './paths.js';
import { rank, type Embedder } from './rag.js';

export type MemoryKind = 'fact' | 'lesson' | 'episode';
export type Memory = { id: string; kind: MemoryKind; text: string; at: string; vector?: number[] };

const MIN_SCORE = 0.2;

export function memoryFile(root: string): string {
  return path.join(projectDataDir(root), 'memory.jsonl');
}

export function readMemories(root: string): Memory[] {
  try {
    return fs
      .readFileSync(memoryFile(root), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Memory);
  } catch {
    return [];
  }
}

export class MemoryStore {
  constructor(
    private readonly root: string,
    private readonly embedder: Embedder,
  ) {}

  async add(kind: MemoryKind, text: string, signal: AbortSignal): Promise<void> {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const [vector] = (await this.embedder.embed([clean], signal)) ?? [];
    const memory: Memory = { id: randomUUID(), kind, text: clean, at: new Date().toISOString(), ...(vector ? { vector } : {}) };
    fs.mkdirSync(path.dirname(memoryFile(this.root)), { recursive: true });
    fs.appendFileSync(memoryFile(this.root), `${JSON.stringify(memory)}\n`);
  }

  async recall(query: string, k: number, signal: AbortSignal, kinds?: MemoryKind[]): Promise<Memory[]> {
    const memories = readMemories(this.root).filter((m) => !kinds || kinds.includes(m.kind));
    if (!memories.length) return [];
    const [qv] = (await this.embedder.embed([query], signal, 'query')) ?? [];
    const scores = rank(memories, memories.map((m) => m.text), query, qv);
    return scores
      .map((score, i) => ({ score, memory: memories[i]! }))
      .filter((s) => s.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => s.memory);
  }
}
