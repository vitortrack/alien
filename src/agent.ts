import { systemPrompt, type Role } from './prompts.js';
import { changedFiles, nestedInstructions, scopeReport, workspaceDiff } from './scope.js';
import type { Session } from './session.js';
import { allTools, cleanPath, describeInput, permit, suggestPath, type Tool, type ToolContext } from './tools.js';
import type { Provider, ToolCall, ToolResult } from './types.js';
import type { AgentUI } from './agent-ui.js';
import { validateInput } from './validate.js';
import fs from 'node:fs';
import path from 'node:path';
import { formatErrors, typeDiagnostics, typeErrors } from './diagnostics.js';
import { isReadOnlyCommand } from './shell.js';

const researchOnly = (t: Tool): boolean => t.readOnly && !['delegate', 'update_plan', 'remember', 'report_conflict', 'skill'].includes(t.name);

const BASH_COVERS = ['update_plan', 'remember', 'run_code', 'list_dir', 'glob', 'grep'];

const ROLE_TOOLS: Record<Role, (t: Tool) => boolean> = {
  main: () => true,
  worker: (t) => t.name !== 'delegate',
  explorer: researchOnly,
  planner: researchOnly,
  critic: (t) => researchOnly(t) || t.name === 'bash',
};

const MAX_REVIEWS = 2;
const FAILURE_STREAK = 3;
const MAX_IDENTICAL_CALLS = 3;
const RECALLED = 5;
const EXPLORE_BUDGET = 15;
const EXPLORE_REMINDER_EVERY = 10;
const REREAD_WARNING_AT = 3;
const MAX_SCOPE_CHECKS = 2;
const RECAP_EVERY = 30;
const EDIT_LOOP_AT = 5;
const EDIT_LOOP_EVERY = 3;
const VERIFY_NUDGE =
  '[verification] You changed code but have not run anything since your last edit. Before your final answer, run the tests, build or type-check that cover the change (or execute the changed code) and read the whole output; fix what fails. If nothing in this project can be run, say so explicitly in the final answer.';
export const verifyReserve = (maxSteps: number): number => Math.min(maxSteps - 1, Math.max(2, Math.ceil(maxSteps * 0.1)));
export const budgetWarning = (left: number, unverified: boolean): string =>
  unverified
    ? `[budget] Only ${left} steps left. Stop adding new work now: run the type-check, build or tests that cover your changes, fix what fails, then give the final report and list every requested item that is not done.`
    : `[budget] Only ${left} steps left. Wrap up now and give your final report; list every requested item that is not done.`;
const REQUIREMENTS_NUDGE = (task: string): string =>
  `[requirements] Before finishing, check your work against every item of the original request below, one by one, and then against the project instructions (naming, comments, file layout, required checks). For each item write PASS or FAIL with concrete evidence (file:line you changed or the command output that proves it); an item you did not implement or could not verify is FAIL. Then fix every FAIL item, verify again, and give the final report.\n\n<original_request>\n${task}\n</original_request>`;
const readIfExists = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const isDocFile = (f: string): boolean => /\.(md|mdx|txt|rst)$/i.test(f);

export class Agent {
  private readonly provider: Provider;
  private readonly tools: Tool[];
  private systemCache: { key: string; text: string } | null = null;
  private changed = false;
  private readonly callCounts = new Map<string, number>();
  private readonly files = new Map<string, number>();
  private readonly reads = new Map<string, number>();
  private mutations = 0;
  private readonly touched = new Set<string>();
  private readonly instructionsSeen = new Set<string>();
  private verifiedSinceEdit = true;
  private readonly editsPerFile = new Map<string, number>();

  constructor(
    private readonly session: Session,
    readonly role: Role,
    private readonly ui: AgentUI,
  ) {
    this.provider = session.newProvider();
    const only = session.cfg.tools;
    const lean = role === 'main' && session.cfg.provider === 'anthropic';
    this.tools = allTools.filter((t) => ROLE_TOOLS[role](t) && !(lean && BASH_COVERS.includes(t.name)) && (!only || only.includes(t.name)) && (t.name !== 'skill' || session.skills.length > 0));
  }

  snapshot(): unknown {
    return this.provider.snapshot();
  }

  restore(state: unknown): void {
    this.provider.restore(state);
  }

  private get system(): string {
    const { root, lang, interactive = false } = this.session.cfg;
    const key = `${lang}|${interactive}`;
    if (this.systemCache?.key !== key) this.systemCache = { key, text: systemPrompt(this.role, root, lang, interactive, this.tools.some((t) => t.name === 'skill') ? this.session.skills : []) };
    return this.systemCache.text;
  }

