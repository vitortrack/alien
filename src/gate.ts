import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectDocs } from './prompts.js';
import { CONTRACT_SCHEMA, runChecks, type CheckResult, type Contract, type Criterion, type Judge } from './contract.js';

const MAX_FILES = 400;

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
  const baseline = await runChecks(root, draft.slices.flatMap((s) => s.criteria));
  const gate = baseline.filter((r) => (r.criterion.guard ? r.pass : !r.pass)).map((r) => r.criterion);
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(gate, null, 2));
  }
  return gate;
}

export async function orderedChecks(root: string, gate: Criterion[]): Promise<CheckResult[]> {
  const first = await runChecks(root, gate.filter((c) => !c.guard));
  if (first.some((r) => !r.pass)) return first;
  return [...first, ...(await runChecks(root, gate.filter((c) => c.guard)))];
}
