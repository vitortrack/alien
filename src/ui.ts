import readline from 'node:readline/promises';
import { styleText } from 'node:util';
import type { AgentUI } from './agent-ui.js';
import { renderMarkdownLine, type MarkdownState } from './markdown.js';
import { randomThinkingWord } from './thinking-words.js';
import type { Decision, PlanItem, PlanStatus } from './tools.js';
import type { Usage } from './types.js';

type Format = Parameters<typeof styleText>[0];
const paint = (format: Format, text: string): string => styleText(format, text);

const PLAN_ICON: Record<PlanStatus, string> = { pending: '○', in_progress: '◐', done: '●' };

type StreamState = {
  out: NodeJS.WritableStream;
  atLineStart: boolean;
  kind: 'text' | 'thinking' | null;
  pending: string;
  markdown: MarkdownState;
  showThinking: boolean;
};

export class UI implements AgentUI {
  private constructor(
    private readonly rl: readline.Interface,
    private readonly stream: StreamState,
    private readonly depth: number,
    private readonly label: string,
  ) {}

  static create(showThinking = false, out: NodeJS.WritableStream = process.stdout): UI {
    const rl = readline.createInterface({ input: process.stdin, output: out });
    return new UI(rl, { out, atLineStart: true, kind: null, pending: '', markdown: { inFence: false }, showThinking }, 0, '');
  }

  set showThinking(value: boolean) {
    this.stream.showThinking = value;
  }

  child(label: string): UI {
    return new UI(this.rl, this.stream, this.depth + 1, label);
  }

  private endStream(): void {
    if (this.stream.pending) {
      this.stream.out.write(`${renderMarkdownLine(this.stream.pending, this.stream.markdown)}\n`);
      this.stream.pending = '';
    } else if (!this.stream.atLineStart) this.stream.out.write('\n');
    this.stream.atLineStart = true;
    this.stream.kind = null;
    this.stream.markdown.inFence = false;
  }

  private write(kind: 'text' | 'thinking', delta: string): void {
    if (this.depth > 0 || !delta) return;
    if (this.stream.kind && this.stream.kind !== kind) this.endStream();
    this.stream.kind = kind;
    if (kind === 'thinking') {
      this.stream.out.write(paint(['gray', 'italic'], delta));
      this.stream.atLineStart = delta.endsWith('\n');
      return;
    }
    this.stream.pending += delta;
    let nl: number;
    while ((nl = this.stream.pending.indexOf('\n')) >= 0) {
      this.stream.out.write(`${renderMarkdownLine(this.stream.pending.slice(0, nl), this.stream.markdown)}\n`);
      this.stream.pending = this.stream.pending.slice(nl + 1);
    }
  }

  private line(text: string): void {
    this.endStream();
    const prefix = this.depth > 0 ? paint('magenta', `${'  '.repeat(this.depth - 1)}│ ${this.label} `) : '';
    this.stream.out.write(`${prefix + text}\n`);
  }

  readonly text = (delta: string): void => this.write('text', delta);
  readonly thinking = (delta: string): void => {
    if (this.stream.showThinking) return this.write('thinking', delta);
    if (this.depth > 0 || !delta || this.stream.kind === 'thinking') return;
    this.endStream();
    this.stream.out.write(paint(['gray', 'italic'], `✻ ${randomThinkingWord()}…`));
    this.stream.kind = 'thinking';
    this.stream.atLineStart = false;
  };

  banner(lines: string[]): void {
    this.line(paint(['bold', 'cyan'], 'TrackAI') + paint('gray', ' — agente de código autônomo'));
    for (const l of lines) this.line(paint('gray', `  ${l}`));
    this.line(paint('gray', '  /help para comandos · Ctrl+C interrompe a tarefa'));
  }

  tool(name: string, args: string): void {
    this.line(`${paint('cyan', `⚙ ${name}`)} ${paint('gray', args)}`);
  }

  observation(ok: boolean, output: string): void {
    const lines = output.trim().split('\n');
    const first = lines[0]?.slice(0, 160) ?? '';
    const more = lines.length > 1 ? paint('gray', ` (+${lines.length - 1} linhas)`) : '';
    this.line(`  ${ok ? paint('green', '✓') : paint('red', '✗')} ${paint('gray', first)}${more}`);
  }

  plan(items: PlanItem[]): void {
    this.line(paint('bold', 'Plano'));
    for (const item of items) {
      const color: Format = item.status === 'done' ? 'green' : item.status === 'in_progress' ? 'yellow' : 'gray';
      this.line(paint(color, `  ${PLAN_ICON[item.status]} ${item.step}`));
    }
  }

  phase(title: string): void {
    this.line(paint(['bold', 'yellow'], `\n━━ ${title} ━━`));
  }

  info(message: string): void {
    this.line(paint('blue', `ℹ ${message}`));
  }

  warn(message: string): void {
    this.line(paint('yellow', `! ${message}`));
  }

  error(message: string): void {
    this.line(paint('red', `✗ ${message}`));
  }

  final(text: string): void {
    this.endStream();
    const state: MarkdownState = { inFence: false };
    this.stream.out.write(`${`\n${text.split('\n').map((l) => renderMarkdownLine(l, state)).join('\n')}`}\n`);
  }

  usage(u: Usage, costUsd: number | null): void {
    const cost = costUsd === null ? 'custo desconhecido para este modelo' : costUsd === 0 ? 'custo US$ 0 (local)' : `~US$ ${costUsd.toFixed(4)}`;
    this.line(paint('gray', `tokens: ${u.input.toLocaleString('pt-BR')} entrada · ${u.output.toLocaleString('pt-BR')} saída · ${cost}`));
  }

  async confirm(question: string, signal: AbortSignal, alwaysLabel?: string): Promise<Decision> {
    this.endStream();
    const options = alwaysLabel ? `[s/N/t] ${paint('gray', `(t = sempre permitir ${alwaysLabel} nesta sessão)`)}` : '[s/N]';
    const answer = (await this.rl.question(`${paint('yellow', `? ${question}`)} ${options} `, { signal })).trim();
    if (alwaysLabel && /^(t|todos|sempre|a|always)$/i.test(answer)) return 'always';
    return /^(s|sim|y|yes)$/i.test(answer) ? 'yes' : 'no';
  }


  ask(prompt: string): Promise<string> {
    this.endStream();
    return this.rl.question(paint(['bold', 'cyan'], prompt));
  }

  onInterrupt(handler: () => void): void {
    this.rl.on('SIGINT', handler);
  }

  close(): void {
    this.rl.close();
  }
}
