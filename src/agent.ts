import { systemPrompt, type Role } from './prompts.js';
import { activeSkillsBlock } from './skills.js';
import { changedFiles, nestedInstructions, scopeReport, workspaceDiff } from './scope.js';
import type { CheckResult } from './contract.js';
import { isJudged, orderedChecks } from './gate.js';
import { agentJudge } from './judge.js';
import type { Session } from './session.js';
import { allTools, cleanPath, describeInput, offload, permit, suggestPath, toolLoader, type Tool, type ToolContext } from './tools.js';
import type { Image, Provider, ToolCall, ToolResult } from './types.js';
import type { AgentUI } from './agent-ui.js';
import { validateInput } from './validate.js';
import fs from 'node:fs';
import path from 'node:path';
import { formatErrors, typeDiagnostics, typeErrors } from './diagnostics.js';
import { isReadOnlyCommand } from './shell.js';
import { SKILL_REVIEW_AFTER_STEPS } from './skill-review.js';

const researchOnly = (t: Tool): boolean => t.readOnly && !['delegate', 'update_plan', 'remember', 'report_conflict', 'skill'].includes(t.name);

const PAGED_TOOLS = ['read_file', 'skill'];
const toolKey = (name: string): string => name.toLowerCase().replace(/[^a-z]/g, '');

const BASH_COVERS = ['update_plan', 'remember', 'run_code', 'list_dir', 'glob', 'grep'];

const ROLE_TOOLS: Record<Role, (t: Tool) => boolean> = {
  main: () => true,
  worker: (t) => t.name !== 'delegate',
  explorer: researchOnly,
  critic: (t) => researchOnly(t) || t.name === 'bash',
};

const MAX_REVIEWS = 2;
const MAX_IDENTICAL_CALLS = 3;
const RECALLED = 5;
const MAX_SCOPE_CHECKS = 2;
const RUN_END = 'This run is ending. The next run continues this work from a handoff note only, without your context.';
const HANDOFF_REQUEST = (lead: string): string =>
  `[handoff] ${lead} Write that note now, without calling tools, with exactly these sections:\n## State (what is done and verified, with file paths)\n## Decisions (choices made and why, constraints learned)\n## Tried and failed (each approach that did not work, with the exact error, so the next run does not repeat it)\n## Next steps (what remains, in order)\nBe dense and factual: keep exact paths, identifiers, commands and error strings.`;
const stepsLeft = (max: number, step: number): string => (max > 0 ? `You have used ${step} of your ${max} steps (${max - step} left).` : `You have used ${step} steps (no step limit).`);
const gateList = (results: CheckResult[]): string => results.map((r) => `- ${r.criterion.text}\n  $ ${r.criterion.check}${r.pass ? '' : `\n  ${r.output.trim().slice(-600).replace(/\n/g, '\n  ') || '(no output)'}`}`).join('\n');
const VERIFY_NUDGE =
  '[verification] You changed code but have not run anything since your last edit. Before your final answer, run the tests, build or type-check that cover the change (or execute the changed code) and read the whole output; fix what fails. If nothing in this project can be run, say so explicitly in the final answer.';
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

const MAX_JUDGE_REJECTIONS = 2;
const skippedEndSteps = (): Set<string> => new Set((process.env.ALIEN_SKIP_END ?? '').split(',').map((s) => s.trim()));

export class Agent {
  private readonly provider: Provider;
  private readonly tools: Tool[];
  private readonly deferred: Tool[];
  private systemCache: { key: string; text: string } | null = null;
  private changed = false;
  private readonly callCounts = new Map<string, number>();
  private readonly files = new Map<string, number>();
  private step = 0;
  private readonly startedAt = Date.now();
  private readonly touched = new Set<string>();
  private readonly instructionsSeen = new Set<string>();
  private verifiedSinceEdit = true;
  private readonly trace: string[] = [];

