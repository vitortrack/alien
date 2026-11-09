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
    files: new Map(),
    allowed: new Set(),
    confirm: async () => 'yes',
    setPlan: () => undefined,
    delegate: async () => '',
  };
}

const tool = (name: string) => allTools.find((t) => t.name === name)!;

test('edit_file: exact edits on unread files, fresh read otherwise, syntax gate and snippet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-edit-'));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-read-'));
  fs.writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'));
  const out = await tool('read_file').run({ path: 'big.txt', offset: 500, limit: 10 }, context(root));
  assert.match(out, /^\[big\.txt: lines 500-509 of 1000; 499 lines above\]/);
  assert.match(out, /\[491 more lines below; continue with offset=510\]$/);
});

test('bash timeout kills the whole process group, not just the shell', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-bash-'));
  const marker = path.join(root, 'still-alive');
  const out = await tool('bash').run({ command: `(sleep 2 && touch ${marker}) & sleep 30`, timeout_seconds: 1 }, context(root));
  assert.match(out, /whole process group/);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(fs.existsSync(marker), false);
});

test('run_code runs in the workspace root so relative imports work, with quotes intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-run-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'a.js'), "export const who = 'mundo';\n");
  const ctx = context(root);
  assert.match(await tool('run_code').run({ language: 'node', code: "import { who } from './a.js'; console.log(`olá ${who}`, \"it's\");" }, ctx), /olá mundo it's/);
  assert.match(await tool('run_code').run({ language: 'python', code: "import os; print(os.path.exists('a.js'), \"it's\")" }, ctx), /True it's/);
});

test('creating a numbered file whose number is taken warns with the next free number', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-num-'));
  fs.mkdirSync(path.join(root, 'db/init'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db/init/001_drivers.sql'), '');
  fs.writeFileSync(path.join(root, 'db/init/002-vehicles.sql'), '');
  const ctx = context(root);
  const clash = await tool('write_file').run({ path: 'db/init/002_phone.sql', content: 'ALTER TABLE drivers ADD COLUMN phone text;\n' }, ctx);
  assert.match(clash, /number 002 is already used by 002-vehicles\.sql in this directory; the next free number is 003/);
  assert.doesNotMatch(await tool('write_file').run({ path: 'db/init/003_ok.sql', content: '' }, ctx), /Warning/);
  assert.doesNotMatch(await tool('write_file').run({ path: 'src/a.js', content: 'export {};\n' }, ctx), /Warning/);
});
