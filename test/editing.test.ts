import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyEdit, similarity } from '../src/editing.js';
import { syntaxError } from '../src/syntax.js';
import { allTools, type ToolContext } from '../src/tools.js';

function edited(content: string, oldS: string, newS: string, all = false): string {
  const r = applyEdit(content, oldS, newS, all);
  if (!r.ok) throw new Error(r.error);
  return r.content;
}

test('exact match replaces once and reports ambiguity with line numbers', () => {
  assert.equal(edited('a\nb\nc\n', 'b', 'B'), 'a\nB\nc\n');
  const r = applyEdit('x = 1\ny\nx = 1\n', 'x = 1', 'x = 2', false);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /matches 2 places \(lines 1, 3\)/);
  assert.equal(edited('x = 1\ny\nx = 1\n', 'x = 1', 'x = 2', true), 'x = 2\ny\nx = 2\n');
});

test('CRLF files are edited with LF old_string and keep CRLF', () => {
  const crlf = 'function f() {\r\n\treturn 1;\r\n}\r\n';
  const out = edited(crlf, 'function f() {\n\treturn 1;\n}', 'function f() {\n\treturn 2;\n}');
  assert.equal(out, 'function f() {\r\n\treturn 2;\r\n}\r\n');
});

test('indentation-insensitive match reindents the replacement', () => {
  const src = 'class A {\n\tm() {\n\t\treturn 1;\n\t}\n}\n';
  const r = applyEdit(src, 'm() {\n    return 1;\n}', 'm() {\n    return 2;\n}', false);
  assert.ok(r.ok);
  assert.equal(r.ok && r.content, 'class A {\n\tm() {\n\t\treturn 2;\n\t}\n}\n');
  assert.equal(r.ok && r.strategy, 'ignoring indentation');
});

test('trailing whitespace and unicode punctuation do not break matching', () => {
  assert.equal(edited('const a = 1;   \nconst b = 2;\n', 'const a = 1;\nconst b = 2;', 'const a = 3;\nconst b = 2;'), 'const a = 3;\nconst b = 2;\n');
  assert.equal(edited("msg = 'it's ok'\n", 'msg = ‘it’s ok’', "msg = 'fine'"), "msg = 'fine'\n");
});

test('a near miss explains what is closest instead of failing silently', () => {
  const r = applyEdit('function total(items) {\n  return items.length;\n}\n', 'function totals(items) {\n  return items.length;\n}', 'x', false);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /Did you mean these lines \(\d+% similar\)\?\n\s+1\tfunction total\(items\)/);
  assert.ok(similarity('abc def', 'abc  def') === 1);
});

test('syntax check accepts valid code and reports the broken line', async () => {
  assert.equal(await syntaxError('a.ts', 'const x: number = 1;\n'), null);
  assert.match((await syntaxError('a.ts', 'const x = ;\n'))!, /line 1/);
  assert.equal(await syntaxError('c.controller.ts', "@Controller('d')\nexport class C {\n  list(@CurrentOperator() id: string) {\n    return id;\n  }\n}\n"), null);
  assert.match((await syntaxError('a.json', '{"a":1,}'))!, /trailing commas/);
  assert.equal(await syntaxError('notes.md', '# anything'), null);
});

function context(root: string): ToolContext {
  return {
    root,
    mode: 'auto',
    signal: new AbortController().signal,
    codeIndex: undefined as never,
    memory: undefined as never,
    skills: [],
    files: new Map(),
    allowed: new Set(),
    testEditsAllowed: true,
    testOriginals: new Map(),
    confirm: async () => 'yes',
    setPlan: () => undefined,
    delegate: async () => '',
  };
}

const tool = (name: string) => allTools.find((t) => t.name === name)!;

