import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { all, PKG, runNode, TSC, type Check, type Scenario } from './scenarios.js';

const RULES = `# Regras do projeto
- Sem comentários no código (nem em SQL): o porquê vai no commit.
- Nomes novos (arquivo, função, variável, campo) em inglês; textos de tela em pt-BR, exatamente como o pedido escreve.
- Toda função de dados recebe operatorId e filtra por ele.
- Invariantes que precisam valer sob concorrência ficam no banco (CHECK), não só num if.
- Migration nova em db/init com o próximo número; nunca edite uma migration existente.
`;

const REASONS = ['rosto_ausente', 'multiplos_rostos', 'rosto_cortado', 'rosto_pequeno', 'olhos_fechados', 'desfocada', 'rosto_virado', 'pouca_luz', 'possivel_foto_de_documento', 'captura_sem_analise'];
const LABELS: Record<string, string> = {
  rosto_ausente: 'Rosto não encontrado',
  multiplos_rostos: 'Mais de um rosto',
  rosto_cortado: 'Rosto cortado',
  rosto_pequeno: 'Rosto pequeno',
  olhos_fechados: 'Olhos fechados',
  desfocada: 'Foto desfocada',
  rosto_virado: 'Rosto virado',
  pouca_luz: 'Pouca luz',
  possivel_foto_de_documento: 'Possível foto de documento',
  captura_sem_analise: 'Enviada sem análise do aparelho',
};
const PENDING_MESSAGE = 'Foto pendente de revisão. Revise a foto antes de baixar ou exportar.';

function addedLines(dir: string): string[] {
  const diff = execFileSync('git', ['diff', '-U0'], { cwd: dir, encoding: 'utf8' });
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(js|mjs|ts|sql)$/.test(f));
  for (const f of untracked) added.push(...fs.readFileSync(path.join(dir, f), 'utf8').split('\n'));
  return added;
}

function noNewComments(dir: string): Check {
  const bad = addedLines(dir).filter((l) => /^\s*(\/\/|\/\*|\*\s|\*\/|--\s)/.test(l) || /\s\/\/\s/.test(l));
  return bad.length ? { pass: false, detail: `new comments despite AGENTS.md: ${bad[0]!.trim().slice(0, 80)}` } : { pass: true, detail: 'no new comments' };
}

