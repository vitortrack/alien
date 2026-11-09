import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type Check = { pass: boolean; detail: string };

export interface Scenario {
  id: string;
  kind: 'bug' | 'feature' | 'edit' | 'refactor' | 'diff' | 'question';
  files: Record<string, string>;
  uncommitted?: Record<string, string>;
  task: string;
  check(dir: string, answer: string): Check;
}

const PKG = '{"type":"module","scripts":{"test":"node test.mjs"}}\n';

function runNode(dir: string, code: string): Check {
  try {
    const out = execFileSync('node', ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { pass: true, detail: out.trim().slice(0, 200) || 'hidden checks passed' };
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { pass: false, detail: (err.stderr ?? err.message).split('\n').find((l) => l.includes('Error')) ?? err.message.slice(0, 200) };
  }
}

function all(...checks: Check[]): Check {
  const failed = checks.find((c) => !c.pass);
  return failed ?? { pass: true, detail: checks.map((c) => c.detail).join(' | ') };
}

function mentions(answer: string, needles: (string | RegExp)[]): Check {
  const missing = needles.filter((n) => (typeof n === 'string' ? !answer.includes(n) : !n.test(answer)));
  return missing.length ? { pass: false, detail: `answer is missing: ${missing.join(', ')}` } : { pass: true, detail: 'answer cites the expected evidence' };
}

function largeLegacyFile(): string {
  const lines: string[] = ['// Legacy helpers. Do not reformat: other teams diff this file by hand.', ''];
  for (let n = 1; n <= 560; n++) lines.push(`export function handler_${n}(x) {`, `  return x + ${n};`, '}');
  lines.push(
    '',
    'export function normalizePhone(raw) {',
    "  const digits = String(raw).replace(/-/g, '');",
    '  return digits.slice(-11);',
    '}',
    '',
  );
  for (let n = 561; n <= 1100; n++) lines.push(`export function handler_${n}(x) {`, `  return x + ${n};`, '}');
  return `${lines.join('\n')}\n`;
}

export const scenarios: Scenario[] = [
  {
    id: 'bug-two-causes',
    kind: 'bug',
    files: {
      'package.json': PKG,
      'src/cart.js': `export function total(items, discountPercent = 0) {
  let sum = 0;
  for (let i = 1; i < items.length; i++) sum += items[i].price * items[i].qty;
  return sum - sum * discountPercent;
}
`,
      'test.mjs': `import assert from 'node:assert/strict';
import { total } from './src/cart.js';
assert.equal(total([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25);
assert.equal(total([{ price: 100, qty: 1 }], 10), 90);
console.log('ok');
`,
    },
    task: 'Os testes do projeto estão falhando. Encontre a causa raiz e corrija.',
    check: (dir) =>
      runNode(
        dir,
        `import assert from 'node:assert/strict'; import { total } from './src/cart.js';
assert.equal(total([{ price: 3, qty: 3 }]), 9); assert.equal(total([{ price: 200, qty: 1 }, { price: 50, qty: 2 }], 25), 225);`,
      ),
  },
  {
    id: 'bug-shared-util',
    kind: 'bug',
    files: {
      'package.json': PKG,
      'src/money.js': `export function formatBRL(cents) {
  return 'R$ ' + (cents / 10).toFixed(2).replace('.', ',');
}
`,
      'src/invoice.js': `import { formatBRL } from './money.js';
export function invoiceLine(desc, cents) {
  return desc + ': ' + formatBRL(cents);
}
`,
      'src/receipt.js': `import { formatBRL } from './money.js';
export function receiptTotal(items) {
  return 'Total ' + formatBRL(items.reduce((s, i) => s + i.cents, 0));
}
`,
      'test.mjs': `import assert from 'node:assert/strict';
import { invoiceLine } from './src/invoice.js';
assert.equal(invoiceLine('Mensalidade', 12345), 'Mensalidade: R$ 123,45');
console.log('ok');
`,
    },
    task: 'A linha da fatura está mostrando o valor errado (o teste falha). Corrija.',
    check: (dir) =>
      runNode(
        dir,
        `import assert from 'node:assert/strict'; import { receiptTotal } from './src/receipt.js'; import { formatBRL } from './src/money.js';
assert.equal(formatBRL(500), 'R$ 5,00'); assert.equal(receiptTotal([{ cents: 1000 }, { cents: 250 }]), 'Total R$ 12,50');`,
      ),
  },
  {
    id: 'feature-coupon',
    kind: 'feature',
    files: {
      'package.json': PKG,
      'src/cart.js': `export function total(items, discountPercent = 0) {
  let sum = 0;
  for (const item of items) sum += item.price * item.qty;
  return sum - (sum * discountPercent) / 100;
}
`,
      'test.mjs': `import assert from 'node:assert/strict';
import { total } from './src/cart.js';
assert.equal(total([{ price: 10, qty: 2 }]), 20);
console.log('ok');
`,
    },
    task:
      "Adicione em src/cart.js uma função exportada applyCoupon(items, code) que devolve o total com desconto: 'DEZ' dá 10%, 'VINTE' dá 20%, e qualquer outro código lança um Error. Reaproveite total(). Inclua testes em test.mjs.",
    check: (dir) =>
      all(
        runNode(
          dir,
          `import assert from 'node:assert/strict'; import { applyCoupon } from './src/cart.js';
const items = [{ price: 50, qty: 2 }]; assert.equal(applyCoupon(items, 'DEZ'), 90); assert.equal(applyCoupon(items, 'VINTE'), 80);
assert.throws(() => applyCoupon(items, 'XYZ'));`,
        ),
        /applyCoupon/.test(fs.readFileSync(path.join(dir, 'test.mjs'), 'utf8'))
          ? { pass: true, detail: 'tests added' }
          : { pass: false, detail: 'test.mjs does not test applyCoupon' },
      ),
  },
  {
    id: 'edit-large-file',
    kind: 'edit',
    files: {
      'package.json': PKG,
      'src/legacy.js': largeLegacyFile(),
      'test.mjs': `import assert from 'node:assert/strict';
import { handler_1 } from './src/legacy.js';
assert.equal(handler_1(1), 2);
console.log('ok');
`,
    },
    task:
      "Em src/legacy.js, normalizePhone deveria remover tudo que não é dígito, mas hoje só remove hífens: normalizePhone('(21) 99876-5432') precisa dar '21998765432'. Corrija sem reformatar o resto do arquivo.",
    check: (dir) => {
      const lines = fs.readFileSync(path.join(dir, 'src/legacy.js'), 'utf8').split('\n').length;
      return all(
        runNode(
          dir,
          `import assert from 'node:assert/strict'; import * as m from './src/legacy.js';
assert.equal(m.normalizePhone('(21) 99876-5432'), '21998765432'); assert.equal(m.normalizePhone('+55 21 3333-4444'), '552133334444'.slice(-11));
assert.equal(m.handler_560(0), 560); assert.equal(m.handler_561(0), 561); assert.equal(m.handler_1100(1), 1101);`,
        ),
        Math.abs(lines - 3310) <= 6 ? { pass: true, detail: `line count ${lines}` } : { pass: false, detail: `file was reformatted or truncated: ${lines} lines` },
      );
    },
  },
  {
    id: 'refactor-rename',
    kind: 'refactor',
    files: {
      'package.json': PKG,
      'src/pricing.js': `export function calcTotal(items) {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
`,
      'src/checkout.js': `import { calcTotal } from './pricing.js';
export function checkout(cart) {
  return { amount: calcTotal(cart.items), currency: 'BRL' };
}
`,
      'src/report.js': `import { calcTotal } from './pricing.js';
export const dailyReport = (carts) => carts.map((c) => calcTotal(c.items));
`,
      'test.mjs': `import assert from 'node:assert/strict';
import { calcTotal } from './src/pricing.js';
import { checkout } from './src/checkout.js';
assert.equal(calcTotal([{ price: 2, qty: 3 }]), 6);
assert.equal(checkout({ items: [{ price: 1, qty: 1 }] }).amount, 1);
console.log('ok');
`,
    },
    task: 'Renomeie a função calcTotal para computeTotal em todo o projeto (definição, usos e testes) e garanta que os testes continuam passando.',
    check: (dir) => {
      const leftovers = ['src/pricing.js', 'src/checkout.js', 'src/report.js', 'test.mjs'].filter((f) =>
        fs.readFileSync(path.join(dir, f), 'utf8').includes('calcTotal'),
      );
      return all(
        leftovers.length ? { pass: false, detail: `calcTotal still in ${leftovers.join(', ')}` } : { pass: true, detail: 'no leftovers' },
        runNode(
          dir,
          `import assert from 'node:assert/strict'; import { computeTotal } from './src/pricing.js'; import { dailyReport } from './src/report.js';
assert.equal(computeTotal([{ price: 5, qty: 2 }]), 10); assert.deepEqual(dailyReport([{ items: [{ price: 1, qty: 4 }] }]), [4]);`,
        ),
      );
    },
  },
  {
    id: 'diff-regression',
    kind: 'diff',
    files: {
      'package.json': PKG,
      'src/shipping.js': `export function shippingCost(weightKg) {
  const base = 12.5;
  return Math.round((base + weightKg * 3.2) * 100) / 100;
}
`,
      'test.mjs': `import assert from 'node:assert/strict';
import { shippingCost } from './src/shipping.js';
assert.equal(shippingCost(1), 15.7);
assert.equal(shippingCost(2.5), 20.5);
console.log('ok');
`,
    },
    uncommitted: {
      'src/shipping.js': `export function shippingCost(weightKg, orderTotal = 0, freeShippingFrom = Infinity) {
  if (orderTotal >= freeShippingFrom) return 0;
  const base = 12.5;
  return Math.round(base + weightKg * 3.2 * 100) / 100;
}
`,
    },
    task:
      'Alguém alterou o código de frete (ainda sem commit) para adicionar frete grátis acima de um valor, e os testes quebraram. Veja exatamente o que mudou, explique a causa e corrija mantendo o frete grátis.',
    check: (dir, answer) =>
      all(
        runNode(
          dir,
          `import assert from 'node:assert/strict'; import { shippingCost } from './src/shipping.js';
assert.equal(shippingCost(1), 15.7); assert.equal(shippingCost(3, 300, 200), 0); assert.equal(shippingCost(3, 100, 200), 22.1);`,
        ),
        mentions(answer, [/Math\.round|arredond/i]),
      ),
  },
  {
    id: 'question-pt-over-en-code',
    kind: 'question',
    files: {
      'package.json': PKG,
      'src/shipping/cost.js': `const ZONE_RATES = { south: 1.0, north: 1.6 };

export function computeShippingCost(weightKg, zone) {
  const rate = ZONE_RATES[zone] ?? 1.3;
  return 10 + weightKg * 2.5 * rate;
}
`,
      'src/checkout.js': `import { computeShippingCost } from './shipping/cost.js';

export function checkoutSummary(cart, zone) {
  const subtotal = cart.items.reduce((s, i) => s + i.price, 0);
  const shipping = computeShippingCost(cart.weightKg, zone);
  return { subtotal, shipping, total: subtotal + shipping };
}
`,
      'src/quote.js': `import { computeShippingCost } from './shipping/cost.js';

export const quickQuote = (weightKg) => computeShippingCost(weightKg, 'south');
`,
      'src/tax.js': `export function computeTax(amount) {
  return amount * 0.08;
}
`,
    },
    task: 'Onde é calculado o valor do frete neste projeto, como o cálculo funciona e quem chama essa função?',
    check: (_dir, answer) => mentions(answer, ['cost.js', 'computeShippingCost', 'checkout.js', 'quote.js', /:\d+/, /zona|zone/i]),
  },
  {
    id: 'question-reuse',
    kind: 'question',
    files: {
      'package.json': PKG,
      'src/lib/validators.js': `const EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/;

export function isValidEmail(value) {
  return EMAIL_RE.test(String(value).trim());
}

export function isValidPhone(value) {
  return /^\\d{10,11}$/.test(String(value).replace(/\\D/g, ''));
}
`,
      'src/signup.js': `import { isValidEmail } from './lib/validators.js';

export function signup(form) {
  if (!isValidEmail(form.email)) throw new Error('Informe um e-mail válido, como nome@empresa.com');
  return { ok: true };
}
`,
      'src/newsletter.js': `export function subscribe(email) {
  if (!email.includes('@')) throw new Error('bad email');
  return { subscribed: email };
}
`,
    },
    task: 'Vou validar o e-mail na inscrição da newsletter. Já existe algo no projeto que eu deva reutilizar? Onde está e como uso?',
    check: (_dir, answer) => mentions(answer, ['validators.js', 'isValidEmail', 'newsletter', /import\s*\{\s*isValidEmail/]),
  },
  {
    id: 'question-negative',
    kind: 'question',
    files: {
      'package.json': PKG,
      'src/http.js': `export async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
`,
      'src/math/memo.js': `export function memoize(fn) {
  const seen = new Map();
  return (n) => (seen.has(n) ? seen.get(n) : (seen.set(n, fn(n)), seen.get(n)));
}
`,
      'src/users.js': `import { getJson } from './http.js';
export const loadUser = (id) => getJson('/api/users/' + id);
`,
    },
    task: 'As requisições HTTP deste projeto têm cache? Se tiver, onde fica configurado?',
    check: (_dir, answer) =>
      all(
        mentions(answer, ['http.js', /\bnão\b/i]),
        /\b(sim|possui|tem) cache\b/i.test(answer) && !/não (tem|possui|há)/i.test(answer)
          ? { pass: false, detail: 'answer claims an HTTP cache exists' }
          : { pass: true, detail: 'no false cache claim' },
      ),
  },
];

function crlfLegacy(): string {
  const lines: string[] = ['// Arquivo gerado no Windows: mantenha CRLF e tabs.', ''];
  for (let n = 1; n <= 60; n++) lines.push(`export function fee_${n}(v) {`, `\treturn v * ${n} / 100;`, '}', '');
  lines.push('export function parseAmount(text) {', "\tconst clean = String(text).replace('R$', '').trim();", '\treturn Number(clean);', '}', '');
  for (let n = 61; n <= 120; n++) lines.push(`export function fee_${n}(v) {`, `\treturn v * ${n} / 100;`, '}', '');
  return lines.join('\r\n');
}

function bigConfig(): string {
  const lines: string[] = ["export const MAX_RETRIES_HTTP = 3;", "export const MAX_RETRIES_DB = 3;", "export const TIMEOUT_MS = 5000;", ''];
  for (let n = 1; n <= 1300; n++) lines.push(`export const setting_${n} = { id: ${n}, retries: MAX_RETRIES_DB, timeout: TIMEOUT_MS };`, '', '');
  lines.push('export function httpPolicy() {', '  return { retries: MAX_RETRIES_HTTP, timeout: TIMEOUT_MS };', '}', '');
  return `${lines.join('\n')}`;
}

const LINE_ENDINGS_OK = (dir: string, file: string): Check => {
  const content = fs.readFileSync(path.join(dir, file), 'utf8');
  const lf = (content.match(/\n/g) ?? []).length;
  const crlf = (content.match(/\r\n/g) ?? []).length;
  return lf === crlf ? { pass: true, detail: 'CRLF preserved' } : { pass: false, detail: `mixed line endings: ${lf - crlf} bare LF` };
};

function onlyChanged(dir: string, allowed: string[]): Check {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  const changed = out.split('\n').filter(Boolean).map((l) => l.slice(3));
  const extra = changed.filter((f) => !allowed.includes(f));
  return extra.length ? { pass: false, detail: `out-of-scope changes: ${extra.join(', ')}` } : { pass: true, detail: 'scope respected' };
}

export const hardScenarios: Scenario[] = [
  {
    id: 'hard-crlf-tabs',
    kind: 'edit',
    files: {
      'package.json': PKG,
      'src/legacy.js': crlfLegacy(),
      'test.mjs': "import assert from 'node:assert/strict';\nimport { fee_1 } from './src/legacy.js';\nassert.equal(fee_1(100), 1);\nconsole.log('ok');\n",
    },
    task: "Em src/legacy.js, parseAmount('R$ 1.234,56') precisa devolver 1234.56 (formato brasileiro: ponto de milhar e vírgula decimal). Hoje devolve NaN. Corrija.",
    check: (dir) =>
      all(
        runNode(
          dir,
          `import assert from 'node:assert/strict'; import * as m from './src/legacy.js';
assert.equal(m.parseAmount('R$ 1.234,56'), 1234.56); assert.equal(m.parseAmount('R$ 10,00'), 10); assert.equal(m.parseAmount('7'), 7); assert.equal(m.fee_120(100), 120);`,
        ),
        LINE_ENDINGS_OK(dir, 'src/legacy.js'),
      ),
  },
  {
    id: 'hard-duplicate-blocks',
    kind: 'edit',
    files: {
      'package.json': PKG,
      'src/prices.js': `export function priceForStudents(base) {
  const value = base * 0.5;
  return Math.round(value * 100) / 100;
}

export function priceForSeniors(base) {
  const value = base * 0.5;
  return Math.round(value * 100) / 100;
}
`,
      'test.mjs': "import assert from 'node:assert/strict';\nimport { priceForStudents } from './src/prices.js';\nassert.equal(priceForStudents(10), 5);\nconsole.log('ok');\n",
    },
    task: 'A regra mudou só para idosos: agora pagam 40% do valor base (antes 50%). Ajuste apenas priceForSeniors.',
    check: (dir) =>
      runNode(
        dir,
        `import assert from 'node:assert/strict'; import { priceForStudents, priceForSeniors } from './src/prices.js';
assert.equal(priceForSeniors(100), 40); assert.equal(priceForStudents(100), 50);`,
      ),
  },
  {
    id: 'hard-multihop-bug',
    kind: 'bug',
    files: {
      'package.json': PKG,
      'src/units.js': 'export const toMinutes = (ms) => ms / 1000;\n',
      'src/stats.js': `import { toMinutes } from './units.js';
export function summarize(sessions) {
  const minutes = sessions.map((s) => toMinutes(s.durationMs));
  const total = minutes.reduce((a, b) => a + b, 0);
  return { total, average: Math.round((total / minutes.length) * 10) / 10 };
}
`,
      'src/report.js': `import { summarize } from './stats.js';
export function weeklyReport(sessions) {
  const { total, average } = summarize(sessions);
  return \`Total: \${total} min · média \${average} min\`;
}
`,
      'src/alerts.js': `import { toMinutes } from './units.js';
export const isTooLong = (session) => toMinutes(session.durationMs) > 90;
`,
      'test.mjs': `import assert from 'node:assert/strict';
import { weeklyReport } from './src/report.js';
assert.equal(weeklyReport([{ durationMs: 1_800_000 }, { durationMs: 3_600_000 }]), 'Total: 90 min · média 45 min');
console.log('ok');
`,
    },
    task: 'O relatório semanal mostra números absurdos e o teste falha. Descubra a causa e corrija.',
    check: (dir) =>
      runNode(
        dir,
        `import assert from 'node:assert/strict'; import { isTooLong } from './src/alerts.js'; import { toMinutes } from './src/units.js';
assert.equal(toMinutes(120000), 2); assert.equal(isTooLong({ durationMs: 100 * 60000 }), true); assert.equal(isTooLong({ durationMs: 60 * 60000 }), false);`,
      ),
  },
  {
    id: 'hard-python',
    kind: 'bug',
    files: {
      'inventory.py': `def needs_restock(items, threshold):
    """Return the names of items whose quantity is below the threshold."""
    return [item["name"] for item in items if item["qty"] > threshold]


def total_units(items):
    return sum(item["qty"] for item in items)
`,
      'test_inventory.py': `import unittest
from inventory import needs_restock


class TestRestock(unittest.TestCase):
    def test_low_stock(self):
        items = [{"name": "caneta", "qty": 2}, {"name": "papel", "qty": 50}]
        self.assertEqual(needs_restock(items, 10), ["caneta"])


if __name__ == "__main__":
    unittest.main()
`,
    },
    task: 'O teste de reposição de estoque (python3 -m unittest) está falhando. Corrija o código.',
    check: (dir) => {
      try {
        fs.rmSync(path.join(dir, '__pycache__'), { recursive: true, force: true });
        execFileSync(
          'python3',
          ['-B', '-c', 'from inventory import needs_restock, total_units\nassert needs_restock([{"name":"a","qty":5},{"name":"b","qty":5}], 5) == []\nassert needs_restock([{"name":"a","qty":0}], 1) == ["a"]\nassert total_units([{"qty":2},{"qty":3}]) == 5'],
          { cwd: dir, stdio: 'pipe' },
        );
        return { pass: true, detail: 'hidden python checks passed' };
      } catch (e) {
        return { pass: false, detail: String((e as { stderr?: Buffer }).stderr ?? e).slice(-200) };
      }
    },
  },
  {
    id: 'hard-follow-pattern',
    kind: 'feature',
    files: {
      'package.json': PKG,
      'src/commands/hello.js': "export const hello = (args) => `olá, ${args[0] ?? 'mundo'}`;\n",
      'src/commands/sum.js': 'export const sum = (args) => args.map(Number).reduce((a, b) => a + b, 0);\n',
      'src/commands/index.js': `import { hello } from './hello.js';
import { sum } from './sum.js';

export const commands = { hello, sum };

export function run(name, args = []) {
  const command = commands[name];
  if (!command) throw new Error(\`Comando desconhecido: \${name}\`);
  return command(args);
}
`,
      'test.mjs': "import assert from 'node:assert/strict';\nimport { run } from './src/commands/index.js';\nassert.equal(run('sum', ['2', '3']), 5);\nconsole.log('ok');\n",
    },
    task: "Adicione o comando 'upper', que devolve os argumentos juntos por espaço e em maiúsculas, seguindo exatamente o padrão dos comandos que já existem.",
    check: (dir) =>
      all(
        runNode(dir, `import assert from 'node:assert/strict'; import { run } from './src/commands/index.js'; assert.equal(run('upper', ['abc', 'de']), 'ABC DE');`),
        fs.existsSync(path.join(dir, 'src/commands/upper.js'))
          ? { pass: true, detail: 'own module like the others' }
          : { pass: false, detail: 'did not follow the one-file-per-command pattern' },
      ),
  },
  {
    id: 'hard-scope',
    kind: 'bug',
    files: {
      'package.json': PKG,
      'src/greeting.js': "export const greet = (name) => 'Ola, ' + name.trim + '!';\n",
      'src/legacy-utils.js': `// TODO: refatorar isto algum dia
export function pad(s,n){var r=s;while(r.length<n){r=' '+r}return r}
export function same(a,b){if(a==b){return true}else{return false}}
`,
      'test.mjs': "import assert from 'node:assert/strict';\nimport { greet } from './src/greeting.js';\nassert.equal(greet('  Ana '), 'Ola, Ana!');\nconsole.log('ok');\n",
    },
    task: 'O teste de saudação está falhando. Corrija o bug.',
    check: (dir) =>
      all(
        runNode(dir, `import assert from 'node:assert/strict'; import { greet } from './src/greeting.js'; assert.equal(greet('Bia'), 'Ola, Bia!');`),
        onlyChanged(dir, ['src/greeting.js', 'test.mjs']),
      ),
  },
  {
    id: 'hard-question-multihop',
    kind: 'question',
    files: {
      'package.json': PKG,
      'src/routes/orders.js': `import { orderService } from '../services/orderService.js';
export function registerOrderRoutes(app) {
  app.post('/orders/:id/cancel', (req) => orderService.cancel(req.params.id, req.user));
  app.get('/orders/:id', (req) => orderService.find(req.params.id));
}
`,
      'src/services/orderService.js': `import { orderRepo } from '../repo/orderRepo.js';
export const orderService = {
  async cancel(id, user) {
    const order = await orderRepo.findById(id);
    if (order.ownerId !== user.id) throw new Error('Pedido de outro usuário');
    return orderRepo.updateStatus(id, 'CANCELED_BY_USER');
  },
  find: (id) => orderRepo.findById(id),
};
`,
      'src/repo/orderRepo.js': `import { db } from '../db.js';
export const orderRepo = {
  findById: (id) => db.one('SELECT * FROM orders_v2 WHERE id = $1', [id]),
  updateStatus: (id, status) => db.none('UPDATE orders_v2 SET status = $2, updated_at = now() WHERE id = $1', [id, status]),
};
`,
      'src/services/refundService.js': `import { db } from '../db.js';
export const refundService = {
  cancelRefund: (id) => db.none("UPDATE refunds SET status = 'CANCELLED' WHERE id = $1", [id]),
};
`,
      'src/db.js': 'export const db = { one: async () => ({}), none: async () => undefined };\n',
    },
    task: 'Quando o cliente cancela um pedido pela API, qual tabela é atualizada, qual status é gravado e existe alguma verificação antes?',
    check: (_dir, answer) => mentions(answer, ['orders_v2', 'CANCELED_BY_USER', 'orderService', /ownerId|dono|outro usuário/i]),
  },
  {
    id: 'hard-two-far-edits',
    kind: 'edit',
    files: {
      'package.json': PKG,
      'src/config.js': bigConfig(),
      'test.mjs': "import assert from 'node:assert/strict';\nimport { httpPolicy } from './src/config.js';\nassert.equal(httpPolicy().timeout, 5000);\nconsole.log('ok');\n",
    },
    task:
      'Em src/config.js, renomeie a constante MAX_RETRIES_HTTP para HTTP_MAX_RETRIES (definição e uso) e mude o valor dela para 5. Não altere MAX_RETRIES_DB nem nada mais.',
    check: (dir) => {
      const content = fs.readFileSync(path.join(dir, 'src/config.js'), 'utf8');
      return all(
        runNode(
          dir,
          `import assert from 'node:assert/strict'; import * as c from './src/config.js';
assert.equal(c.HTTP_MAX_RETRIES, 5); assert.equal(c.httpPolicy().retries, 5); assert.equal(c.MAX_RETRIES_DB, 3); assert.equal(c.setting_1300.retries, 3); assert.equal(c.MAX_RETRIES_HTTP, undefined);`,
        ),
        content.split('\n').length === bigConfig().split('\n').length ? { pass: true, detail: 'no other lines touched' } : { pass: false, detail: 'line count changed' },
      );
    },
  },
];

function menuApp(): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': PKG,
    'src/api/client.js': "export const api = { get: async (url) => { throw new Error('offline: ' + url); } };\n",
    'src/auth.js': 'export const canView = (user, screen) => user.screens.includes(screen);\n',
    'src/store/notes.js': `const notes = [];
let nextId = 1;

export const notesStore = {
  add(note) {
    const saved = { id: nextId++, createdAt: new Date().toISOString(), ...note };
    notes.push(saved);
    return saved;
  },
  list: () => [...notes],
  clear: () => notes.splice(0, notes.length),
};
`,
    'src/pages/notes.js': `import { notesStore } from '../store/notes.js';

export const notesPage = () => ({
  title: 'Anotações',
  items: notesStore.list(),
  submit: (form) => notesStore.add({ text: form.text }),
});
`,
    'src/menu.js': `export const menu = [
  {
    group: 'Cadastros',
    items: [
      { label: 'Veículos', to: '/veiculos', screen: 'vehicles' },
      { label: 'Motoristas', to: '/motoristas', screen: 'drivers' },
    ],
  },
  {
    group: 'Rotas e operação',
    items: [
      { label: 'Linhas', to: '/linhas', screen: 'lines' },
      { label: 'Rotas', to: '/rotas', screen: 'routes' },
      { label: 'Grades', to: '/grades', screen: 'schedules' },
    ],
  },
  {
    group: 'Ferramentas',
    items: [{ label: 'Anotações', to: '/anotacoes', screen: 'notes' }],
  },
];
`,
    'backend/permissions/screens.js': `export const SCREENS = [
  { key: 'vehicles', label: 'Veículos' },
  { key: 'drivers', label: 'Motoristas' },
  { key: 'lines', label: 'Linhas' },
  { key: 'routes', label: 'Rotas' },
  { key: 'schedules', label: 'Grades' },
  { key: 'notes', label: 'Anotações' },
];
`,
    'db/migrations/001_screens.sql': "INSERT INTO screens (key, label) VALUES ('vehicles','Veículos'),('drivers','Motoristas'),('lines','Linhas'),('routes','Rotas'),('schedules','Grades'),('notes','Anotações');\n",
    'test.mjs': `import assert from 'node:assert/strict';
import { render } from './src/routes.js';
const admin = { screens: ['vehicles', 'drivers', 'lines', 'routes', 'schedules', 'notes'] };
assert.equal(render('/linhas', admin).title, 'Linhas');
assert.throws(() => render('/linhas', { screens: [] }), /403/);
console.log('ok');
`,
  };
  const pages: [string, string, string, string][] = [
    ['vehicles', 'vehiclesPage', 'Veículos', '/veiculos'],
    ['drivers', 'driversPage', 'Motoristas', '/motoristas'],
    ['lines', 'linesPage', 'Linhas', '/linhas'],
    ['routes', 'routesPage', 'Rotas', '/rotas'],
    ['schedules', 'schedulesPage', 'Grades', '/grades'],
  ];
  for (const [screen, fn, title] of pages) {
    files[`src/pages/${screen}.js`] = `import { api } from '../api/client.js';

export const ${fn} = () => ({
  title: '${title}',
  load: () => api.get('/${screen}'),
});
`;
  }
  files['src/routes.js'] = `${pages.map(([screen, fn]) => `import { ${fn} } from './pages/${screen}.js';`).join('\n')}
import { notesPage } from './pages/notes.js';
import { canView } from './auth.js';

export const routes = [
${pages.map(([screen, fn, , to]) => `  { path: '${to}', page: ${fn}, screen: '${screen}' },`).join('\n')}
  { path: '/anotacoes', page: notesPage, screen: 'notes' },
];

export function render(path, user) {
  const route = routes.find((r) => r.path === path);
  if (!route) throw new Error('404 ' + path);
  if (!canView(user, route.screen)) throw new Error('403 ' + path);
  return route.page();
}
`;
  for (let n = 1; n <= 40; n++) {
    files[`src/components/widget${n}.js`] = `export function widget${n}(props) {\n  return { kind: 'widget${n}', ...props };\n}\n`;
  }
  return files;
}