  async run(task: string): Promise<string> {
    const { cfg } = this.session;
    const ctx = this.session.context(this.ui, this.files, task);
    this.changed = false;
    this.callCounts.clear();
    this.reads.clear();
    this.verifiedSinceEdit = true;
    this.editsPerFile.clear();
    if (this.role === 'main') void this.session.codeIndex.update(this.session.signal).catch(() => undefined);
    this.provider.addUser(await this.withRecall(task));
    this.session.log({ agent: this.role, event: 'task', task });
    let reviews = 0;
    let failures = 0;
    let idle = 0;
    let scopeChecks = 0;
    let verifyNudges = 0;
    let requirementsChecked = this.role !== 'main';
    let approvedDiff: string | null = null;
    let lastScopeReport: string | null = null;
    const dirtyAtStart = new Set(this.role === 'main' ? await changedFiles(cfg.root) : []);
    this.touched.clear();

    try {
      for (let step = 1; step <= cfg.maxSteps; step++) {
        if (this.session.overBudget()) return `Orçamento de ${cfg.tokenBudget.toLocaleString('pt-BR')} tokens atingido; parei para não gastar além do limite.`;
        const r = await this.provider.step({
          system: this.system,
          task,
          changedFiles: [...this.touched],
          tools: this.tools,
          signal: this.session.signal,
          onText: this.ui.text,
          onThinking: this.ui.thinking,
        });
        this.session.addUsage(r.usage);
        if (r.compacted) {
          this.ui.info('contexto compactado: histórico antigo resumido, pedido original mantido');
          this.session.log({ agent: this.role, event: 'compacted', step });
        }
        this.session.log({ agent: this.role, event: 'step', step, stop: r.stop, text: r.text, toolCalls: r.toolCalls });
        if (r.stop === 'refusal') return 'O modelo recusou esta solicitação.';

        if (r.toolCalls.length === 0) {
          if (r.stop === 'max_tokens') {
            this.provider.addUser('Your reply was cut off by the output limit. Continue exactly where you stopped.');
            continue;
          }
          if (this.role === 'main' && !this.verifiedSinceEdit && verifyNudges < 1 && [...this.touched].some((f) => !isDocFile(f))) {
            verifyNudges++;
            this.ui.info('verificação: pedindo para rodar testes ou build antes de concluir');
            this.session.log({ agent: this.role, event: 'verify-nudge' });
            this.provider.addUser(VERIFY_NUDGE);
            continue;
          }
          if (this.changed && !requirementsChecked && [...this.touched].some((f) => !isDocFile(f))) {
            requirementsChecked = true;
            this.ui.info('requisitos: conferindo cada item do pedido antes de concluir');
            this.session.log({ agent: this.role, event: 'requirements-check' });
            this.provider.addUser(REQUIREMENTS_NUDGE(task));
            continue;
          }
          const diff = this.role === 'main' && this.changed ? await workspaceDiff(cfg.root) : null;
          const unchangedSinceApproval = diff !== null && diff === approvedDiff;
          if (this.role === 'main' && cfg.review && this.changed && reviews < MAX_REVIEWS && !unchangedSinceApproval) {
            reviews++;
            const verdict = await this.session.review(task, this.ui);
            if (!verdict.approved) {
              this.ui.warn('o revisor pediu correções');
              this.provider.addUser(
                `An independent reviewer inspected the workspace and requested changes:\n\n${verdict.feedback}\n\nFix every valid point (explain briefly if you disagree with one), verify again, then give the final report.`,
              );
              continue;
            }
            approvedDiff = diff;
            this.ui.info('revisor aprovou o trabalho');
          }
          if (this.role === 'main' && this.changed && scopeChecks < MAX_SCOPE_CHECKS) {
            scopeChecks++;
            const now = (await changedFiles(cfg.root)).filter((f) => !dirtyAtStart.has(f) || this.touched.has(f));
            const report = scopeReport(task, now);
            if (report && report !== lastScopeReport) {
              lastScopeReport = report;
              this.ui.warn('checagem de escopo: alterações em áreas que o pedido não menciona');
              this.session.log({ agent: this.role, event: 'scope-check', report });
              this.provider.addUser(report);
              continue;
            }
          }
          this.session.log({ agent: this.role, event: 'final', text: r.text });
          if (this.role === 'main' && this.changed) {
            await this.session.memory.add('episode', `Task: ${task.slice(0, 300)} | Outcome: ${r.text.slice(0, 700)}`, ctx.signal);
          }
          return r.text;
        }

        const before = this.mutations;
        const results = await this.execute(r.toolCalls, ctx);
        const conflict = results.find((x) => x.name === 'report_conflict' && !x.isError);
        if (conflict) {
          this.session.log({ agent: this.role, event: 'conflict', text: conflict.output });
          this.ui.warn('o agente sinalizou um conflito com o pedido');
          return conflict.output;
        }
        failures = results.every((x) => x.isError) ? failures + 1 : 0;
        idle = this.mutations > before ? 0 : idle + 1;
        const last = results[results.length - 1]!;
        if ((this.role === 'main' || this.role === 'worker') && idle >= EXPLORE_BUDGET && (idle - EXPLORE_BUDGET) % EXPLORE_REMINDER_EVERY === 0) {
          last.output += `\n\n[focus] You have spent ${idle} steps investigating without changing anything. If the user asked a question, answer now with what you already know. If they asked for a change, stop exploring: state your decision in one line and make the first edit now. Do not re-read files whose content you have already seen.`;
        }
        if (failures >= FAILURE_STREAK) {
          last.output +=
            '\n\n[reflection] Several tool calls in a row have failed. Stop and reconsider: re-read the relevant code and the exact error, question your assumptions, and try a different approach.';
        }
        if (this.role === 'main' && step % RECAP_EVERY === 0) {
          last.output += `\n\n[recap] Step ${step} of ${cfg.maxSteps}. Re-read the original request and keep working on what is still missing; do not stop before every item is done and verified.\n<original_request>\n${task}\n</original_request>`;
        }
        if (step === cfg.maxSteps - verifyReserve(cfg.maxSteps)) last.output += `\n\n${budgetWarning(cfg.maxSteps - step, this.touched.size > 0 && !this.verifiedSinceEdit)}`;
        this.provider.addToolResults(results);
        if (this.session.signal.aborted) return 'Interrompido pelo usuário.';
      }
      return `Limite de ${cfg.maxSteps} passos atingido antes de concluir. Peça para continuar ou aumente --max-steps.`;
    } catch (e) {
      if (this.session.signal.aborted) return 'Interrompido pelo usuário.';
      throw e;
    }
  }