function typecheck(dir: string): Check {
  try {
    execFileSync('node', [TSC, '--noEmit', '-p', '.'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    return { pass: true, detail: 'type check passes' };
  } catch (e) {
    return { pass: false, detail: `type check fails: ${String((e as { stdout?: string }).stdout ?? e).split('\n')[0]}` };
  }
}

function captureFiles(): Record<string, string> {
  return {
    'src/camera/guidance.js': `export const TIPS = ['Centralize o rosto', 'Ambiente iluminado e fundo claro', 'Sem boné, óculos escuros ou máscara'];

export function tipsFor() {
  return TIPS;
}
`,
    'src/camera/preview.js': `export function previewStyle(facing) {
  return { objectFit: 'cover', transform: facing === 'user' ? 'scaleX(-1)' : 'none' };
}

export function captureCanvas(video, canvas, facing) {
  const ctx = canvas.getContext('2d');
  if (facing === 'user') {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}
`,
    'src/camera/screen.js': `import { tipsFor } from './guidance.js';
import { previewStyle } from './preview.js';

export function cameraScreen(facing) {
  return { fullscreen: true, frame: { shape: 'oval', ratio: '3:4' }, preview: previewStyle(facing), tips: tipsFor() };
}
`,
  };
}

const CAPTURE_TASK = `Na câmera do app do aluno (src/camera):
- Troque as dicas fixas pela orientação ao vivo. Exporte createGuidance() em src/camera/guidance.js: devolve uma função next(checks, nowMs) com estado próprio, chamada a cada quadro com nowMs crescente. checks = { faces, insideFrame, bigEnough, eyesOpen, frontal, level, sharp, bright } (faces é número, o resto booleano).
- Uma orientação por vez, a mais importante primeiro, com estes textos: faces diferente de 1 ou fora da moldura → "Mostre o rosto inteiro dentro da moldura"; rosto pequeno → "Aproxime-se da câmera"; olhos fechados → "Mantenha os olhos abertos"; cabeça virada → "Olhe de frente para a câmera"; cabeça torta → "Deixe a cabeça reta"; imagem tremida → "Segure o celular parado"; pouca luz → "Procure um lugar mais iluminado".
- Com tudo atendido, a mensagem é "Tudo certo. Pode tirar a foto".
- Cada mensagem fica pelo menos 1500 ms na tela antes de trocar, para não piscar.
- As dicas fixas ("Centralize o rosto", "Ambiente iluminado e fundo claro", "Sem boné…") saem: remova TIPS, tipsFor e o campo tips da tela.
- A prévia e a foto tirada não são espelhadas, nem na câmera frontal.`;

const CAPTURE_CHECK = String.raw`import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as g from './src/camera/guidance.js';
import { previewStyle, captureCanvas } from './src/camera/preview.js';
import { cameraScreen } from './src/camera/screen.js';
const ok = { faces: 1, insideFrame: true, bigEnough: true, eyesOpen: true, frontal: true, level: true, sharp: true, bright: true };
assert.equal(typeof g.createGuidance, 'function', 'createGuidance() must be exported');
const cases = [
  [{ faces: 0 }, 'Mostre o rosto inteiro dentro da moldura'],
  [{ faces: 2 }, 'Mostre o rosto inteiro dentro da moldura'],
  [{ insideFrame: false }, 'Mostre o rosto inteiro dentro da moldura'],
  [{ bigEnough: false, eyesOpen: false }, 'Aproxime-se da câmera'],
  [{ eyesOpen: false, frontal: false }, 'Mantenha os olhos abertos'],
  [{ frontal: false, level: false }, 'Olhe de frente para a câmera'],
  [{ level: false, sharp: false }, 'Deixe a cabeça reta'],
  [{ sharp: false, bright: false }, 'Segure o celular parado'],
  [{ bright: false }, 'Procure um lugar mais iluminado'],
  [{}, 'Tudo certo. Pode tirar a foto'],
];
for (const [patch, want] of cases) assert.equal(g.createGuidance()({ ...ok, ...patch }, 0), want, 'priority for ' + JSON.stringify(patch));
const next = g.createGuidance();
assert.equal(next({ ...ok, faces: 0 }, 0), 'Mostre o rosto inteiro dentro da moldura');
assert.equal(next({ ...ok, bigEnough: false }, 1000), 'Mostre o rosto inteiro dentro da moldura', 'each message stays at least 1500 ms');
assert.equal(next({ ...ok, bigEnough: false }, 1600), 'Aproxime-se da câmera');
assert.equal(next(ok, 2000), 'Aproxime-se da câmera', 'each message stays at least 1500 ms');
assert.equal(next(ok, 3200), 'Tudo certo. Pode tirar a foto');
assert.equal(g.createGuidance()(ok, 0), 'Tudo certo. Pode tirar a foto', 'each createGuidance() has its own state');
assert.ok(!('TIPS' in g) && !('tipsFor' in g), 'fixed tips must be removed');
assert.ok(!('tips' in cameraScreen('user')), 'camera screen must not show fixed tips');
const src = fs.readdirSync('src/camera').map((f) => fs.readFileSync('src/camera/' + f, 'utf8')).join('\n');
assert.ok(!/Centralize o rosto|Sem boné/.test(src), 'fixed tips text must be gone');
for (const facing of ['user', 'environment']) assert.ok(!/scaleX\(-1\)|scale\(-1/.test(JSON.stringify(previewStyle(facing))), 'preview must not be mirrored');
const calls = [];
const ctx = new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) });
captureCanvas({}, { width: 1200, height: 1600, getContext: () => ctx }, 'user');
assert.ok(!calls.some(([k, x]) => (k === 'scale' && x === -1) || k === 'setTransform'), 'captured photo must not be mirrored');
assert.deepEqual(cameraScreen('user').frame, { shape: 'oval', ratio: '3:4' });`;

function statusFiles(): Record<string, string> {
  return {
    'db/init/010-students.sql': `CREATE TABLE students (
  id BIGSERIAL PRIMARY KEY,
  operator_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  photo_key VARCHAR(255),
  photo_updated_at TIMESTAMPTZ,
  CONSTRAINT students_photo_completa CHECK ((photo_key IS NULL) = (photo_updated_at IS NULL))
);
`,
    'db/init/020-guardians.sql': `CREATE TABLE guardians (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id),
  name VARCHAR(120) NOT NULL
);
`,
    'src/photo/thresholds.js': `export const THRESHOLDS = { minFaceRatio: 0.35, maxYawDeg: 20, minBrightness: 110, minSharpness: 7 };
`,
    'src/photo/analyze.js': `export function analyze() {
  return { deviceAnalyzed: true, faces: 1, cropped: false, faceRatio: 0.5, eyesOpen: true, yawDeg: 0, brightness: 150, sharpness: 20, document: false };
}
`,
  };
}

const STATUS_TASK = `Toda foto do aluno recebe um status: aprovada_automaticamente ou pendente_revisao. Foto pendente guarda o motivo, um código por checagem: ${REASONS.join(', ')}.
- Crie a migration que acrescenta photo_status e photo_pending_reason em students, com CHECK no banco: status só com esses 2 valores; motivo obrigatório quando pendente e proibido quando aprovada; motivos fechados nessa lista. A nova coluna precisa ser coerente com students_photo_completa: sem foto, sem status.
- Implemente classifyPhoto(analysis) em src/photo/classify.js, devolvendo { status, reason } (reason null quando aprovada). analysis = { deviceAnalyzed, faces, cropped, faceRatio, eyesOpen, yawDeg, brightness, sharpness, document }. O primeiro motivo que falhar, nesta ordem: análise do aparelho ausente → captura_sem_analise; nenhum rosto → rosto_ausente; mais de um → multiplos_rostos; cortado → rosto_cortado; rosto pequeno → rosto_pequeno; olhos fechados → olhos_fechados; virado (|yawDeg| acima do limite) → rosto_virado; escura → pouca_luz; desfocada → desfocada; documento → possivel_foto_de_documento. Use os limites de src/photo/thresholds.js.`;

const STATUS_CHECK = String.raw`import assert from 'node:assert/strict';
import { classifyPhoto } from './src/photo/classify.js';
const good = { deviceAnalyzed: true, faces: 1, cropped: false, faceRatio: 0.5, eyesOpen: true, yawDeg: 5, brightness: 150, sharpness: 20, document: false };
assert.deepEqual(classifyPhoto(good), { status: 'aprovada_automaticamente', reason: null });
const cases = [
  [{ deviceAnalyzed: false, faces: 0 }, 'captura_sem_analise'],
  [{ faces: 0, eyesOpen: false }, 'rosto_ausente'],
  [{ faces: 3 }, 'multiplos_rostos'],
  [{ cropped: true, faceRatio: 0.1 }, 'rosto_cortado'],
  [{ faceRatio: 0.3, eyesOpen: false }, 'rosto_pequeno'],
  [{ eyesOpen: false, yawDeg: 40 }, 'olhos_fechados'],
  [{ yawDeg: -25, brightness: 50 }, 'rosto_virado'],
  [{ brightness: 100, sharpness: 1 }, 'pouca_luz'],
  [{ sharpness: 5, document: true }, 'desfocada'],
  [{ document: true }, 'possivel_foto_de_documento'],
];
for (const [patch, reason] of cases) assert.deepEqual(classifyPhoto({ ...good, ...patch }), { status: 'pendente_revisao', reason }, JSON.stringify(patch));
assert.deepEqual(classifyPhoto({ ...good, yawDeg: 20, faceRatio: 0.35, brightness: 110, sharpness: 7 }), { status: 'aprovada_automaticamente', reason: null }, 'limits are inclusive');`;

function statusSql(dir: string): Check {
  const initDir = path.join(dir, 'db/init');
  const added = fs.readdirSync(initDir).filter((f) => !['010-students.sql', '020-guardians.sql'].includes(f));
  const original = fs.readFileSync(path.join(initDir, '010-students.sql'), 'utf8');
  if (!original.includes('CONSTRAINT students_photo_completa') || /photo_status/.test(original)) return { pass: false, detail: 'existing migration 010 was edited' };
  const sql = added.map((f) => fs.readFileSync(path.join(initDir, f), 'utf8')).join('\n');
  if (!added.length || !added.every((f) => Number(f.slice(0, 3)) > 20)) return { pass: false, detail: `new migration must come after 020: ${added.join(', ') || 'none'}` };
  const missing = ['photo_status', 'photo_pending_reason', 'aprovada_automaticamente', 'pendente_revisao', ...REASONS].filter((t) => !sql.includes(t));
  if (missing.length) return { pass: false, detail: `migration misses: ${missing.join(', ')}` };
  if (!/CHECK/i.test(sql) || !/photo_pending_reason\s+IS\s+(NOT\s+)?NULL/i.test(sql)) return { pass: false, detail: 'migration must CHECK when the reason is required/forbidden' };
  if (!/photo_key\s+IS\s+(NOT\s+)?NULL|photo_status\s+IS\s+NULL/i.test(sql)) return { pass: false, detail: 'status must be coherent with the photo (no photo, no status)' };
  return { pass: true, detail: 'migration with closed CHECKs' };
}

function reviewFiles(): Record<string, string> {
  return {
    'src/db.js': `export const students = [];

export function reset(rows) {
  students.splice(0, students.length, ...rows.map((r) => ({ ...r })));
}
`,
    'src/audit.js': `const entries = [];

export function record(entry) {
  entries.push({ ...entry, at: Date.now() });
}

export function list() {
  return entries;
}

export function clear() {
  entries.length = 0;
}
`,
    'src/storage.js': `const objects = new Map();
let next = 1;

export function put(prefix, buffer) {
  const key = prefix + '/' + next++ + '.jpg';
  objects.set(key, buffer);
  return key;
}

export function get(key) {
  return objects.get(key);
}

export function remove(key) {
  objects.delete(key);
}

export function keys() {
  return [...objects.keys()];
}
`,
    'src/photo/frame.js': `export function crop(original, area) {
  return Buffer.from('crop:' + original.toString() + ':' + area.x + ',' + area.y + ',' + area.size);
}
`,
  };
}

const REVIEW_TASK = `Revisão da foto pelo operador, em src/review/service.js (dados em src/db.js; aluno = { id, operatorId, name, photoKey, originalKey, photoStatus, pendingReason }):
- listPending(operatorId): alunos do operador com foto pendente, como [{ id, name, reasonLabel }]. A API devolve o rótulo pronto, não o código: ${Object.entries(LABELS).map(([k, v]) => `${k} = "${v}"`).join('; ')}.
- approve(operatorId, studentId, userId): a foto passa a aprovada_automaticamente, sem motivo.
- adjust(operatorId, studentId, area, userId): gera de novo a foto final a partir do original (crop de src/photo/frame.js sobre o original do storage), grava em storage.put('fotos_processadas', ...) e aponta photoKey para ela. Ajustar não aprova: continua pendente, com o mesmo motivo. A foto final anterior não é apagada nesta operação.
- reject(operatorId, studentId, userId): remove a foto do aluno (photoKey, originalKey, status e motivo ficam null), para ele enviar outra.
- Toda ação grava em audit.record({ action, operatorId, studentId, userId }) com action = 'approve' | 'adjust' | 'reject'.
- Aluno de outro operador, ou inexistente: lance Error('Aluno não encontrado.') sem alterar nada.`;

const REVIEW_CHECK = String.raw`import assert from 'node:assert/strict';
import { reset, students } from './src/db.js';
import * as audit from './src/audit.js';
import * as storage from './src/storage.js';
import * as review from './src/review/service.js';
const orig = storage.put('originais', Buffer.from('ORIG'));
const final = storage.put('fotos_processadas', Buffer.from('FINAL'));
reset([
  { id: 1, operatorId: 10, name: 'Ana', photoKey: final, originalKey: orig, photoStatus: 'pendente_revisao', pendingReason: 'olhos_fechados' },
  { id: 2, operatorId: 10, name: 'Bia', photoKey: 'x', originalKey: 'y', photoStatus: 'aprovada_automaticamente', pendingReason: null },
  { id: 3, operatorId: 20, name: 'Caio', photoKey: 'z', originalKey: 'w', photoStatus: 'pendente_revisao', pendingReason: 'rosto_ausente' },
  { id: 4, operatorId: 10, name: 'Duda', photoKey: 'k', originalKey: 'j', photoStatus: 'pendente_revisao', pendingReason: 'multiplos_rostos' },
]);
audit.clear();
assert.deepEqual(review.listPending(10).map((r) => [r.id, r.name, r.reasonLabel]).sort(), [[1, 'Ana', 'Olhos fechados'], [4, 'Duda', 'Mais de um rosto']]);
assert.throws(() => review.approve(10, 3, 99), /Aluno não encontrado\./);
assert.equal(students.find((s) => s.id === 3).photoStatus, 'pendente_revisao', 'other operator must stay untouched');
await review.adjust(10, 1, { x: 5, y: 6, size: 400 }, 99);
const ana = students.find((s) => s.id === 1);
assert.notEqual(ana.photoKey, final, 'adjust must point photoKey to a new final');
assert.match(ana.photoKey, /^fotos_processadas\//);
assert.equal(String(storage.get(ana.photoKey)), 'crop:ORIG:5,6,400', 'new final comes from the original, not from the old final');
assert.equal(ana.photoStatus, 'pendente_revisao', 'adjust does not approve');
assert.equal(ana.pendingReason, 'olhos_fechados', 'adjust keeps the reason');
assert.ok(storage.keys().includes(final), 'previous final is not deleted in the same operation');
await review.approve(10, 1, 99);
assert.equal(ana.photoStatus, 'aprovada_automaticamente');
assert.equal(ana.pendingReason, null);
await review.reject(10, 4, 99);
const duda = students.find((s) => s.id === 4);
assert.deepEqual([duda.photoKey, duda.originalKey, duda.photoStatus, duda.pendingReason], [null, null, null, null]);
assert.deepEqual(audit.list().map((e) => [e.action, e.operatorId, e.studentId, e.userId]), [['adjust', 10, 1, 99], ['approve', 10, 1, 99], ['reject', 10, 4, 99]]);
assert.deepEqual(review.listPending(10), []);`;

function exportFiles(): Record<string, string> {
  return {
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "noUnusedLocals": true, "noEmit": true, "target": "es2022", "module": "nodenext", "allowImportingTsExtensions": true, "verbatimModuleSyntax": true }, "include": ["src/**/*.ts"] }\n',
    'src/types.ts': `export type PhotoStatus = 'aprovada_automaticamente' | 'pendente_revisao';

export interface Student {
  id: number;
  name: string;
  hasPhoto: boolean;
  photoStatus: PhotoStatus | null;
}
`,
    'src/export/photos.ts': `import type { Student } from '../types.ts';

export function exportablePhotos(students: Student[]): Student[] {
  return students.filter((s) => s.hasPhoto);
}
`,
    'src/screens/students-list.ts': `import type { Student } from '../types.ts';

export function selectable(student: Student): boolean {
  return student.hasPhoto;
}
`,
    'src/screens/student-view.ts': `import type { Student } from '../types.ts';

export function downloadButton(student: Student): { disabled: boolean; title: string } {
  return { disabled: !student.hasPhoto, title: student.hasPhoto ? 'Baixar foto' : 'Aluno sem foto' };
}
`,
  };
}

