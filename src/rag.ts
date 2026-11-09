import fs from 'node:fs/promises';
import path from 'node:path';
import { projectDataDir } from './paths.js';

const INDEX_VERSION = 3;
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 12;
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 5_000;
const EMBED_BATCH = 32;
const IGNORED = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|\.trackai|vendor|__pycache__|\.venv|target)(\/|$)/;
const TEXT_EXT = new Set(
  'ts tsx js jsx mjs cjs py rb go rs java kt kts scala cs php c h cpp hpp swift m sql sh bash zsh md mdx txt json yaml yml toml ini cfg conf xml html css scss less vue svelte graphql proto dockerfile makefile gradle tf lua r dart ex exs erl hs clj'.split(
    ' ',
  ),
);

export type Chunk = { file: string; start: number; end: number; text: string; vector?: number[] };
type FileMeta = { mtimeMs: number; size: number };
type IndexData = { version: number; embedModel: string | null; files: Record<string, FileMeta>; chunks: Chunk[] };
export type Hit = { file: string; start: number; end: number; score: number; text: string };
export type BuildStats = { files: number; chunks: number; changed: number; embedded: boolean };

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9à-ÿ]+/)
    .filter((t) => t.length > 1 && t.length < 40);
}

export function chunkFile(file: string, content: string): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const text = lines.slice(start, end).join('\n');
    if (text.trim()) chunks.push({ file, start: start + 1, end, text });
    if (end === lines.length) break;
  }
  return chunks;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function bm25(query: string[], docs: string[][], k1 = 1.4, b = 0.75): number[] {
  const n = docs.length;
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, n);
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  const terms = [...new Set(query)];
  return docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term);
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avg));
    }
    return score;
  });
}

function normalize(values: number[]): number[] {
  const max = Math.max(...values);
  const min = Math.min(...values);
  return values.map((v) => (max > min ? (v - min) / (max - min) : 0));
}

function isTextFile(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop()! : base;
  return TEXT_EXT.has(ext);
}

export class Embedder {
  private available: boolean | undefined;

  constructor(
    readonly model: string,
    private readonly host = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  ) {}

  get ready(): boolean {
    return this.available === true;
  }

  private format(text: string, kind: 'query' | 'document'): string {
    if (this.model.includes('nomic')) return `search_${kind}: ${text}`;
    if (this.model.includes('embeddinggemma')) return kind === 'query' ? `task: code retrieval | query: ${text}` : `title: none | text: ${text}`;
    if (this.model.includes('qwen3-embedding') && kind === 'query') {
      return `Instruct: Given a question about a software project, possibly in another language, retrieve the source code that answers it\nQuery: ${text}`;
    }
    return text;
  }

  async embed(texts: string[], signal: AbortSignal, kind: 'query' | 'document' = 'document'): Promise<number[][] | null> {
    if (this.available === false || !texts.length) return null;
    try {
      const res = await fetch(`${this.host}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts.map((t) => this.format(t, kind)), truncate: true }),
        signal,
      });
      if (!res.ok) throw new Error(String(res.status));
      const out = (await res.json()) as { embeddings?: number[][] };
      this.available = Array.isArray(out.embeddings);
      return out.embeddings ?? null;
    } catch (e) {
      if (signal.aborted) throw e;
      this.available = false;
      return null;
    }
  }
}

export function rank<T extends { vector?: number[] }>(
  items: T[],
  texts: string[],
  query: string,
  qv: number[] | undefined,
  semanticWeight = 0.8,
): number[] {
  const lexical = normalize(bm25(tokenize(query), texts.map(tokenize)));
  if (!qv) return lexical;
  const semantic = normalize(items.map((it) => (it.vector ? cosine(qv, it.vector) : 0)));
  return items.map((_, i) => semanticWeight * semantic[i]! + (1 - semanticWeight) * lexical[i]!);
}

export type IndexOptions = { semanticWeight?: number; pattern?: string };

export class CodeIndex {
  private data: IndexData | null = null;

  private readonly semanticWeight: number;
  private readonly pattern: string;

  constructor(
    private readonly root: string,
    private readonly embedder: Embedder,
    options: IndexOptions = {},
  ) {
    this.semanticWeight = options.semanticWeight ?? 0.8;
    this.pattern = options.pattern ?? '**/*';
  }

  private get file(): string {
    return path.join(projectDataDir(this.root), 'index.json');
  }

  private async load(): Promise<IndexData> {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as IndexData;
      if (parsed.version === INDEX_VERSION) return (this.data = parsed);
    } catch {
      // no index yet
    }
    return (this.data = { version: INDEX_VERSION, embedModel: null, files: {}, chunks: [] });
  }

  async update(signal: AbortSignal): Promise<BuildStats> {
    const data = await this.load();
    const current: Record<string, FileMeta> = {};
    for await (const rel of fs.glob(this.pattern, { cwd: this.root, exclude: (name: string) => IGNORED.test(name) })) {
      if (!isTextFile(rel)) continue;
      const stat = await fs.stat(path.join(this.root, rel)).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) continue;
      current[rel] = { mtimeMs: stat.mtimeMs, size: stat.size };
      if (Object.keys(current).length >= MAX_FILES) break;
    }

    const modelChanged = data.embedModel !== null && data.embedModel !== this.embedder.model;
    const changed = Object.keys(current).filter((f) => {
      const old = data.files[f];
      return modelChanged || !old || old.mtimeMs !== current[f]!.mtimeMs || old.size !== current[f]!.size;
    });
    const changedSet = new Set(changed);
    const kept = data.chunks.filter((c) => current[c.file] && !changedSet.has(c.file));
    const fresh: Chunk[] = [];
    for (const f of changed) {
      const content = await fs.readFile(path.join(this.root, f), 'utf8').catch(() => '');
      if (!content.includes('\0')) fresh.push(...chunkFile(f, content));
    }

    const missing = [...kept.filter((c) => !c.vector), ...fresh];
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const batch = missing.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedder.embed(
        batch.map((c) => `${c.file}\n${c.text}`),
        signal,
      );
      if (!vectors) break;
      batch.forEach((c, k) => (c.vector = vectors[k]));
    }

    const embedded = this.embedder.ready;
    this.data = { version: INDEX_VERSION, embedModel: embedded ? this.embedder.model : null, files: current, chunks: [...kept, ...fresh] };
    if (changed.length || kept.length !== data.chunks.length || missing.length) {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.data));
    }
    return { files: Object.keys(current).length, chunks: this.data.chunks.length, changed: changed.length, embedded };
  }

  async search(query: string, k: number, signal: AbortSignal): Promise<{ hits: Hit[]; mode: string }> {
    await this.update(signal);
    const chunks = this.data!.chunks;
    if (!chunks.length) return { hits: [], mode: 'empty' };
    const [qv] = (await this.embedder.embed([query], signal, 'query')) ?? [];
    const scores = rank(chunks, chunks.map((c) => `${c.file} ${c.text}`), query, qv, this.semanticWeight);
    const hits = scores
      .map((score, i) => ({ score, i }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .filter((h) => h.score > 0)
      .map(({ score, i }) => ({ file: chunks[i]!.file, start: chunks[i]!.start, end: chunks[i]!.end, score, text: chunks[i]!.text }));
    return { hits, mode: qv ? `hybrid (BM25 + embeddings ${this.embedder.model})` : 'lexical (BM25; no embedding model available)' };
  }
}
