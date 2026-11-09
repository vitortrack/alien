import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CodeIndex, Embedder } from '../src/rag.js';

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: path.resolve(process.cwd(), '../detrorjweb') },
    models: { type: 'string', default: 'nomic-embed-text,bge-m3,qwen3-embedding:0.6b' },
    expander: { type: 'string', default: 'glm-5.3-flash:cloud' },
  },
});

const QUERIES: { q: string; expect: string[] }[] = [
  { q: 'onde as viagens são abertas e fechadas a partir da telemetria', expect: ['trip-detector.service.ts'] },
  { q: 'como o sistema decide se o veículo está online, atrasado ou offline', expect: ['connectivity-monitor.service.ts'] },
  { q: 'avaliação de atraso e adiantamento em relação à grade horária', expect: ['alert-rules-evaluator.service.ts'] },
  { q: 'consumo dos tracking_logs e gravação das posições', expect: ['telemetry-consumer.service.ts'] },
  { q: 'qual papel do container decide se roda os laços de fundo', expect: ['config/role.ts'] },
  { q: 'consulta pública da solicitação por protocolo e CPF', expect: ['solicitacao-acompanhamento.service.ts', 'acompanhar-solicitacao.dto.ts'] },
  { q: 'confirmar ou excluir a carteirinha RFID do aluno', expect: ['cards/services/cards.service.ts'] },
  { q: 'reprocessar leituras de embarque e desembarque já registradas', expect: ['card-reads-reprocessor.service.ts'] },
  { q: 'barra de ações em massa das carteirinhas emitidas', expect: ['IssuedCardsBulkBar.tsx', 'StudentCards.tsx'] },
  { q: 'recuperar o número do protocolo enviando por e-mail', expect: ['app-aluno.service.ts'] },
  { q: 'resolução das regras de alerta por especificidade com cache', expect: ['alert-rules.service.ts'] },
  { q: 'detectar veículo fora da rota', expect: ['off-route.service.ts'] },
];

async function expand(query: string): Promise<string> {
  const res = await fetch(`${process.env.OLLAMA_HOST ?? 'http://localhost:11434'}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: values.expander,
      stream: false,
      think: false,
      messages: [
        {
          role: 'user',
          content: `Rewrite this question about a codebase as 6-12 English search keywords: likely identifiers, file-name words and domain terms that would appear in the code. Output only the keywords, space-separated.\n\nQuestion: ${query}`,
        },
      ],
    }),
  });
  const out = (await res.json()) as { message?: { content?: string } };
  return out.message?.content?.trim() ?? '';
}

type Metrics = { hit1: number; hit3: number; hit5: number; mrr: number };

async function evaluate(index: CodeIndex, queries: { q: string; expect: string[] }[]): Promise<Metrics> {
  const signal = new AbortController().signal;
  const m: Metrics = { hit1: 0, hit3: 0, hit5: 0, mrr: 0 };
  for (const { q, expect } of queries) {
    const { hits } = await index.search(q, 40, signal);
    const files = [...new Set(hits.map((h) => h.file))];
    const rank = files.findIndex((f) => expect.some((e) => f.endsWith(e))) + 1;
    if (rank === 1) m.hit1++;
    if (rank && rank <= 3) m.hit3++;
    if (rank && rank <= 5) m.hit5++;
    if (rank) m.mrr += 1 / rank;
  }
  const n = queries.length;
  return { hit1: m.hit1 / n, hit3: m.hit3 / n, hit5: m.hit5 / n, mrr: m.mrr / n };
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-retrieval-'));
const row = (name: string, m: Metrics) =>
  console.log(`${name.padEnd(46)} ${(m.hit1 * 100).toFixed(0).padStart(4)}% ${(m.hit3 * 100).toFixed(0).padStart(5)}% ${(m.hit5 * 100).toFixed(0).padStart(5)}%  ${m.mrr.toFixed(3)}`);

console.log(`raiz: ${values.root} · ${QUERIES.length} perguntas\n`);
console.log(`${'configuração'.padEnd(46)} hit@1 hit@3 hit@5  MRR`);

const expanded = await Promise.all(QUERIES.map(async ({ q, expect }) => ({ q: `${q}\n${await expand(q)}`, expect })));

for (const model of values.models!.split(',')) {
  {
    process.env.TRACKAI_HOME = path.join(home, model.replace(/[:/]/g, '_'));
    const embedder = new Embedder(model);
    const build = new CodeIndex(values.root!, embedder, { pattern: '{api/src,web/src}/**/*' });
    const started = Date.now();
    const stats = await build.update(new AbortController().signal);
    if (!stats.embedded) {
      console.log(`${model} indisponível no Ollama — pulei`);
      continue;
    }
    const secs = Math.round((Date.now() - started) / 1000);
    for (const weight of [0.6, 0.8, 1]) {
      const index = new CodeIndex(values.root!, embedder, { semanticWeight: weight, pattern: '{api/src,web/src}/**/*' });
      row(`${model} · peso ${weight}`, await evaluate(index, QUERIES));
      row(`${model} · peso ${weight} · +expansão`, await evaluate(index, expanded));
    }
    console.log(`  (indexação: ${stats.chunks} trechos em ${secs}s)`);
  }
}

process.env.TRACKAI_HOME = path.join(home, 'lexical');
const lexical = new CodeIndex(values.root!, new Embedder('no-such-model'), { pattern: '{api/src,web/src}/**/*' });
row('só BM25', await evaluate(lexical, QUERIES));
row('só BM25 · +expansão', await evaluate(lexical, expanded));