const EXPORT_TASK = `Fotos pendentes de revisão não são exportadas até serem revisadas.
- Na listagem, ficam fora da seleção (selectable) e do download em lote (exportablePhotos).
- Na ficha do aluno, o botão de baixar a foto fica bloqueado com o aviso exato "${PENDING_MESSAGE}".
- O npm run check (tsc) precisa continuar passando.`;

const EXPORT_CHECK = String.raw`import assert from 'node:assert/strict';
import { exportablePhotos } from './src/export/photos.ts';
import { selectable } from './src/screens/students-list.ts';
import { downloadButton } from './src/screens/student-view.ts';
const ok = { id: 1, name: 'Ana', hasPhoto: true, photoStatus: 'aprovada_automaticamente' };
const pending = { id: 2, name: 'Bia', hasPhoto: true, photoStatus: 'pendente_revisao' };
const none = { id: 3, name: 'Caio', hasPhoto: false, photoStatus: null };
assert.deepEqual(exportablePhotos([ok, pending, none]).map((s) => s.id), [1]);
assert.deepEqual([ok, pending, none].map(selectable), [true, false, false]);
assert.deepEqual(downloadButton(pending), { disabled: true, title: '${PENDING_MESSAGE}' });
assert.equal(downloadButton(ok).disabled, false);
assert.equal(downloadButton(none).disabled, true);`;

