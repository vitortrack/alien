import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface Criterion {
  text: string;
  check: string;
  guard: boolean;
}

export interface Slice {
  title: string;
  spec: string;
  files: string[];
  criteria: Criterion[];
}

export interface Contract {
  slices: Slice[];
}

export interface Problem {
  file: string;
  problem: string;
  fix: string;
}

export interface Review {
  approved: boolean;
  problems: Problem[];
}

export interface CheckResult {
  criterion: Criterion;
  pass: boolean;
  output: string;
}

export interface Judge {
  ask<T>(prompt: string, schema: object, tools: string[]): Promise<T>;
  costUsd: number;
}

const text = { type: 'string' };
const list = (items: object) => ({ type: 'array', items });
const object = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const CONTRACT_SCHEMA = object({
  slices: list(object({ title: text, spec: text, files: list(text), criteria: list(object({ text, check: text, guard: { type: 'boolean' } })) })),
});

export const REVIEW_SCHEMA = object({ approved: { type: 'boolean' }, problems: list(object({ file: text, problem: text, fix: text })) });

export interface Ruling {
  text: string;
  checkIsWrong: boolean;
  check: string;
  note: string;
}

export const RULING_SCHEMA = object({ rulings: list(object({ text, checkIsWrong: { type: 'boolean' }, check: text, note: text })) });

export const READ_TOOLS = ['Read', 'Grep', 'Glob'];
export const REVIEW_TOOLS = [...READ_TOOLS, 'Bash(git diff:*)', 'Bash(git status:*)'];

const CHECK_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 1500;
const JUDGE_TIMEOUT_MS = 30 * 60_000;