function fullstackApp(): Record<string, string> {
  const resource = (name: string, fields: string[]) => `import { db } from '../db/index.js';

const FIELDS = [${fields.map((f) => `'${f}'`).join(', ')}];

export function create${name}(body) {
  const row = Object.fromEntries(FIELDS.map((f) => [f, body[f] ?? null]));
  if (!row.${fields[0]}) throw new Error('400 ${fields[0]} is required');
  return db.insert('${name.toLowerCase()}s', row);
}

export const list${name}s = () => db.all('${name.toLowerCase()}s').map(({ id, ${fields.join(', ')} }) => ({ id, ${fields.join(', ')} }));
`;
  const page = (title: string, url: string, fields: [string, string][]) => `import { http } from '../http.js';

export const ${url.slice(1)}Page = {
  title: '${title}',
  fields: [
${fields.map(([name, label]) => `    { name: '${name}', label: '${label}' },`).join('\n')}
  ],
  columns: [${fields.map(([, label]) => `'${label}'`).join(', ')}],
  load: () => http.get('${url}'),
  submit: (form) => http.post('${url}', { ${fields.map(([name]) => `${name}: form.${name}`).join(', ')} }),
};
`;
  return {
    'package.json': PKG,
    'web/http.js': `import { handle } from '../api/server.js';

export const http = {
  get: (url) => handle('GET', url),
  post: (url, body) => handle('POST', url, body),
};
`,
    'web/pages/drivers.js': page('Motoristas', '/drivers', [['name', 'Nome'], ['cnh', 'CNH']]),
    'web/pages/vehicles.js': page('Veículos', '/vehicles', [['plate', 'Placa'], ['model', 'Modelo']]),
    'api/server.js': `import { createDriver, listDrivers } from './drivers.js';
import { createVehicle, listVehicles } from './vehicles.js';

const routes = {
  'GET /drivers': () => listDrivers(),
  'POST /drivers': (body) => createDriver(body),
  'GET /vehicles': () => listVehicles(),
  'POST /vehicles': (body) => createVehicle(body),
};

export async function handle(method, url, body) {
  const route = routes[\`\${method} \${url}\`];
  if (!route) throw new Error(\`404 \${method} \${url}\`);
  return route(body);
}
`,
    'api/drivers.js': resource('Driver', ['name', 'cnh']),
    'api/vehicles.js': resource('Vehicle', ['plate', 'model']),
    'db/schema.js': `export const schema = {
  drivers: ['id', 'name', 'cnh'],
  vehicles: ['id', 'plate', 'model'],
};
`,
    'db/index.js': `import { schema } from './schema.js';

const tables = Object.fromEntries(Object.keys(schema).map((t) => [t, []]));
let nextId = 1;

export const db = {
  insert(table, row) {
    for (const column of Object.keys(row)) {
      if (!schema[table].includes(column)) throw new Error(\`column "\${column}" of relation "\${table}" does not exist\`);
    }
    const saved = { id: nextId++, ...row };
    tables[table].push(saved);
    return saved;
  },
  all: (table) => [...tables[table]],
};
`,
    'db/migrations/001_drivers.sql': 'CREATE TABLE drivers (id serial PRIMARY KEY, name text NOT NULL, cnh text);\n',
    'db/migrations/002_vehicles.sql': 'CREATE TABLE vehicles (id serial PRIMARY KEY, plate text NOT NULL, model text);\n',
    'db/AGENTS.md': 'Migrations in db/migrations/ are already applied in production: never edit one. Every schema change goes in a new numbered migration file, and db/schema.js must mirror the migrations.\n',
    'test.mjs': `import assert from 'node:assert/strict';
import { driversPage } from './web/pages/drivers.js';
const saved = await driversPage.submit({ name: 'Ana', cnh: '123' });
assert.equal(saved.name, 'Ana');
assert.equal((await driversPage.load()).length, 1);
console.log('ok');
`,
  };
}

