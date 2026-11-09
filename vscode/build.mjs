import { cpSync } from 'node:fs';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode', 'esbuild'],
  logLevel: 'info',
  logOverride: { 'empty-import-meta': 'silent' },
});

cpSync('../py/repomap.py', 'dist/py/repomap.py');