export function claudeJudge(root: string, model = 'opus'): Judge {
  const judge: Judge = {
    costUsd: 0,
    async ask<T>(prompt: string, schema: object, tools: string[]): Promise<T> {
      const { stdout } = await exec(
        'claude',
        ['-p', prompt, '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--allowedTools', ...tools, '--no-session-persistence'],
        { cwd: root, timeout: JUDGE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      );
      const out = JSON.parse(stdout) as { is_error?: boolean; result?: string; structured_output?: T; total_cost_usd?: number };
      judge.costUsd += out.total_cost_usd ?? 0;
      if (out.is_error || !out.structured_output) throw new Error(`motor de decisão falhou: ${String(out.result ?? stdout).slice(0, 300)}`);
      return out.structured_output;
    },
  };
  return judge;
}

export async function runChecks(root: string, criteria: Criterion[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const criterion of criteria) {
    try {
      const { stdout, stderr } = await exec('bash', ['-c', criterion.check], { cwd: root, timeout: CHECK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
      results.push({ criterion, pass: true, output: `${stdout}${stderr}`.slice(-OUTPUT_LIMIT) });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      results.push({ criterion, pass: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}`.slice(-OUTPUT_LIMIT) || err.message.slice(0, OUTPUT_LIMIT) });
    }
  }
  return results;
}

export function contractPrompt(goal: string): string {
  return `You are the decision engine of a coding pipeline. A weaker coding model will implement the request below in this repository, one slice at a time, each slice in a fresh context that sees ONLY its slice (never the original request). After each slice an automatic gate runs your checks; the slice is accepted only when they all exit 0.

Explore the repository (read the project instructions such as AGENTS.md / CLAUDE.md, the files the request touches and how the project is built and type-checked), then write the contract.

Slices:
- 1 to 8 slices, ordered so that each one only depends on earlier ones; each slice touches 1 to 3 files.
- "spec" is self-contained: quote verbatim every message, value, name, rule and limit of the request that belongs to the slice; say which files to change or create, which existing pattern to copy, and the exact exported names, signatures and data shapes the checks will use. Include the project instructions that apply (naming, comments, layout).
- "files": the files the slice changes or creates.

Criteria (every requirement of the request must be covered by at least one criterion):
- "check" is a bash command run from the repository root that exits 0 if and only if the criterion holds. It must be fast (under 60 s), deterministic, offline, and must not modify the repository.
- Prefer behavioral checks (e.g. node --input-type=module -e "import {x} from './src/a.js'; ...assert...") over grep. Use grep only for literal user-facing text or for something that must be absent.
- A check must fail on the current code: the request is not implemented yet. The only exception is a regression guard (the project's existing build, type-check or tests that must keep passing): mark it "guard": true; everything else "guard": false.
- Put the project's type-check or build as a guard in every slice that changes code it covers.

<request>
${goal}
</request>`;
}

export function revisePrompt(goal: string, contract: Contract, alreadyPassing: Criterion[]): string {
  return `${contractPrompt(goal)}

You already wrote the contract below, but these non-guard checks already pass on the unchanged code, so they prove nothing. Rewrite them so they fail now and pass only once the criterion is implemented (or mark them as guards if they really are regression guards). Return the whole corrected contract.

<already_passing>
${alreadyPassing.map((c) => `- ${c.text}: ${c.check}`).join('\n')}
</already_passing>

<contract>
${JSON.stringify(contract, null, 2)}
</contract>`;
}

export function reviewPrompt(goal: string, contract: Contract): string {
  return `You are the final reviewer of a coding pipeline. A weaker coding model implemented the request below in this repository, guided by the contract below; all its checks pass. Inspect the actual changes (git status, git diff, and the new files) and the code around them.

Report only real problems:
- a requirement of the request that is missing or wrong, even if a check passes;
- code written to satisfy a check without implementing the behavior (text placed in comments, special-cased inputs, hard-coded results);
- code that breaks, or a violation of the project instructions (AGENTS.md / CLAUDE.md);
- changes the request does not need.
No style preferences or pre-existing issues. approved = true when there is no real problem; then problems is empty.

<request>
${goal}
</request>

<contract>
${JSON.stringify(contract, null, 2)}
</contract>`;
}

export function arbitratePrompt(brief: string, failed: CheckResult[]): string {
  return `You are the decision engine of a coding pipeline. A weaker coding model worked on the assignment below several times, and the automatic gate still fails on the checks listed at the end. Inspect the current code in this repository and decide, for each failing check, whether the check itself is wrong (wrong path or working directory, a name or shape the assignment never specified, a broken command) or the code does not implement the criterion.
- checkIsWrong true: "check" is the corrected bash command. Same rules as before: run from the repository root, exits 0 if and only if the criterion holds, fast, offline, no writes. "note" says what was wrong with it.
- checkIsWrong false: "check" repeats the original command, and "note" says precisely what the code must change.
Return one ruling per failing check, in the same order; "text" repeats the criterion.

<assignment>
${brief}
</assignment>

<failing_checks>
${failed.map((f) => `- ${f.criterion.text}\n  $ ${f.criterion.check}\n${f.output.trim() || '(no output)'}`).join('\n')}
</failing_checks>`;
}

export function sliceBrief(slice: Slice): string {
  return `${slice.title}

${slice.spec}

Files: ${slice.files.join(', ')}

When you finish, an automatic gate runs these checks from the repository root; every one must exit 0. Implement the behavior they describe; do not write code just to satisfy a command.
${slice.criteria.map((c) => `- ${c.text}\n  $ ${c.check}`).join('\n')}`;
}

export function failureBrief(brief: string, failed: CheckResult[]): string {
  return `${brief}

A previous attempt left the workspace as it is now, and the gate failed. Fix the cause of each failure below without undoing what already works:
${failed.map((f) => `- ${f.criterion.text}\n  $ ${f.criterion.check}\n${f.output.trim() || '(no output)'}`).join('\n')}`;
}

export function fixBrief(problems: Problem[], criteria: Criterion[]): string {
  return `An independent reviewer found these problems in the current changes. Fix each one, keeping every check below passing.
${problems.map((p, k) => `${k + 1}. ${p.file}: ${p.problem}\n   Fix: ${p.fix}`).join('\n')}

Checks:
${criteria.map((c) => `- ${c.text}\n  $ ${c.check}`).join('\n')}`;
}
