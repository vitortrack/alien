import {
  arbitratePrompt,
  claudeJudge,
  CONTRACT_SCHEMA,
  contractPrompt,
  failureBrief,
  fixBrief,
  READ_TOOLS,
  REVIEW_SCHEMA,
  REVIEW_TOOLS,
  reviewPrompt,
  revisePrompt,
  RULING_SCHEMA,
  runChecks,
  sliceBrief,
  type CheckResult,
  type Contract,
  type Criterion,
  type Judge,
  type Review,
  type Ruling,
} from './contract.js';
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

async function settle(session: Session, judge: Judge, brief: string, gate: Criterion[], label: string): Promise<CheckResult[]> {
  const failed = await untilGreen(session, brief, gate, label);
  if (!failed.length || session.signal.aborted) return failed;
  let rulings: Ruling[];
  try {
    ({ rulings } = await judge.ask<{ rulings: Ruling[] }>(arbitratePrompt(brief, failed), RULING_SCHEMA, READ_TOOLS));
  } catch {
    return failed;
  }
  failed.forEach((f, k) => {
    if (rulings[k]?.checkIsWrong) f.criterion.check = rulings[k]!.check;
  });
  const fixedChecks = rulings.filter((r) => r.checkIsWrong).length;
  session.ui.info(`arbitragem de ${label}: ${fixedChecks} checagem(ns) corrigidas, ${failed.length - fixedChecks} falha(s) no código`);
  const remaining = (await runChecks(session.cfg.root, gate)).filter((r) => !r.pass);
  if (!remaining.length) return [];
  const notes = rulings.filter((r) => !r.checkIsWrong).map((r) => `- ${r.text}: ${r.note}`);
  await session.spawn('worker', `${failureBrief(brief, remaining)}${notes.length ? `\n\nDiagnosis by the reviewer:\n${notes.join('\n')}` : ''}`);
  return (await runChecks(session.cfg.root, gate)).filter((r) => !r.pass);
}

async function writeContract(session: Session, goal: string, judge: Judge): Promise<Contract> {
  const contract = await judge.ask<Contract>(contractPrompt(goal), CONTRACT_SCHEMA, READ_TOOLS);
  const premature = (await runChecks(session.cfg.root, contract.slices.flatMap((s) => s.criteria).filter((c) => !c.guard)))
    .filter((r) => r.pass)
    .map((r) => r.criterion);
  if (!premature.length) return contract;
  session.ui.info(`${premature.length} checagem(ns) já passavam antes da mudança; o contrato volta para revisão`);
  return judge.ask<Contract>(revisePrompt(goal, contract, premature), CONTRACT_SCHEMA, READ_TOOLS);
}

export function orchestrate(session: Session, goal: string, judge: Judge = claudeJudge(session.cfg.root)): Promise<string> {
  return session.track(async () => {
    const { ui } = session;

    ui.phase('1 · Contrato');
    let contract: Contract;
    try {
      contract = await writeContract(session, goal, judge);
    } catch (e) {
      return `Não foi possível escrever o contrato com o motor de decisão (Claude Code, comando \`claude\`): ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!contract.slices.length) return 'O motor de decisão não produziu nenhuma fatia.';
    session.log({ event: 'contract', contract });
    const plan: PlanItem[] = contract.slices.map((s) => ({ step: s.title, status: 'pending' }));
    session.setPlan(plan);

    ui.phase('2 · Execução');
    const lines: string[] = [];
    const accepted: Criterion[] = [];
    for (const [index, slice] of contract.slices.entries()) {
      if (session.signal.aborted) return 'Interrompido pelo usuário.';
      plan[index]!.status = 'in_progress';
      session.setPlan(plan);
      const failed = await settle(session, judge, sliceBrief(slice), [...accepted, ...slice.criteria], `"${slice.title}"`);
      accepted.push(...slice.criteria.filter((c) => !failed.some((f) => f.criterion === c)));
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
        await settle(session, judge, fixBrief(review.problems, accepted), accepted, 'correções');
      }
    } catch (e) {
      verdict = `não executada: ${e instanceof Error ? e.message : String(e)}`;
    }

    const final = await runChecks(session.cfg.root, all);
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