export const realScenarios: Scenario[] = [
  {
    id: 'real-menu-memory',
    kind: 'feature',
    files: menuApp(),
    task: 'Consegue pesquisar neste projeto o menu Rotas e operação. Adicione um novo menu de Viagens que registre viagens, todas as informações ficam em memória.',
    check: (dir) => {
      const changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3));
      const outOfScope = changed.filter((f) => f.startsWith('backend/') || f.startsWith('db/'));
      const logic = changed.filter((f) => f.startsWith('src/') && !['src/menu.js', 'src/routes.js'].includes(f) && f.endsWith('.js'));
      const contents = logic.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
      const usesApi = contents.some((c) => /api\/client|fetch\(|api\.(get|post)/.test(c));
      const inMemory = contents.some((c) => /\.push\(|new Map\(|\.set\(/.test(c));
      return all(
        runNode(
          dir,
          `import assert from 'node:assert/strict'; import { menu } from './src/menu.js'; import { render } from './src/routes.js';
const item = menu.flatMap((g) => g.items).find((i) => /viage/i.test(i.label));
assert.ok(item, 'menu item Viagens missing');
const screens = menu.flatMap((g) => g.items.map((i) => i.screen)); const page = render(item.to, { screens });
assert.ok(page && typeof page === 'object', 'route does not render a page');
assert.equal(render('/linhas', { screens }).title, 'Linhas');`,
        ),
        outOfScope.length ? { pass: false, detail: `scope creep into ${outOfScope.join(', ')}` } : { pass: true, detail: 'no backend/db changes' },
        !logic.length ? { pass: false, detail: 'no page/store file for trips' } : { pass: true, detail: `${logic.length} new src files` },
        usesApi ? { pass: false, detail: 'trips code calls the API instead of memory' } : { pass: true, detail: 'no API calls' },
        inMemory ? { pass: true, detail: 'in-memory store' } : { pass: false, detail: 'no in-memory storage found' },
      );
    },
  },
  {
    id: 'real-fullstack-field',
    kind: 'feature',
    files: fullstackApp(),
    task: 'Na tela de Motoristas, adicione o campo Telefone. Ele precisa ser salvo junto com o cadastro e aparecer na listagem.',
    check: (dir) => {
      const changed = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3));
      const unrelated = changed.filter((f) => /vehicle/.test(f) || f === 'db/migrations/001_drivers.sql');
      const migration = changed
        .filter((f) => f.startsWith('db/migrations/') && f !== 'db/migrations/001_drivers.sql')
        .some((f) => /alter\s+table\s+drivers/i.test(fs.readFileSync(path.join(dir, f), 'utf8')));
      return all(
        runNode(
          dir,
          `import assert from 'node:assert/strict'; import { driversPage } from './web/pages/drivers.js';
const field = driversPage.fields.find((f) => /telefone/i.test(f.label));
assert.ok(field, 'field Telefone missing from the screen');
assert.ok(driversPage.columns.some((c) => /telefone/i.test(c)), 'Telefone missing from the listing columns');
await driversPage.submit({ name: 'Bia', cnh: '9', [field.name]: '21999990000' });
const rows = await driversPage.load();
assert.ok(JSON.stringify(rows).includes('21999990000'), 'phone was not saved or is not listed');`,
        ),
        unrelated.length ? { pass: false, detail: `touched unrelated or applied files: ${unrelated.join(', ')}` } : { pass: true, detail: 'vehicles and 001 untouched' },
        migration ? { pass: true, detail: 'new migration alters drivers' } : { pass: false, detail: 'no new migration with ALTER TABLE drivers' },
      );
    },
  },
];