test('edit_file: exact edits on unread files, fresh read otherwise, syntax gate and snippet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alien-edit-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'export const a = 1;\nexport const b = 2;\n');
  const ctx = context(root);
  await assert.rejects(tool('edit_file').run({ path: 'nope.js', old_string: 'x', new_string: 'y' }, ctx), /does not exist\. Create it with write_file/);
  await assert.rejects(tool('edit_file').run({ path: 'a.js', old_string: 'export  const a = 1;', new_string: 'x' }, ctx), /have not read this file yet/);
  assert.match(await tool('edit_file').run({ path: 'a.js', old_string: 'b = 2', new_string: 'b = 4' }, ctx), /2\texport const b = 4;/);

  await tool('read_file').run({ path: 'a.js' }, ctx);
  await assert.rejects(tool('edit_file').run({ path: 'a.js', old_string: 'a = 1;', new_string: 'a = ;' }, ctx), /NOT applied: it would introduce a syntax error/);
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'export const a = 1;\nexport const b = 4;\n');

  const out = await tool('edit_file').run({ path: 'a.js', old_string: 'a = 1', new_string: 'a = 3' }, ctx);
  assert.match(out, /1\texport const a = 3;/);

  fs.writeFileSync(path.join(root, 'a.js'), 'changed outside\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'a.js'), later, later);
  await assert.rejects(tool('edit_file').run({ path: 'a.js', old_string: 'changed', new_string: 'x' }, ctx), /changed since you last read it[\s\S]*1\tchanged outside/);
  assert.match(await tool('edit_file').run({ path: 'a.js', old_string: 'changed', new_string: 'edited' }, ctx), /1\tedited outside/);

  fs.writeFileSync(path.join(root, 'a.js'), 'again\n');
  const evenLater = new Date(Date.now() + 10000);
  fs.utimesSync(path.join(root, 'a.js'), evenLater, evenLater);
  await assert.rejects(tool('write_file').run({ path: 'a.js', content: 'x' }, ctx), /changed since you last read it[\s\S]*1\tagain/);
  assert.match(await tool('write_file').run({ path: 'new/b.js', content: 'export {};\n' }, ctx), /Created new\/b\.js/);
});

test('read_file pages large files with a header and a continuation hint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alien-read-'));
  fs.writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'));
  const out = await tool('read_file').run({ path: 'big.txt', offset: 500, limit: 10 }, context(root));
  assert.match(out, /^\[big\.txt: lines 500-509 of 1000; 499 lines above\]/);
  assert.match(out, /\[491 more lines below; continue with offset=510\]$/);
});

test('bash timeout kills the whole process group, not just the shell', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alien-bash-'));
  const marker = path.join(root, 'still-alive');
  const out = await tool('bash').run({ command: `(sleep 2 && touch ${marker}) & sleep 30`, timeout_seconds: 1 }, context(root));
  assert.match(out, /whole process group/);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(fs.existsSync(marker), false);
});

test('run_code runs in the workspace root so relative imports work, with quotes intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alien-run-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'a.js'), "export const who = 'mundo';\n");
  const ctx = context(root);
  assert.match(await tool('run_code').run({ language: 'node', code: "import { who } from './a.js'; console.log(`olá ${who}`, \"it's\");" }, ctx), /olá mundo it's/);
  assert.match(await tool('run_code').run({ language: 'python', code: "import os; print(os.path.exists('a.js'), \"it's\")" }, ctx), /True it's/);
});

test('run_code in node calls the read-only tools and bash by RPC; only what it prints comes back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alien-rpc-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const alpha = 1;\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const beta = 2;\n');
  const ctx = context(root);
  const code = [
    "const files = (await tools.glob({ pattern: '*.ts' })).split('\\n');",
    "const hits = await tools.grep({ pattern: 'beta' });",
    "const first = await tools.read_file({ path: files[0] });",
    "const echo = await tools.bash({ command: 'echo from-bash' });",
    "console.log(files.length, hits.trim(), first.includes('alpha'), echo.split('\\n')[0]);",
    "try { await tools.write_file({ path: 'c.ts', content: 'x' }); } catch (e) { console.log('refused:', e.message); }",
    "try { await tools.read_file({ path: 'missing.ts' }); } catch (e) { console.log('failed:', /ENOENT/.test(e.message)); }",
  ].join('\n');
  const out = await tool('run_code').run({ language: 'node', code }, ctx);
  assert.match(out, /^2 \.\/b\.ts:1:export const beta = 2; true from-bash\n/);
  assert.match(out, /refused: tools\.write_file is not available in run_code\. Available: read_file, grep, glob, list_dir, bash\./);
  assert.match(out, /failed: true\n\[exit code 0\]$/);
  assert.equal(fs.existsSync(path.join(root, 'c.ts')), false);

  const readOnly = { ...context(root), mode: 'read-only' as const };
  const denied = await tool('run_code').run({ language: 'node', code: "try { await tools.bash({ command: 'touch x' }); } catch (e) { console.log(e.message); }" }, readOnly);
  assert.match(denied, /Permission denied: "bash" is not allowed in read-only mode/);
  assert.equal(fs.existsSync(path.join(root, 'x')), false);

  const capped = await tool('run_code').run({ language: 'node', code: "let n = 0; try { for (;;) { await tools.list_dir({}); n++; } } catch (e) { console.log(n, e.message); }" }, ctx);
  assert.match(capped, /^50 Limit of 50 tool calls per script reached\./);
});