  constructor(
    private readonly session: Session,
    readonly role: Role,
    private readonly ui: AgentUI,
  ) {
    this.provider = session.newProvider();
    const only = session.cfg.tools;
    const lean = role === 'main' && session.cfg.provider === 'anthropic';
    const available = allTools.filter((t) => ROLE_TOOLS[role](t) && !(lean && BASH_COVERS.includes(t.name)) && (!only || only.includes(t.name)) && (t.name !== 'skill' || session.skills.length > 0));
    this.deferred = only ? [] : available.filter((t) => t.group);
    this.tools = available.filter((t) => !this.deferred.includes(t));
    if (this.deferred.length) this.tools.push(toolLoader(this.deferred, (names) => this.enable(names)));
    this.tools.push({
      name: 'status',
      readOnly: true,
      description: 'Shows how many steps of this task you have used and how many are left, the elapsed time and the tokens used so far.',
      schema: { type: 'object', properties: {}, required: [] },
      run: async () => `${stepsLeft(session.cfg.maxSteps, this.step)} Elapsed: ${Math.round((Date.now() - this.startedAt) / 60_000)} min. Tokens used: ${session.usage.input + session.usage.output}.`,
    });
  }

  private enable(names: string[]): void {
    for (const t of this.deferred) if (names.includes(t.name) && !this.tools.includes(t)) this.tools.push(t);
  }

  snapshot(): unknown {
    return this.provider.snapshot();
  }

  restore(state: unknown): void {
    this.provider.restore(state);
  }

  private get system(): string {
    const { root, lang, interactive = false } = this.session.cfg;
    const key = `${lang}|${interactive}|${[...this.session.activeSkills].join(',')}`;
    if (this.systemCache?.key !== key)
      this.systemCache = {
        key,
        text: [systemPrompt(this.role, root, lang, interactive, this.tools.some((t) => t.name === 'skill') ? this.session.skills : []), activeSkillsBlock(this.session.skills, this.session.activeSkills)].filter(Boolean).join('\n\n'),
      };
    return this.systemCache.text;
  }