  private async withRecall(task: string): Promise<string> {
    if (this.role !== 'main') return task;
    const memories = await this.session.memory.recall(task, RECALLED, this.session.signal).catch(() => []);
    if (!memories.length) return task;
    this.ui.info(`${memories.length} lembrança(s) relevante(s) recuperada(s) da memória de longo prazo`);
    const block = memories.map((m) => `- [${m.kind}] ${m.text}`).join('\n');
    return `<recalled_memory>\nPossibly relevant notes from earlier sessions (verify before relying on them):\n${block}\n</recalled_memory>\n\n${task}`;
  }

  private async execute(calls: ToolCall[], ctx: ToolContext): Promise<ToolResult[]> {
    const parallel =
      calls.length > 1 &&
      calls.every((c) => this.tools.find((t) => t.name === c.name)?.readOnly && !(c.name === 'delegate' && c.input.role === 'worker'));
    if (parallel) return Promise.all(calls.map((c) => this.call(c, ctx)));
    const results: ToolResult[] = [];
    for (const c of calls) results.push(await this.call(c, ctx));
    return results;
  }

  private async call(c: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const finish = (output: string, isError: boolean): ToolResult => {
      this.ui.observation(!isError, output);
      this.session.log({ agent: this.role, event: 'tool', name: c.name, input: c.input, isError, output: output.slice(0, 4000) });
      return { id: c.id, name: c.name, output, isError };
    };
    const tool = this.tools.find((t) => t.name === c.name);
    this.ui.tool(c.name, describeInput(c.input));
    if (!tool) return finish(`Unknown tool "${c.name}". Available tools: ${this.tools.map((t) => t.name).join(', ')}.`, true);
    const { error: invalid, ignored } = validateInput(tool, c.input);
    if (invalid) return finish(`Invalid arguments: ${invalid}. Fix the arguments and call the tool again.`, true);
    const note = ignored.length ? `\n[ignored unknown argument(s): ${ignored.join(', ')}; this tool accepts: ${Object.keys(tool.schema.properties).join(', ')}]` : '';
    const signature = `${c.name}:${JSON.stringify(c.input)}`;
    const seen = (this.callCounts.get(signature) ?? 0) + 1;
    this.callCounts.set(signature, seen);
    if (seen > MAX_IDENTICAL_CALLS && !tool.readOnly) {
      return finish(`Loop guard: this exact ${c.name} call was already made ${seen - 1} times. Repeating it will not change the outcome; change your approach.`, true);
    }
    if (seen > MAX_IDENTICAL_CALLS) {
      return finish(`Loop guard: you already made this exact call ${seen - 1} times and have its result above. Use what you have or try something different.`, true);
    }
    if (c.name === 'report_conflict' && c.input.kind === 'test_contradicts_request' && (this.touched.size === 0 || !this.verifiedSinceEdit)) {
      return finish('Not reported yet: first implement what the request asks (edit the code), then run the tests after your last edit, so the explanation quotes real output. Then call report_conflict again.', true);
    }
    if (c.name === 'report_conflict' && this.touched.size === 0 && !this.session.cfg.interactive) {
      return finish('Not reported: nobody is available to answer questions in this run. Choose the most reasonable option, note the assumption for your final report, and implement what the request asks. Report a conflict only after that work shows the request cannot be done as asked.', true);
    }
    try {
      if (ctx.signal.aborted) return finish('Interrupted by the user.', true);
      const denied = await permit(tool, c.input, ctx);
      if (denied) return finish(denied, true);
      const guarded = (c.name === 'edit_file' || c.name === 'write_file') && typeof c.input.path === 'string' ? cleanPath(c.input.path) : null;
      const previous = guarded === null ? null : readIfExists(path.resolve(ctx.root, guarded));
      const blockingBefore = new Set(guarded === null || previous === null ? [] : typeErrors(ctx.root, guarded).filter((e) => e.blocking).map((e) => e.key));
      let output = await tool.run(c.input, ctx);
      if (guarded !== null) {
        const introduced = typeErrors(ctx.root, guarded).filter((e) => e.blocking && !blockingBefore.has(e.key));
        if (introduced.length) {
          const target = path.resolve(ctx.root, guarded);
          if (previous === null) {
            fs.rmSync(target, { force: true });
            ctx.files.delete(target);
          } else {
            fs.writeFileSync(target, previous);
            ctx.files.set(target, fs.statSync(target).mtimeMs);
          }
          return finish(`Edit rejected and reverted: it introduces ${introduced.length} error(s) the type checker can see in this file alone:\n${formatErrors(introduced)}\nThe file is unchanged. Fix the edit (declare or import the missing names, close the syntax) and apply it again.`, true);
        }
      }
      if (c.name === 'edit_file' || c.name === 'write_file') {
        this.verifiedSinceEdit = false;
        if (typeof c.input.path === 'string') {
          const file = cleanPath(c.input.path);
          const diagnostics = typeDiagnostics(ctx.root, file);
          if (diagnostics) output += `\n\n${diagnostics}`;
          const edits = (this.editsPerFile.get(file) ?? 0) + 1;
          this.editsPerFile.set(file, edits);
          if (edits >= EDIT_LOOP_AT && (edits - EDIT_LOOP_AT) % EDIT_LOOP_EVERY === 0) {
            output += `\n\n[loop] You have edited ${file} ${edits} times in this task. If you keep adjusting the same thing, stop: re-read the latest error output in full, state which assumption may be wrong, and change approach instead of trying another small variation.`;
          }
        }
      } else if (c.name === 'run_code' || (c.name === 'bash' && !isReadOnlyCommand(String(c.input.command ?? '')))) {
        this.verifiedSinceEdit = true;
      }
      if (!tool.readOnly) {
        this.changed = true;
        this.mutations++;
        if (typeof c.input.path === 'string') {
          this.reads.delete(c.input.path);
          this.touched.add(cleanPath(c.input.path));
        }
      }
      if ((c.name === 'read_file' || c.name === 'edit_file' || c.name === 'write_file') && typeof c.input.path === 'string') {
        const rules = await nestedInstructions(ctx.root, cleanPath(c.input.path), this.instructionsSeen);
        if (rules) output += `\n\n${rules}`;
      }
      if (c.name === 'read_file' && typeof c.input.path === 'string') {
        const times = (this.reads.get(c.input.path) ?? 0) + 1;
        this.reads.set(c.input.path, times);
        if (times >= REREAD_WARNING_AT) {
          output += `\n\n[note] You have read ${c.input.path} ${times} times in this task and it has not changed since. Reuse what you already saw instead of reading it again.`;
        }
      }
      return finish(output + note, false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const hint = /ENOENT/.test(message) && typeof c.input.path === 'string' ? await suggestPath(ctx.root, c.input.path) : '';
      return finish(`Error: ${hint ? `File not found: ${String(c.input.path)}.${hint}` : message}`, true);
    }
  }
}
