import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectDocs } from './prompts.js';
import { workspaceDiff } from './scope.js';
import { CONTRACT_SCHEMA, runChecks, type CheckResult, type Contract, type Criterion, type Judge } from './contract.js';

const MAX_FILES = 400;
const MAX_DIFF = 60_000;
const JUDGED = 'judge:';

export const MINIMAL_DIFF: Criterion = {
  text: 'The diff is the smallest change that meets the request: no file, type, constant table, helper, abstraction or layer that the request and the project instructions do not need',
  check: `${JUDGED} Is this diff the smallest change that meets the request, with nothing the request and the project instructions do not need?`,
  guard: false,
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['pass', 'reason'],
  additionalProperties: false,
};

export const isJudged = (c: Criterion): boolean => c.check.startsWith(JUDGED);

function listFiles(root: string): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 50_000_000 }).split('\n').filter((f) => f && !/(^|\/)(node_modules|dist)\/|\.(png|jpe?g|gif|ico|lock)$|package-lock\.json$/.test(f));
  } catch {
    return [];
  }
}

export function gatePrompt(request: string, files: string[], docs = ''): string {
  const shown = files.slice(0, MAX_FILES);
  return `Write the acceptance checks for the coding request below. Do not explore the repository: you have no tools on purpose, so use only the request and the file list below.

Each check is a bash command run from the repository root that exits 0 if and only if one requirement of the request holds. It must be fast (under 60 s), offline and read-only.
- Cover every requirement of the request with at least one check.
- A check that limits which files or folders may change must allow test files (tests/, __tests__/, *.spec.*, *.test.*): adding tests never breaks scope.
- Also cover what the project instructions below require of every change (for example a test for each scenario), checking the changed or new files (git status --porcelain, git diff) rather than the whole repository.
- Prefer grep for literal user-facing text, codes and names that the request states exactly; use a behavioral check only when the request fixes the exact names it relies on.
- Add the project's existing type-check or build as a guard ("guard": true), using the package.json files in the list to pick the command; every other check has "guard": false.
- Checks that already pass on the current code are dropped automatically, so write each check to fail until its requirement is implemented.
Put every check in a single slice.

<request>
${request}
</request>
${docs ? `\n<project_instructions>\n${docs}\n</project_instructions>\n` : ''}
<files${files.length > shown.length ? ` shown="${shown.length}" total="${files.length}"` : ''}>
${shown.join('\n')}
</files>`;
}

export async function gateFor(root: string, request: string, judge: Judge, file?: string): Promise<Criterion[]> {
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as Criterion[];
  const draft = await judge.ask<Contract>(gatePrompt(request, listFiles(root), projectDocs(root)), CONTRACT_SCHEMA, []);
  const baseline = await runChecks(root, draft.slices.flatMap((s) => s.criteria).filter((c) => !isJudged(c)));
  const gate = [...baseline.filter((r) => (r.criterion.guard ? r.pass : !r.pass)).map((r) => r.criterion), MINIMAL_DIFF];
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(gate, null, 2));
  }
  return gate;
}

export function judgePrompt(request: string, docs: string, diff: string, question: string): string {
  return `Answer one acceptance question about the change below by reading it. Answer pass=false only when you can name the part that should not be there; say which in "reason" and how the change gets smaller.

<request>
${request}
</request>
${docs ? `\n<project_instructions>\n${docs}\n</project_instructions>\n` : ''}
<diff>
${diff.slice(0, MAX_DIFF)}
</diff>

Question: ${question}`;
}

export async function orderedChecks(root: string, gate: Criterion[], judged?: { request: string; judge: Judge }): Promise<CheckResult[]> {
  const first = await runChecks(root, gate.filter((c) => !c.guard && !isJudged(c)));
  if (first.some((r) => !r.pass)) return first;
  const all = [...first, ...(await runChecks(root, gate.filter((c) => c.guard)))];
  if (!judged || all.some((r) => !r.pass)) return all;
  const docs = projectDocs(root);
  const diff = (await workspaceDiff(root)) ?? '';
  for (const criterion of gate.filter(isJudged)) {
    const v = await judged.judge.ask<{ pass: boolean; reason: string }>(judgePrompt(judged.request, docs, diff, criterion.check.slice(JUDGED.length).trim()), VERDICT_SCHEMA, []);
    all.push({ criterion, pass: v.pass, output: v.reason });
  }
  return all;
}
