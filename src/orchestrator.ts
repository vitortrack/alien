import {
  claudeJudge,
  CONTRACT_SCHEMA,
  contractPrompt,
  failureBrief,
  fixBrief,
  READ_TOOLS,
  REVIEW_SCHEMA,
  REVIEW_TOOLS,
  reviewPrompt,
  runChecks,
  sliceBrief,
  type CheckResult,
  type Contract,
  type Criterion,
  type Judge,
  type Review,
  validatePrompt,
} from './contract.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { projectDataDir } from './paths.js';
import type { Session } from './session.js';
import type { PlanItem } from './tools.js';

export const GATE_ATTEMPTS = 3;

async function untilGreen(session: Session, brief: string, gate: Criterion[], label: string): Promise<CheckResult[]> {
  let failed: CheckResult[] = [];
  for (let attempt = 1; attempt <= GATE_ATTEMPTS && !session.signal.aborted; attempt++) {
    await session.spawn('worker', attempt === 1 ? brief : failureBrief(brief, failed));
    failed = (await runChecks(session.cfg.root, gate)).filter((r) => !r.pass);
    if (!failed.length) return [];
    session.ui.info(`portão de ${label}: ${failed.length} checagem(ns) falharam (tentativa ${attempt}/${GATE_ATTEMPTS})`);
  }
  return failed;
}

async function writeContract(session: Session, goal: string, judge: Judge): Promise<Contract> {
  const draft = await judge.ask<Contract>(contractPrompt(goal), CONTRACT_SCHEMA, READ_TOOLS);
  const baseline = await runChecks(session.cfg.root, draft.slices.flatMap((s) => s.criteria));
  session.ui.info(`contrato com ${draft.slices.length} fatias e ${baseline.length} checagens; validando as checagens no código atual`);
  return judge.ask<Contract>(validatePrompt(goal, draft, baseline), CONTRACT_SCHEMA, READ_TOOLS);
}

interface Progress {
  goal: string;
  contract: Contract;
  done: number[];
  finished: boolean;
}

function progressFile(root: string, goal: string): string {
  return path.join(projectDataDir(root), 'orchestrations', `${createHash('sha1').update(goal).digest('hex').slice(0, 12)}.json`);
}

function loadProgress(file: string): Progress | null {
  try {
    const progress = JSON.parse(fs.readFileSync(file, 'utf8')) as Progress;
    return progress.finished ? null : progress;
  } catch {
    return null;
  }
}

function saveProgress(file: string, progress: Progress): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(progress, null, 2));
}

export function orchestrate(session: Session, goal: string, judge: Judge = claudeJudge(session.cfg.root)): Promise<string> {
  return session.track(async () => {
    const { ui } = session;

    ui.phase('1 · Contrato');
    const file = progressFile(session.cfg.root, goal);
    let progress = loadProgress(file);
    if (progress) ui.info(`retomando o contrato salvo: ${progress.done.length} de ${progress.contract.slices.length} fatias já concluídas`);
    else {
      try {
        progress = { goal, contract: await writeContract(session, goal, judge), done: [], finished: false };
      } catch (e) {
        return `Não foi possível escrever o contrato com o motor de decisão (Claude Code, comando \`claude\`): ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!progress.contract.slices.length) return 'O motor de decisão não produziu nenhuma fatia.';
      saveProgress(file, progress);
    }
    const { contract } = progress;
    session.log({ event: 'contract', contract, file });
    const plan: PlanItem[] = contract.slices.map((s) => ({ step: s.title, status: 'pending' }));
    session.setPlan(plan);

    ui.phase('2 · Execução');
    const lines: string[] = [];
    const accepted: Criterion[] = [];
    for (const [index, slice] of contract.slices.entries()) {
      if (session.signal.aborted) return 'Interrompido pelo usuário. Rode a mesma tarefa de novo para retomar do ponto em que parou.';
      plan[index]!.status = 'in_progress';
      session.setPlan(plan);
      const resumed = progress.done.includes(index) && (await runChecks(session.cfg.root, slice.criteria)).every((r) => r.pass);
      const failed = resumed ? [] : await untilGreen(session, sliceBrief(slice), [...accepted, ...slice.criteria], `"${slice.title}"`);
      if (session.signal.aborted) return 'Interrompido pelo usuário. Rode a mesma tarefa de novo para retomar do ponto em que parou.';
      accepted.push(...slice.criteria.filter((c) => !failed.some((f) => f.criterion === c)));
      progress.done = progress.done.filter((d) => d !== index).concat(failed.length ? [] : [index]);
      saveProgress(file, progress);
      plan[index]!.status = 'done';
      session.setPlan(plan);
      lines.push(failed.length ? `✖ ${slice.title} — falhou: ${failed.map((f) => f.criterion.text).join('; ')}` : `✔ ${slice.title}`);
    }

    ui.phase('3 · Revisão');
    const all = contract.slices.flatMap((s) => s.criteria);
    let verdict = 'aprovada';
    try {
      const review = await judge.ask<Review>(reviewPrompt(goal, contract), REVIEW_SCHEMA, REVIEW_TOOLS);
      if (!review.approved && review.problems.length) {
        verdict = `${review.problems.length} problema(s) enviados para correção:\n${review.problems.map((p) => `- ${p.file}: ${p.problem}`).join('\n')}`;
        ui.phase('4 · Correções');
        await untilGreen(session, fixBrief(review.problems, accepted), accepted, 'correções');
      }
    } catch (e) {
      verdict = `não executada: ${e instanceof Error ? e.message : String(e)}`;
    }

    const final = await runChecks(session.cfg.root, all);
    saveProgress(file, { ...progress, finished: true });
    const passing = final.filter((r) => r.pass).length;
    return [
      ...lines,
      '',
      `Checagens do contrato: ${passing}/${final.length} passam.`,
      ...final.filter((r) => !r.pass).map((r) => `- falha: ${r.criterion.text}`),
      `Revisão do motor de decisão: ${verdict}`,
      `Custo do motor de decisão: US$ ${judge.costUsd.toFixed(2)}`,
    ].join('\n');
  });
}