  async run(task: string, images: Image[] = []): Promise<string> {
    const out = await this.loop(task, images);
    const file = this.role === 'main' ? this.session.cfg.handoff : undefined;
    if (file && !this.session.signal.aborted) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, await this.note(task));
      this.session.log({ agent: this.role, event: 'handoff-saved', file });
    }
    return out;
  }

  private opening(task: string): string {
    const { handoff, gate, harness } = this.session.cfg;
    if (this.role !== 'main') return task;
    const previous = handoff ? readIfExists(handoff) : null;
    const head = previous ? `<previous_handoff>\nNote left by the previous run on this work. Trust it instead of exploring again what it covers; re-read a file only right before you edit it.\n${previous.trim()}\n</previous_handoff>\n\n` : '';
    const tail = gate?.length ? `\n\nDone means every check below exits 0 when run from the repository root; they are run automatically before you finish. Implement the behavior they describe; do not write code just to satisfy a command.\n${gate.map((c) => `- ${c.text}\n  $ ${c.check}`).join('\n')}` : '';
    const block = harness?.trim() ? `<task_harness>\n${harness.trim()}\n</task_harness>\n\n` : '';
    return `${head}${block}${task}${tail}${this.session.cfg.maxSteps > 0 ? `\n\nYou have up to ${this.session.cfg.maxSteps} steps for this task. Call the status tool whenever you want to know how many are left.` : ''}`;
  }

  private judgeRejections = 0;

  private async gateStatus(task: string): Promise<{ results: CheckResult[]; failed: number }> {
    const judged = this.judgeRejections < MAX_JUDGE_REJECTIONS ? { request: task, judge: agentJudge(this.session) } : undefined;
    const results = await orderedChecks(this.session.cfg.root, this.session.cfg.gate ?? [], judged);
    if (results.some((r) => !r.pass && isJudged(r.criterion))) this.judgeRejections++;
    return { results, failed: results.filter((r) => !r.pass).length };
  }

  private async loop(task: string, images: Image[] = []): Promise<string> {
    const { cfg } = this.session;
    const ctx = this.session.context(this.ui, this.files, task);
    ctx.afterRpc = async (name, input) => {
      if (name === 'bash' && !isReadOnlyCommand(String(input.command ?? ''))) this.verifiedSinceEdit = true;
      return name === 'read_file' && typeof input.path === 'string' ? nestedInstructions(ctx.root, cleanPath(input.path), this.instructionsSeen) : '';
    };
    this.changed = false;
    this.callCounts.clear();
    this.verifiedSinceEdit = true;
    this.provider.addUser(await this.withRecall(task, this.opening(task)), images);
    const gated = this.role === 'main' && Boolean(cfg.gate?.length);
    this.session.log({ agent: this.role, event: 'task', task });
    const skip = skippedEndSteps();
    let reviews = 0;
    let scopeChecks = 0;
    let verifyNudges = 0;
    let requirementsChecked = this.role !== 'main';
    let approvedDiff: string | null = null;
    let lastScopeReport: string | null = null;
    const dirtyAtStart = new Set(this.role === 'main' ? await changedFiles(cfg.root) : []);
    this.touched.clear();
    this.trace.length = 0;

    try {
      for (let step = 1; cfg.maxSteps <= 0 || step <= cfg.maxSteps; step++) {
        this.step = step;
        if (this.role === 'main') {
          for (const message of this.session.takeQueued()) {
            this.provider.addUser(`[message from the user while you work: it adds to or changes the request; follow it from now on]\n${message}`);
            task += `\n\n${message}`;
            this.session.log({ agent: this.role, event: 'queued-message', message });
          }
        }
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
          if (gated) {
            const { results, failed } = await this.gateStatus(task);
            if (failed) {
              this.ui.info(`portão: ${failed} checagem(ns) falhando; o agente continua`);
              const message = `[gate] ${results.length - failed}/${results.length} checks pass. ${stepsLeft(cfg.maxSteps, step)} You cannot finish yet. Fix each failing check below (implement the behavior, not code that only satisfies the command), then finish:\n${gateList(results.filter((r) => !r.pass))}`;
              this.session.log({ agent: this.role, event: 'gate', failed, text: message });
              this.provider.addUser(message);
              continue;
            }
          }
          if (this.role === 'main' && !skip.has('verify') && !this.verifiedSinceEdit && verifyNudges < 1 && [...this.touched].some((f) => !isDocFile(f))) {
            verifyNudges++;
            this.ui.info('verificação: pedindo para rodar testes ou build antes de concluir');
            this.session.log({ agent: this.role, event: 'verify-nudge' });
            this.provider.addUser(VERIFY_NUDGE);
            continue;
          }
          if (this.changed && !skip.has('requirements') && !requirementsChecked && [...this.touched].some((f) => !isDocFile(f))) {
            requirementsChecked = true;
            this.ui.info('requisitos: conferindo cada item do pedido antes de concluir');
            this.session.log({ agent: this.role, event: 'requirements-check' });
            this.provider.addUser(REQUIREMENTS_NUDGE(task));
            continue;
          }
          const diff = this.role === 'main' && this.changed ? await workspaceDiff(cfg.root) : null;
          const unchangedSinceApproval = diff !== null && diff === approvedDiff;
          if (this.role === 'main' && !skip.has('review') && cfg.review && this.changed && reviews < MAX_REVIEWS && !unchangedSinceApproval) {
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
          if (this.role === 'main' && !skip.has('scope') && this.changed && scopeChecks < MAX_SCOPE_CHECKS) {
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
          if (this.role === 'main' && this.changed && this.verifiedSinceEdit) {
            await this.session.memory.add('episode', `Task: ${task.slice(0, 300)} | Outcome: ${r.text.slice(0, 700)}`, ctx.signal);
          }
          if (this.role === 'main' && step >= SKILL_REVIEW_AFTER_STEPS) this.session.reviewSkills({ task, trace: [...this.trace], answer: r.text });
          return r.text;
        }

        const results = await this.execute(r.toolCalls, ctx);
        const conflict = results.find((x) => x.name === 'report_conflict' && !x.isError);
        if (conflict) {
          this.session.log({ agent: this.role, event: 'conflict', text: conflict.output });
          this.ui.warn('o agente sinalizou um conflito com o pedido');
          return conflict.output;
        }
        this.provider.addToolResults(results);
        if (this.session.signal.aborted) return 'Interrompido pelo usuário.';
      }
      return `Limite de ${cfg.maxSteps} passos atingido antes de concluir. Peça para continuar ou aumente --max-steps.`;
    } catch (e) {
      if (this.session.signal.aborted) return 'Interrompido pelo usuário.';
      throw e;
    }
  }

  private async note(task: string): Promise<string> {
    this.provider.addUser(HANDOFF_REQUEST(RUN_END));
    const r = await this.provider.step({ system: this.system, task, changedFiles: [...this.touched], tools: this.tools, signal: this.session.signal, onText: () => undefined, onThinking: () => undefined });
    this.session.addUsage(r.usage);
    const plan = this.session.plan.map((p) => `- [${p.status}] ${p.step}`).join('\n');
    const files = [...new Set([...this.touched, ...(await changedFiles(this.session.cfg.root))])];
    return `# Handoff\n\n## Plan\n${plan || '(none)'}\n\n## Files changed\n${files.join('\n') || '(none)'}\n\n${r.text.trim()}\n`;
  }

  private async withRecall(task: string, body: string): Promise<string> {
    if (this.role !== 'main') return body;
    const memories = await this.session.memory.recall(task, RECALLED, this.session.signal).catch(() => []);
    if (!memories.length) return body;
    this.ui.info(`${memories.length} lembrança(s) relevante(s) recuperada(s) da memória de longo prazo`);
    const block = memories.map((m) => `- [${m.kind}] ${m.text}`).join('\n');
    return `<recalled_memory>\nPossibly relevant notes from earlier sessions (verify before relying on them):\n${block}\n</recalled_memory>\n\n${body}`;
  }

  private async execute(calls: ToolCall[], ctx: ToolContext): Promise<ToolResult[]> {
    const isRead = (c: ToolCall) => Boolean(this.tools.find((t) => t.name === c.name)?.readOnly) && !(c.name === 'delegate' && c.input.role === 'worker');
    const done = new Map<ToolCall, ToolResult>();
    const reads = calls.filter(isRead);
    (await Promise.all(reads.map((c) => this.call(c, ctx)))).forEach((r, i) => done.set(reads[i]!, r));
    for (const c of calls) if (!done.has(c)) done.set(c, await this.call(c, ctx));
    return calls.map((c) => done.get(c)!);
  }

  private async call(c: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    let savedAs: string | undefined;
    const finish = (output: string, isError: boolean): ToolResult => {
      this.trace.push(`${isError ? '✗' : '✓'} ${c.name} ${describeInput(c.input, 60)}`);
      this.ui.observation(!isError, output);
      this.session.log({ agent: this.role, event: 'tool', name: c.name, input: c.input, isError, output: output.slice(0, 4000) });
      return { id: c.id, name: c.name, output, isError, ...(savedAs ? { savedAs } : {}) };
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
    if (seen > MAX_IDENTICAL_CALLS && c.name !== 'status') {
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
      if (!PAGED_TOOLS.includes(c.name)) {
        const off = await offload(output, ctx.root, `outputs/${this.session.id}/${c.name}-${c.id.replace(/[^\w-]/g, '')}.txt`);
        output = off.text;
        savedAs = off.file;
      }
      if (c.name === 'skill') {
        const wanted = (this.session.skills.find((s) => s.name === c.input.name)?.tools ?? []).map(toolKey);
        const names = this.deferred.filter((t) => wanted.includes(toolKey(t.name)) || wanted.includes(toolKey(t.group ?? ''))).map((t) => t.name);
        this.enable(names);
        if (names.length) output += `\n\n[tools] Loaded for this skill: ${names.join(', ')}.`;
      }
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
        }
      } else if (c.name === 'bash' && !isReadOnlyCommand(String(c.input.command ?? ''))) {
        this.verifiedSinceEdit = true;
      }
      if (!tool.readOnly) {
        this.changed = true;
        if (typeof c.input.path === 'string') {
          this.touched.add(cleanPath(c.input.path));
        }
      }
      if ((c.name === 'read_file' || c.name === 'edit_file' || c.name === 'write_file') && typeof c.input.path === 'string') {
        const rules = await nestedInstructions(ctx.root, cleanPath(c.input.path), this.instructionsSeen);
        if (rules) output += `\n\n${rules}`;
      }
      return finish(output + note, false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const hint = /ENOENT/.test(message) && typeof c.input.path === 'string' ? await suggestPath(ctx.root, c.input.path) : '';
      return finish(`Error: ${hint ? `File not found: ${String(c.input.path)}.${hint}` : message}`, true);
    }
  }
}
