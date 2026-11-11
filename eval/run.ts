import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bestOf } from '../src/attempts.js';
import { orchestrate } from '../src/orchestrator.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { Session, type Config, type ProviderName } from '../src/session.js';
import type { Provider, StepResult, ToolResult } from '../src/types.js';
import { UI } from '../src/ui.js';
import { englishInProse } from './language.js';
import { cardScenarios } from './card-scenarios.js';
import { hardScenarios, harnessScenarios, impossibleScenarios, longScenarios, realScenarios, scenarios, skillScenarios, type Scenario } from './scenarios.js';

type Trace = { texts: string[]; steps: number; toolErrors: Record<string, number>; toolCalls: Record<string, number> };
type RunResult = {
  scenario: string;
  kind: string;
  run: number;
  pass: boolean;
  detail: string;
  seconds: number;
  steps: number;
  tokens: number;
  toolCalls: Record<string, number>;
  toolErrors: Record<string, number>;
  englishRate: number;
  englishSamples: string[];
  error?: string;
};

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '2' },
    filter: { type: 'string' },
    provider: { type: 'string', default: 'ollama' },
    model: { type: 'string', default: 'glm-5.3-flash:cloud' },
    concurrency: { type: 'string', default: '3' },
    label: { type: 'string', default: 'run' },
    suite: { type: 'string', default: 'all' },
    attempts: { type: 'string', default: '1' },
    review: { type: 'string', default: 'off' },
    tools: { type: 'string' },
    orchestrate: { type: 'string', default: 'off' },
  },
});

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-${values.label}`);
fs.mkdirSync(outDir, { recursive: true });
process.env.TRACKAI_USER_SKILLS = 'off';
process.env.TRACKAI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-eval-home-'));

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=eval@trackai', '-c', 'user.name=eval', ...args], { cwd: dir, stdio: 'ignore' });
}

function setup(s: Scenario): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trackai-eval-${s.id}-`));
  const write = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
  };
  write(s.files);
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'initial');
  if (s.uncommitted) write(s.uncommitted);
  return dir;
}

function recording(inner: Provider, trace: Trace): Provider {
  return {
    addUser: (text) => inner.addUser(text),
    snapshot: () => inner.snapshot(),
    restore: (state) => inner.restore(state),
    addToolResults: (results: ToolResult[]) => {
      for (const r of results) if (r.isError) trace.toolErrors[r.name] = (trace.toolErrors[r.name] ?? 0) + 1;
      inner.addToolResults(results);
    },
    step: async (req): Promise<StepResult> => {
      const r = await inner.step(req);
      trace.steps++;
      if (r.text.trim()) trace.texts.push(r.text);
      for (const c of r.toolCalls) trace.toolCalls[c.name] = (trace.toolCalls[c.name] ?? 0) + 1;
      return r;
    },
  };
}

