import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReadOnlyCommand, programOf, splitShell } from '../src/shell.js';
import { allTools, permit, type Decision, type ToolContext } from '../src/tools.js';

test('read-only shell commands are recognized, including quoted pipes', () => {
  const readOnly = [
    String.raw`grep -n "path=\|element=\|RequireScreen" web/src/App.tsx | head -60; wc -l web/src/App.tsx`,
    'ls -la && cat package.json',
    'git status --short && git diff --stat',
    'git log --oneline | head -5',
    'find src -name "*.ts" | wc -l',
    "sed -n '10,20p' src/a.ts",
    'cd api && grep -rn "operator_id" src 2>/dev/null | head',
    'npm test 2>&1 | tail -1'.replace('npm test', 'cat out.txt'),
  ];
  for (const cmd of readOnly) assert.equal(isReadOnlyCommand(cmd), true, cmd);
});

test('anything that can change state still needs permission', () => {
  const mutating = [
    'npm test',
    'echo hi > out.txt',
    'cat a | tee b',
    'sed -i s/a/b/ file',
    'find . -name "*.tmp" -delete',
    'find . -exec rm {} \\;',
    'git commit -m x',
    'git branch -D old',
    'grep x $(rm -rf foo)',
    'grep x `touch y`',
    'ls & rm a',
    'FOO=1 ls',
    'sort -o out.txt in.txt',
    'cat "unterminated',
  ];
  for (const cmd of mutating) assert.equal(isReadOnlyCommand(cmd), false, cmd);
});

test('shell splitting respects quotes and escapes', () => {
  assert.deepEqual(splitShell(`grep "a|b; c" f | head`), [['grep', 'a|b; c', 'f'], ['head']]);
  assert.equal(programOf('cd api && npm run build'), 'npm run');
  assert.equal(programOf('pytest -q'), 'pytest');
});

function ctx(answers: Decision[]): ToolContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    root: '/tmp',
    mode: 'ask',
    signal: new AbortController().signal,
    codeIndex: undefined as never,
    memory: undefined as never,
    files: new Map(),
    allowed: new Set(),
    testEditsAllowed: true,
    asked,
    confirm: async (q) => {
      asked.push(q);
      return answers.shift() ?? 'no';
    },
    setPlan: () => undefined,
    delegate: async () => '',
  };
}

const bash = allTools.find((t) => t.name === 'bash')!;
const edit = allTools.find((t) => t.name === 'edit_file')!;

test('ask mode: read-only commands skip the prompt and "always" is remembered per scope', async () => {
  const c = ctx(['always', 'yes']);
  assert.equal(await permit(bash, { command: 'grep -rn foo src | head' }, c), null);
  assert.equal(c.asked.length, 0);

  assert.equal(await permit(edit, { path: 'a', old_string: 'x', new_string: 'y' }, c), null);
  assert.equal(await permit(edit, { path: 'b', old_string: 'x', new_string: 'y' }, c), null);
  assert.equal(c.asked.length, 1);

  assert.equal(await permit(bash, { command: 'npm test' }, c), null);
  assert.equal(c.asked.length, 2);
  assert.match((await permit(bash, { command: 'npm run build' }, c))!, /denied/);
  assert.equal(c.asked.length, 3);
});

test('dangerous commands always ask, even after "always"', async () => {
  const c = ctx(['always', 'no']);
  assert.equal(await permit(bash, { command: 'git status' }, c), null);
  assert.equal(await permit(bash, { command: 'git push origin main' }, c), null);
  assert.match((await permit(bash, { command: 'git push --force origin main' }, c))!, /denied/);
  assert.equal(c.asked.length, 2);
  assert.match(c.asked[1]!, /destrutivo/);
});

test('read-only mode still allows read-only shell commands', async () => {
  const c = { ...ctx([]), mode: 'read-only' as const };
  assert.equal(await permit(bash, { command: 'git log --oneline | head' }, c), null);
  assert.match((await permit(bash, { command: 'npm install' }, c))!, /read-only mode/);
});

test('scope check flags changed areas the request never mentions', async () => {
  const { scopeReport } = await import('../src/scope.js');
  const task = 'Adicione um novo menu de Viagens que registre viagens em memória';
  const report = scopeReport(task, ['src/menu.js', 'src/routes.js', 'src/store/trips.js', 'backend/permissions/screens.js', 'db/migrations/002.sql']);
  assert.match(report!, /does not mention backend\/ or db\//);
  assert.match(report!, /- backend\/permissions\/screens\.js\n- db\/migrations\/002\.sql/);
  assert.equal(scopeReport(task, ['src/menu.js', 'src/routes.js']), null);
  assert.equal(scopeReport('crie o endpoint na api e a tela', ['web/a.tsx', 'web/b.tsx', 'api/c.ts']), null);
  assert.equal(scopeReport(task, ['src/menu.js', 'test.mjs']), null);
  const fullstack = 'Na tela de Motoristas, adicione o campo Telefone. Ele precisa ser salvo junto com o cadastro e aparecer na listagem.';
  assert.equal(scopeReport(fullstack, ['web/pages/drivers.js', 'api/drivers.js', 'db/schema.js', 'db/migrations/003.sql']), null);
  assert.match(scopeReport('Na tela de Motoristas, mude o rótulo CNH', ['web/pages/drivers.js', 'api/drivers.js', 'db/schema.js'])!, /does not mention api\/ or db\//);
});

test('nested CLAUDE.md/AGENTS.md are attached once when a file under them is touched', async () => {
  const { nestedInstructions } = await import('../src/scope.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-nested-'));
  fs.mkdirSync(path.join(root, 'db/init'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'root rules');
  fs.writeFileSync(path.join(root, 'db/CLAUDE.md'), 'Never edit an applied migration.');
  const seen = new Set<string>();
  const first = await nestedInstructions(root, 'db/init/001.sql', seen);
  assert.match(first, /\[instructions from db\/CLAUDE\.md — they apply to files under db\/\]\nNever edit an applied migration\./);
  assert.doesNotMatch(first, /root rules/);
  assert.equal(await nestedInstructions(root, 'db/init/002.sql', seen), '');
  assert.equal(await nestedInstructions(root, 'src/a.ts', seen), '');
});

test('workspaceDiff gives the reviewer tracked edits and new files in one block', async () => {
  const { workspaceDiff } = await import('../src/scope.js');
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-diff-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  assert.equal(await workspaceDiff(root), null);
  fs.writeFileSync(path.join(root, 'a.js'), 'old\n');
  git('add', '.');
  git('commit', '-qm', 'i');
  fs.writeFileSync(path.join(root, 'a.js'), 'new\n');
  fs.writeFileSync(path.join(root, 'b.js'), 'created\n');
  const diff = (await workspaceDiff(root))!;
  assert.match(diff, /-old\n\+new/);
  assert.match(diff, /--- new file: b\.js\ncreated/);
});

test('concurrent index updates share one build (background warm-up + first search)', async () => {
  const { CodeIndex, Embedder } = await import('../src/rag.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-warm-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'export const a = 1;\n');
  process.env.TRACKAI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-warm-home-'));
  const index = new CodeIndex(root, new Embedder('none', 'http://127.0.0.1:9'));
  const signal = new AbortController().signal;
  const first = index.update(signal);
  assert.equal(index.update(signal), first);
  assert.equal((await first).files, 1);
  assert.notEqual(index.update(signal), first);
});
