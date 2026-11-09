import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hardScenarios, realScenarios, scenarios } from './scenarios.js';

type Reference = { files?: Record<string, (old: string) => string>; answer: string };

const references: Record<string, Reference> = {
  'bug-two-causes': {
    files: { 'src/cart.js': (s) => s.replace('let i = 1', 'let i = 0').replace('sum * discountPercent', 'sum * discountPercent / 100') },
    answer: '',
  },
  'bug-shared-util': { files: { 'src/money.js': (s) => s.replace('cents / 10', 'cents / 100') }, answer: '' },
  'feature-coupon': {
    files: {
      'src/cart.js': (s) =>
        `${s}\nconst COUPONS = { DEZ: 10, VINTE: 20 };\nexport function applyCoupon(items, code) {\n  if (!(code in COUPONS)) throw new Error('Cupom inválido');\n  return total(items, COUPONS[code]);\n}\n`,
      'test.mjs': (s) => `${s}// applyCoupon covered\n`,
    },
    answer: '',
  },
  'edit-large-file': { files: { 'src/legacy.js': (s) => s.replace(".replace(/-/g, '')", ".replace(/\\D/g, '')") }, answer: '' },
  'refactor-rename': {
    files: Object.fromEntries(['src/pricing.js', 'src/checkout.js', 'src/report.js', 'test.mjs'].map((f) => [f, (s: string) => s.replaceAll('calcTotal', 'computeTotal')])),
    answer: '',
  },
  'diff-regression': {
    files: { 'src/shipping.js': (s) => s.replace('Math.round(base + weightKg * 3.2 * 100) / 100', 'Math.round((base + weightKg * 3.2) * 100) / 100') },
    answer: 'O Math.round perdeu os parênteses.',
  },
  'question-pt-over-en-code': {
    answer: 'O frete é calculado em `computeShippingCost` (src/shipping/cost.js:3), com taxa por zona; chamado em checkout.js:5 e quote.js:3.',
  },
  'question-reuse': {
    answer: "Reutilize isValidEmail de src/lib/validators.js na newsletter: `import { isValidEmail } from './lib/validators.js'`.",
  },
  'question-negative': { answer: 'Não há cache HTTP: src/http.js:1 faz fetch direto; memoize é só para funções puras.' },
  'hard-crlf-tabs': {
    files: { 'src/legacy.js': (s) => s.replace("\treturn Number(clean);", "\treturn Number(clean.replace(/\\./g, '').replace(',', '.'));") },
    answer: '',
  },
  'hard-duplicate-blocks': {
    files: { 'src/prices.js': (s) => s.replace(/(priceForSeniors\(base\) \{\n  const value = base \* )0\.5/, '$10.4') },
    answer: '',
  },
  'hard-multihop-bug': { files: { 'src/units.js': (s) => s.replace('ms / 1000', 'ms / 60000') }, answer: '' },
  'hard-python': { files: { 'inventory.py': (s) => s.replace('item["qty"] > threshold', 'item["qty"] < threshold') }, answer: '' },
  'hard-follow-pattern': {
    files: {
      'src/commands/upper.js': () => "export const upper = (args) => args.join(' ').toUpperCase();\n",
      'src/commands/index.js': (s) => s.replace("import { sum } from './sum.js';", "import { sum } from './sum.js';\nimport { upper } from './upper.js';").replace('{ hello, sum }', '{ hello, sum, upper }'),
    },
    answer: '',
  },
  'hard-scope': { files: { 'src/greeting.js': (s) => s.replace('name.trim', 'name.trim()') }, answer: '' },
  'hard-question-multihop': { answer: 'Atualiza orders_v2 com CANCELED_BY_USER via orderService.cancel, que antes verifica ownerId.' },
  'real-menu-memory': {
    files: {
      'src/store/trips.js': () =>
        "const trips = [];\nexport const tripsStore = { add: (t) => (trips.push({ id: trips.length + 1, ...t }), trips.at(-1)), list: () => [...trips] };\n",
      'src/pages/trips.js': () =>
        "import { tripsStore } from '../store/trips.js';\nexport const tripsPage = () => ({ title: 'Viagens', items: tripsStore.list(), submit: (f) => tripsStore.add(f) });\n",
      'src/menu.js': (s) => s.replace("{ label: 'Grades', to: '/grades', screen: 'schedules' },", "{ label: 'Grades', to: '/grades', screen: 'schedules' },\n      { label: 'Viagens', to: '/viagens', screen: 'routes' },"),
      'src/routes.js': (s) =>
        s.replace("import { canView } from './auth.js';", "import { canView } from './auth.js';\nimport { tripsPage } from './pages/trips.js';").replace("  { path: '/anotacoes'", "  { path: '/viagens', page: tripsPage, screen: 'routes' },\n  { path: '/anotacoes'"),
    },
    answer: '',
  },
  'real-fullstack-field': {
    files: {
      'web/pages/drivers.js': (s) =>
        s
          .replace("{ name: 'cnh', label: 'CNH' },", "{ name: 'cnh', label: 'CNH' },\n    { name: 'phone', label: 'Telefone' },")
          .replace("columns: ['Nome', 'CNH']", "columns: ['Nome', 'CNH', 'Telefone']")
          .replace('cnh: form.cnh }', 'cnh: form.cnh, phone: form.phone }'),
      'api/drivers.js': (s) => s.replace("['name', 'cnh']", "['name', 'cnh', 'phone']").replace(/id, name, cnh/g, 'id, name, cnh, phone'),
      'db/schema.js': (s) => s.replace("drivers: ['id', 'name', 'cnh']", "drivers: ['id', 'name', 'cnh', 'phone']"),
      'db/migrations/003_drivers_phone.sql': () => 'ALTER TABLE drivers ADD COLUMN phone text;\n',
    },
    answer: '',
  },
  'hard-two-far-edits': {
    files: { 'src/config.js': (s) => s.replace('export const MAX_RETRIES_HTTP = 3;', 'export const HTTP_MAX_RETRIES = 5;').replace('retries: MAX_RETRIES_HTTP', 'retries: HTTP_MAX_RETRIES') },
    answer: '',
  },
};

let ok = true;
for (const s of [...scenarios, ...hardScenarios, ...realScenarios]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trackai-sanity-${s.id}-`));
  for (const [file, content] of Object.entries({ ...s.files, ...(s.uncommitted ?? {}) })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const ref = references[s.id]!;
  if (s.kind !== 'question') execFileSync('git', ['-c', 'user.email=s@s', '-c', 'user.name=s', 'init', '-q'], { cwd: dir });
  if (s.kind !== 'question') execFileSync('git', ['-c', 'user.email=s@s', '-c', 'user.name=s', 'add', '.'], { cwd: dir });
  if (s.kind !== 'question') execFileSync('git', ['-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-qm', 'i'], { cwd: dir });
  const before = s.check(dir, '');
  for (const [file, patch] of Object.entries(ref.files ?? {})) {
    const p = path.join(dir, file);
    fs.writeFileSync(p, patch(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''));
  }
  let visible = 'n/a';
  if (s.kind !== 'question') {
    try {
      if (fs.existsSync(path.join(dir, 'test.mjs'))) execFileSync('node', ['test.mjs'], { cwd: dir, stdio: 'ignore' });
      else execFileSync('python3', ['-B', '-m', 'unittest', '-q'], { cwd: dir, stdio: 'ignore' });
      visible = 'pass';
    } catch {
      visible = 'FAIL';
    }
  }
  const after = s.check(dir, ref.answer);
  const good = !before.pass && after.pass && visible !== 'FAIL';
  ok &&= good;
  console.log(`${good ? '✔' : '✖'} ${s.id.padEnd(26)} sem correção: ${before.pass ? 'PASSA (ruim)' : 'falha'} · referência: ${after.pass ? 'passa' : `FALHA (${after.detail})`} · teste visível: ${visible}`);
}
process.exit(ok ? 0 : 1);
