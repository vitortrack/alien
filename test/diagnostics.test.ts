import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { typeDiagnostics } from '../src/diagnostics.js';

function project(typescript?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trackai-diag-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true, lib: ['ES2022'] }, include: ['src'] }));
  fs.writeFileSync(path.join(root, 'src/ok.ts'), "import { other } from './other';\nexport const a = other(1);\n");
  fs.writeFileSync(path.join(root, 'src/bad.ts'), "export const b = () => {\n  const unused = 1;\n  return missingName + 1;\n};\n");
  if (typescript) {
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(typescript, path.join(root, 'node_modules/typescript'));
  }
  return root;
}

test('diagnostics: silent when the project has no TypeScript or the file is not TypeScript', () => {
  const root = project();
  assert.equal(typeDiagnostics(root, 'src/bad.ts'), '');
  assert.equal(typeDiagnostics(root, 'README.md'), '');
});

const ts5 = process.env.TRACKAI_TEST_TS5;
test('diagnostics: undefined names and unused locals are reported, unresolved imports are not', { skip: !ts5 && 'set TRACKAI_TEST_TS5 to a typescript@5 folder' }, () => {
  const root = project(ts5);
  assert.equal(typeDiagnostics(root, 'src/ok.ts'), '');
  const out = typeDiagnostics(root, 'src/bad.ts');
  assert.match(out, /src\/bad\.ts:3:10 TS2304: Cannot find name 'missingName'/);
  assert.match(out, /src\/bad\.ts:2:9 TS6133/);
});