test('creating a numbered file whose number is taken warns with the next free number', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alien-num-'));
  fs.mkdirSync(path.join(root, 'db/init'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db/init/001_drivers.sql'), '');
  fs.writeFileSync(path.join(root, 'db/init/002-vehicles.sql'), '');
  const ctx = context(root);
  const clash = await tool('write_file').run({ path: 'db/init/002_phone.sql', content: 'ALTER TABLE drivers ADD COLUMN phone text;\n' }, ctx);
  assert.match(clash, /number 002 is already used by 002-vehicles\.sql in this directory; the next free number is 003/);
  assert.doesNotMatch(await tool('write_file').run({ path: 'db/init/003_ok.sql', content: '' }, ctx), /Warning/);
  assert.doesNotMatch(await tool('write_file').run({ path: 'src/a.js', content: 'export {};\n' }, ctx), /Warning/);
});

test('test guard: existing assertions are read-only unless the request asks to change tests; renames and new tests pass', async () => {
  const { allowsTestEdits } = await import('../src/tools.js');
  assert.equal(allowsTestEdits('Inclua testes em test.mjs'), true);
  assert.equal(allowsTestEdits('Corrija o teste quebrado'), true);
  assert.equal(allowsTestEdits('Depois rode npm test e garanta que passe.'), false);
  assert.equal(allowsTestEdits('Os testes em test_slug.py precisam passar.'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alien-guard-'));
  const test = "import assert from 'node:assert/strict';\nassert.equal(calcTotal([1, 2]), 3);\nassert.equal(discount(100, 10), 85);\n";
  fs.writeFileSync(path.join(root, 'test.mjs'), test);
  const ctx = { ...context(root), testEditsAllowed: false };
  await tool('read_file').run({ path: 'test.mjs' }, ctx);
  await assert.rejects(tool('edit_file').run({ path: 'test.mjs', old_string: '85);', new_string: '90);' }, ctx), /changes or removes the existing assertion "assert\.equal\(discount\(100, 10\), 85\);"[\s\S]*report_conflict/);
  await assert.rejects(tool('write_file').run({ path: 'test.mjs', content: "import assert from 'node:assert/strict';\nassert.equal(calcTotal([1, 2]), 3);\n" }, ctx), /changes or removes/);
  await assert.rejects(tool('edit_file').run({ path: 'test.mjs', old_string: "'node:assert/strict';\n", new_string: "'node:assert/strict';\nprocess.exit(0);\n" }, ctx), /would skip or short-circuit/);
  assert.match(await tool('edit_file').run({ path: 'test.mjs', old_string: 'calcTotal([1, 2])', new_string: 'computeTotal([1, 2])' }, ctx), /Edited test\.mjs/);
  assert.match(await tool('edit_file').run({ path: 'test.mjs', old_string: '85);\n', new_string: '85);\nassert.equal(discount(50, 50), 25);\n' }, ctx), /Edited test\.mjs/);
  assert.match(await tool('edit_file').run({ path: 'test.mjs', old_string: 'discount(50, 50), 25);', new_string: 'discount(50, 50), 26);' }, ctx), /Edited test\.mjs/, 'assertions added in this task stay editable');
  await assert.rejects(tool('edit_file').run({ path: 'test.mjs', old_string: '85);\n', new_string: '86);\n' }, ctx), /changes or removes the existing assertion/);
  assert.match(await tool('edit_file').run({ path: 'test.mjs', old_string: '85);\n', new_string: '90);\n' }, { ...ctx, testEditsAllowed: true }), /Edited test\.mjs/);
});