function distractors(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let n = 1; n <= 30; n++) {
    const body = Array.from({ length: 60 }, (_, k) => `export function legacy${n}_${k}(input) {\n  return { id: input.id, value: input.value * ${k + 1}, module: 'legacy${n}' };\n}\n`).join('\n');
    files[`src/legacy/module${String(n).padStart(2, '0')}.js`] = body;
  }
  files['docs/spike.md'] = [
    '# Spike: enquadramento da foto',
    ...Array.from({ length: 300 }, (_, k) => `- Medição ${k + 1}: ferramenta ${['human', 'mediapipe', 'rekognition'][k % 3]} com ${(k * 7) % 100}% de acerto na amostra ${k % 12}.`),
    '',
    '## Limites adotados',
    'Os limites finais ficam em src/photo/thresholds.js; esta tabela é só histórico e não deve ser copiada para o código.',
  ].join('\n');
  return files;
}

const fullPkg = JSON.stringify({ type: 'module', scripts: { check: `node ${TSC} --noEmit -p .`, test: 'node test.mjs' } }) + '\n';

export const cardScenarios: Scenario[] = [
  {
    id: 'card-capture',
    kind: 'feature',
    maxSteps: 60,
    files: { 'package.json': PKG, 'AGENTS.md': RULES, ...captureFiles(), 'test.mjs': "import { cameraScreen } from './src/camera/screen.js';\nif (!cameraScreen('user').fullscreen) process.exit(1);\nconsole.log('ok');\n" },
    task: CAPTURE_TASK,
    check: (dir) => all(runNode(dir, CAPTURE_CHECK), noNewComments(dir)),
  },
  {
    id: 'card-status',
    kind: 'feature',
    maxSteps: 60,
    files: { 'package.json': PKG, 'AGENTS.md': RULES, ...statusFiles(), 'test.mjs': "import { analyze } from './src/photo/analyze.js';\nif (analyze().faces !== 1) process.exit(1);\nconsole.log('ok');\n" },
    task: STATUS_TASK,
    check: (dir) => all(runNode(dir, STATUS_CHECK), statusSql(dir), noNewComments(dir)),
  },
  {
    id: 'card-review',
    kind: 'feature',
    maxSteps: 60,
    files: { 'package.json': PKG, 'AGENTS.md': RULES, ...reviewFiles(), 'test.mjs': "import { put, get } from './src/storage.js';\nif (String(get(put('a', Buffer.from('x')))) !== 'x') process.exit(1);\nconsole.log('ok');\n" },
    task: REVIEW_TASK,
    check: (dir) => all(runNode(dir, REVIEW_CHECK), noNewComments(dir)),
  },
  {
    id: 'card-export',
    kind: 'feature',
    maxSteps: 60,
    files: { 'package.json': fullPkg, 'AGENTS.md': RULES, ...exportFiles(), 'test.mjs': "import { selectable } from './src/screens/students-list.ts';\nif (!selectable({ id: 1, name: 'a', hasPhoto: true, photoStatus: null })) process.exit(1);\nconsole.log('ok');\n" },
    task: EXPORT_TASK,
    check: (dir) => all(typecheck(dir), runNode(dir, EXPORT_CHECK), noNewComments(dir)),
  },
  {
    id: 'card-mini-full',
    kind: 'feature',
    maxSteps: 150,
    files: {
      'package.json': fullPkg,
      'AGENTS.md': RULES,
      ...captureFiles(),
      ...statusFiles(),
      ...reviewFiles(),
      ...exportFiles(),
      ...distractors(),
      'test.mjs': "import { cameraScreen } from './src/camera/screen.js';\nif (!cameraScreen('user').fullscreen) process.exit(1);\nconsole.log('ok');\n",
    },
    task: `Como operador do transporte escolar, quero que a foto do aluno já chegue enquadrada no padrão da carteirinha. Critérios de aceite, todos obrigatórios:\n\nCaptura\n${CAPTURE_TASK}\n\nStatus e motivo\n${STATUS_TASK}\n\nRevisão\n${REVIEW_TASK}\n\nExportação\n${EXPORT_TASK}`,
    check: (dir) => {
      const parts: [string, Check][] = [
        ['captura', runNode(dir, CAPTURE_CHECK)],
        ['status', runNode(dir, STATUS_CHECK)],
        ['sql', statusSql(dir)],
        ['revisão', runNode(dir, REVIEW_CHECK)],
        ['exportação', runNode(dir, EXPORT_CHECK)],
        ['tsc', typecheck(dir)],
        ['estilo', noNewComments(dir)],
      ];
      const failed = parts.filter(([, c]) => !c.pass);
      return failed.length
        ? { pass: false, detail: `${parts.length - failed.length}/${parts.length} blocos; falhou ${failed.map(([n, c]) => `${n} (${c.detail})`).join('; ')}` }
        : { pass: true, detail: `${parts.length}/${parts.length} blocos` };
    },
  },
];