async function runOne(s: Scenario, run: number): Promise<RunResult> {
  const dir = setup(s);
  const trace: Trace = { texts: [], steps: 0, toolErrors: {}, toolCalls: {} };
  const provider = values.provider as ProviderName;
  const cfg: Config = {
    provider,
    model: values.model!,
    mode: 'auto',
    root: dir,
    maxSteps: s.maxSteps ?? 40,
    review: s.kind !== 'question' && values.review === 'on',
    effort: 'high',
    numCtx: 65536,
    embedModel: process.env.TRACKAI_EMBED_MODEL ?? 'qwen3-embedding:0.6b',
    tokenBudget: 0,
    lang: 'pt-BR',
    logDir: null,
    tools: values.tools?.split(',').map((t) => t.trim()),
  };
  const log = fs.createWriteStream(path.join(outDir, `${s.id}-${run}.log`));
  const ui = UI.create(false, log);
  const make = () =>
    recording(provider === 'anthropic' ? new AnthropicProvider(cfg.model, cfg.effort) : new OllamaProvider(cfg.model, cfg.numCtx), trace);
  const attempts = Number(values.attempts);
  const session = new Session(cfg, ui, make);
  const started = Date.now();
  let answer = '';
  let error: string | undefined;
  try {
    if (attempts > 1) {
      const result = await bestOf(cfg, ui, s.task, attempts, make);
      answer = result.answer;
      session.usage.input = result.usage.input;
      session.usage.output = result.usage.output;
    } else if (values.orchestrate === 'on') answer = await orchestrate(session, s.task);
    else answer = await session.run(s.task);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  ui.close();
  log.end();
  const verdict = error ? { pass: false, detail: `crash: ${error}` } : s.check(dir, answer);
  const lang = englishInProse(trace.texts);
  fs.writeFileSync(path.join(outDir, `${s.id}-${run}.answer.md`), answer);
  return {
    scenario: s.id,
    kind: s.kind,
    run,
    pass: verdict.pass,
    detail: verdict.detail,
    seconds: Math.round((Date.now() - started) / 1000),
    steps: trace.steps,
    tokens: session.usage.input + session.usage.output,
    toolCalls: trace.toolCalls,
    toolErrors: trace.toolErrors,
    englishRate: lang.rate,
    englishSamples: lang.samples,
    ...(error ? { error } : {}),
  };
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

const suites: Record<string, Scenario[]> = { base: scenarios, hard: hardScenarios, real: realScenarios, impossible: impossibleScenarios, long: longScenarios, skills: skillScenarios, card: cardScenarios, harness: harnessScenarios, all: [...scenarios, ...hardScenarios, ...realScenarios] };
const selected = (suites[values.suite!] ?? suites.all!).filter((s) => !values.filter || s.id.includes(values.filter));
const jobs = selected.flatMap((s) => Array.from({ length: Number(values.runs) }, (_, k) => ({ s, run: k + 1 })));
console.log(`TrackAI eval · ${values.provider}/${values.model} · ${selected.length} cenários × ${values.runs} = ${jobs.length} execuções → ${outDir}`);

const results = await pool(jobs, Number(values.concurrency), async ({ s, run }) => {
  const r = await runOne(s, run);
  console.log(`${r.pass ? '✔' : '✖'} ${r.scenario}#${r.run} ${r.seconds}s ${r.steps} passos ${r.tokens} tok — ${r.detail}`);
  return r;
});

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const editCalls = sum(results.map((r) => (r.toolCalls.edit_file ?? 0) + (r.toolCalls.write_file ?? 0)));
const editErrors = sum(results.map((r) => (r.toolErrors.edit_file ?? 0) + (r.toolErrors.write_file ?? 0)));
const allCalls = sum(results.flatMap((r) => Object.values(r.toolCalls)));
const allErrors = sum(results.flatMap((r) => Object.values(r.toolErrors)));

console.log('\ncenário                     acerto  passos  tokens   seg   inglês');
for (const s of selected) {
  const rs = results.filter((r) => r.scenario === s.id);
  const passed = rs.filter((r) => r.pass).length;
  console.log(
    `${s.id.padEnd(27)} ${`${passed}/${rs.length}`.padStart(5)}  ${avg(rs.map((r) => r.steps)).toFixed(1).padStart(6)}  ${Math.round(avg(rs.map((r) => r.tokens))).toString().padStart(6)}  ${Math.round(avg(rs.map((r) => r.seconds))).toString().padStart(4)}  ${(avg(rs.map((r) => r.englishRate)) * 100).toFixed(1).padStart(5)}%`,
  );
}
const summary = {
  model: `${values.provider}/${values.model}`,
  label: values.label,
  passRate: results.filter((r) => r.pass).length / results.length,
  runs: results.length,
  editFailureRate: editCalls ? editErrors / editCalls : 0,
  toolErrorRate: allCalls ? allErrors / allCalls : 0,
  avgEnglishRate: avg(results.map((r) => r.englishRate)),
  avgSteps: avg(results.map((r) => r.steps)),
  avgTokens: avg(results.map((r) => r.tokens)),
};
console.log(
  `\nACERTO ${(summary.passRate * 100).toFixed(0)}% (${results.filter((r) => r.pass).length}/${results.length}) · falha de edição ${(summary.editFailureRate * 100).toFixed(1)}% · erro de ferramenta ${(summary.toolErrorRate * 100).toFixed(1)}% · inglês na prosa ${(summary.avgEnglishRate * 100).toFixed(2)}%`,
);
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ summary, results }, null, 2));
