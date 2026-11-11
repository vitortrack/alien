import fs from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { claudeJudge, type Judge } from './contract.js';

export interface Verdict {
  winner: 'A' | 'B' | 'tie';
  rationale: string;
}

export interface Refinement {
  harness: string;
  changes: string[];
  evidence_used: string[];
}

const text = { type: 'string' };
const list = { type: 'array', items: text };
const object = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const VERDICT_SCHEMA = object({ winner: { type: 'string', enum: ['A', 'B', 'tie'] }, rationale: text });
export const DIGEST_SCHEMA = object({ digest: text });
export const REFINE_SCHEMA = object({ harness: text, changes: list, evidence_used: list });

const OUTPUT_LIMIT = 50_000;

const clip = (output: string): string =>
  output.length <= OUTPUT_LIMIT ? output : `${output.slice(0, OUTPUT_LIMIT)}\n… [truncated: ${output.length - OUTPUT_LIMIT} more characters]`;

export function comparePrompt(request: string, a: string, b: string): string {
  return `You are a senior engineer comparing two completed attempts at the same coding request in the same repository. Each output is the attempt's diff against the same base. Judge only the request and the diffs; do not invent content that is not shown.

Criteria, in order:
1. Coverage: every explicit requirement of the request is implemented (not only mentioned).
2. Correctness: the code would work; no contradictions, broken references or placeholder logic.
3. Project rules: naming, file layout and constraints stated in the request.
4. Engineering: minimal, readable changes; nothing the request did not ask for.
5. Alignment: the attempt solves the stated problem, without drifting to another one.

Choose A or B when one clearly satisfies the request better; tie only when they are genuinely comparable. Cite concrete files and lines in the rationale.

<request>
${request}
</request>

<output_A>
${clip(a)}
</output_A>

<output_B>
${clip(b)}
</output_B>`;
}

export function refinePrompt(request: string, harness: string, evidence: string, history: Verdict[]): string {
  return `You are a principal prompt engineer for an autonomous coding agent. The agent works as a single agent with read, write and bash tools; do not add subagents, delegation or parallel workers. Your task is to rewrite only the task harness: a text block given to the agent before the request below, specific to this request. Do not change the request.

Improve the harness with:
- contracts: the exact files, exported names, fields and messages each step must produce, and what the final report and handoff note must record so the next run can continue without re-reading;
- hops: an ordered list of steps, each with the check that must pass before moving on;
- auxiliary rules: acceptance gates before finishing, fallback rules and recall triggers, each grounded in a concrete failure from the evidence below.
Ground every change in the evidence (quote files, errors, failing checks). Avoid generic advice. Keep what the history shows worked; fix what it shows failed.

<request>
${request}
</request>

<current_harness>
${harness.trim() || '(empty)'}
</current_harness>

<evidence_from_last_run>
${clip(evidence)}
</evidence_from_last_run>

<pairwise_history>
${history.map((v, i) => `${i + 1}. winner: ${v.winner} — ${v.rationale}`).join('\n') || '(none yet)'}
</pairwise_history>

Return the full replacement harness, the list of changes and the evidence you used.`;
}

const DOC_LIMIT = 150_000;

export function digestPrompt(request: string, docs: { path: string; text: string }[]): string {
  return `Summarize the reference documents below into a digest for a coding agent that will implement the request. Keep only what the request needs: exact constants, names, file paths, data shapes, messages, decisions already taken and the reasons, each with its source (file and section). Drop history, alternatives that were discarded and anything the request does not touch. The agent will rely on this digest instead of reading the documents, so be exact and complete for the request.

<request>
${request}
</request>

${docs.map((d) => `<document path="${d.path}">\n${d.text.length > DOC_LIMIT ? `${d.text.slice(0, DOC_LIMIT)}\n… [truncated]` : d.text}\n</document>`).join('\n\n')}`;
}

export const digest = async (judge: Judge, request: string, files: string[]): Promise<string> =>
  (await judge.ask<{ digest: string }>(digestPrompt(request, files.map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') }))), DIGEST_SCHEMA, [])).digest;

export const compare = (judge: Judge, request: string, a: string, b: string): Promise<Verdict> => judge.ask<Verdict>(comparePrompt(request, a, b), VERDICT_SCHEMA, []);

export const refine = (judge: Judge, request: string, harness: string, evidence: string, history: Verdict[]): Promise<Refinement> =>
  judge.ask<Refinement>(refinePrompt(request, harness, evidence, history), REFINE_SCHEMA, []);

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { docs: { type: 'string' }, task: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' }, harness: { type: 'string' }, evidence: { type: 'string' }, history: { type: 'string' } },
  });
  const read = (file: string | undefined): string => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const judge = claudeJudge(os.tmpdir());
  const request = read(values.task);
  if (positionals[0] === 'digest') {
    console.log(await digest(judge, request, (values.docs ?? '').split(',').filter(Boolean)));
    return;
  }
  const result =
    positionals[0] === 'compare'
      ? await compare(judge, request, read(values.a), read(values.b))
      : await refine(judge, request, read(values.harness), read(values.evidence), (JSON.parse(read(values.history) || '[]') as Verdict[]));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1]?.endsWith('rhi.ts')) void main();
