import type { Session } from './session.js';
import type { PlanItem } from './tools.js';

const REVIEW_ROUNDS = 2;

export function parsePlan(text: string): string[] {
  const json = text.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]) as { steps?: unknown };
      if (Array.isArray(parsed.steps)) {
        return parsed.steps.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
      }
    } catch {
      // not JSON: fall back to a numbered or bulleted list
    }
  }
  return text
    .split('\n')
    .map((line) => line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)/)?.[1]?.trim())
    .filter((s): s is string => Boolean(s));
}

function workerBrief(goal: string, plan: PlanItem[], index: number, reports: string[]): string {
  return [
    `Overall goal:\n${goal}`,
    `Full plan:\n${plan.map((p, k) => `${k + 1}. ${p.step}`).join('\n')}`,
    reports.length ? `Reports from the previous steps:\n${reports.join('\n\n')}` : '',
    `Your assignment is step ${index + 1}: ${plan[index]!.step}\nDo only this step, verify it, and report concisely what you changed.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function orchestrate(session: Session, goal: string): Promise<string> {
  return session.track(async () => {
    const { ui } = session;

    ui.phase('1 · Planejamento');
    const planText = await session.spawn('planner', goal);
    const steps = parsePlan(planText);
    if (!steps.length) return `O planner não produziu um plano utilizável:\n${planText}`;
    const plan: PlanItem[] = steps.map((step) => ({ step, status: 'pending' }));
    session.setPlan(plan);

    ui.phase('2 · Execução');
    const reports: string[] = [];
    for (const [index, item] of plan.entries()) {
      if (session.signal.aborted) return 'Interrompido pelo usuário.';
      item.status = 'in_progress';
      session.setPlan(plan);
      const report = await session.spawn('worker', workerBrief(goal, plan, index, reports));
      reports.push(`Step ${index + 1} — ${item.step}:\n${report}`);
      item.status = 'done';
    }
    session.setPlan(plan);

    if (!session.cfg.review) return reports.join('\n\n');
    for (let round = 1; round <= REVIEW_ROUNDS; round++) {
      if (session.signal.aborted) return 'Interrompido pelo usuário.';
      ui.phase(`3 · Revisão${round > 1 ? ` (rodada ${round})` : ''}`);
      const verdict = await session.review(goal);
      if (verdict.approved) {
        ui.info('revisor aprovou o trabalho');
        break;
      }
      if (round === REVIEW_ROUNDS) {
        reports.push(`Pontos do revisor ainda abertos:\n${verdict.feedback}`);
        break;
      }
      ui.phase('4 · Correções');
      const fix = await session.spawn(
        'worker',
        `Overall goal:\n${goal}\n\nAn independent reviewer requested changes:\n${verdict.feedback}\n\nFix every valid point, verify, and report what you changed.`,
      );
      reports.push(`Correções:\n${fix}`);
    }
    return reports.join('\n\n');
  });
}
