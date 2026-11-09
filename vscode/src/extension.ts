import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import type { AgentUI } from '../../src/agent-ui.js';
import { bestOf } from '../../src/attempts.js';
import { orchestrate } from '../../src/orchestrator.js';
import { DEFAULT_EMBED_MODEL, DEFAULT_MODEL, Session, type Config, type ProviderName } from '../../src/session.js';
import { SessionStore } from '../../src/sessions.js';
import { THINKING_WORDS } from '../../src/thinking-words.js';
import type { Decision, Mode, PlanItem } from '../../src/tools.js';

type Message = Record<string, unknown>;
type Post = (message: Message) => void;
type Pending = Map<string, (decision: Decision) => void>;

const STOP_PREFIXES = ['Interrompido', 'Limite', 'Orçamento', 'O modelo recusou'];

class WebviewUI implements AgentUI {
  constructor(
    private readonly post: Post,
    private readonly pending: Pending,
    private readonly agent = '',
  ) {}

  readonly text = (delta: string): void => {
    if (!this.agent && delta) this.post({ type: 'text', delta });
  };

  readonly thinking = (delta: string): void => {
    if (!this.agent && delta) this.post({ type: 'thinking' });
  };

  tool(name: string, args: string): void {
    this.post({ type: 'tool', agent: this.agent, name, args });
  }

  observation(ok: boolean, output: string): void {
    this.post({ type: 'observation', agent: this.agent, ok, output: output.slice(0, 6000) });
  }

  plan(items: PlanItem[]): void {
    this.post({ type: 'plan', items });
  }

  phase(title: string): void {
    this.post({ type: 'phase', title });
  }

  info(message: string): void {
    this.post({ type: 'info', agent: this.agent, message });
  }

  warn(message: string): void {
    this.post({ type: 'warn', agent: this.agent, message });
  }

  error(message: string): void {
    this.post({ type: 'error', message });
  }

  final(text: string): void {
    this.post({ type: 'final', text });
  }

  confirm(question: string, signal: AbortSignal, alwaysLabel?: string): Promise<Decision> {
    const id = randomUUID();
    this.post({ type: 'confirm', id, question, agent: this.agent, alwaysLabel: alwaysLabel ?? null });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.post({ type: 'confirmClosed', id });
        reject(new Error('Interrompido pelo usuário.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, (decision) => {
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        resolve(decision);
      });
    });
  }

  child(label: string): AgentUI {
    return new WebviewUI(this.post, this.pending, label);
  }
}

function readConfig(root: string): Config {
  const c = vscode.workspace.getConfiguration('trackai');
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const chosen = c.get<string>('provider', 'auto');
  const provider: ProviderName = chosen === 'ollama' || chosen === 'anthropic' ? chosen : hasKey ? 'anthropic' : 'ollama';
  process.env.OLLAMA_HOST = c.get<string>('ollamaHost', 'http://localhost:11434');
  return {
    provider,
    model: c.get<string>('model', '') || DEFAULT_MODEL[provider],
    mode: c.get<Mode>('mode', 'ask'),
    root,
    maxSteps: c.get<number>('maxSteps', 80),
    review: c.get<boolean>('review', true),
    effort: 'high',
    numCtx: 65536,
    embedModel: c.get<string>('embedModel', DEFAULT_EMBED_MODEL),
    tokenBudget: 0,
    lang: c.get<string>('lang', 'pt-BR'),
    interactive: true,
    logDir: Session.defaultLogDir(),
  };
}

const OPEN_SESSION = 'trackai.openSession';

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private session: Session | undefined;
  private readonly pending: Pending = new Map();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: vscode.Memento,
  ) {}

  private readonly post: Post = (message) => {
    void this.view?.webview.postMessage(message);
  };

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: Message) => void this.onMessage(m));
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomUUID().replace(/-/g, '');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>TrackAI</title>
</head>
<body>
<div id="status"></div>
<div id="plan" hidden></div>
<main id="messages">
  <div class="welcome">
    <h2>TrackAI</h2>
    <p>Pergunte sobre o código ou peça uma alteração. Ele investiga, altera, verifica e passa por um revisor independente.</p>
    <p class="hint">Enter envia · Shift+Enter quebra linha · referências <code>arquivo:linha</code> abrem no editor</p>
  </div>
</main>
<div id="working" hidden></div>
<form id="composer">
  <textarea id="input" rows="3" placeholder="Pergunte ou peça uma tarefa…"></textarea>
  <div class="actions">
    <label class="toggle"><input type="checkbox" id="orchestrate"> multiagente</label>
    <label class="toggle" title="Roda 3 tentativas isoladas e aplica a que passa nos testes com o menor diff (3× mais tokens)"><input type="checkbox" id="best3"> melhor de 3</label>
    <span class="spacer"></span>
    <button type="button" id="stop" hidden>Parar</button>
    <button type="submit" id="send">Enviar</button>
  </div>
</form>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  newChat(): void {
    this.session?.abort();
    this.session = undefined;
    void this.state.update(OPEN_SESSION, undefined);
    this.post({ type: 'cleared' });
  }

  private restore(root: string): void {
    const id = this.state.get<string>(OPEN_SESSION);
    if (!this.session && id) {
      const saved = new SessionStore(root).load(id);
      const session = saved && this.ensureSession();
      if (saved && session && session.resume(saved) !== null) this.session = undefined;
    }
    const session = this.session;
    if (session?.turns.length) this.post({ type: 'restored', id: session.id, turns: session.turns, plan: session.plan });
  }

  private ensureSession(): Session | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.post({ type: 'error', message: 'Abra uma pasta no VS Code para o TrackAI trabalhar nela.' });
      return null;
    }
    const cfg = readConfig(root);
    const current = this.session?.cfg;
    if (!this.session || current?.root !== root || current.provider !== cfg.provider || current.model !== cfg.model || current.embedModel !== cfg.embedModel) {
      this.session = new Session(cfg, new WebviewUI(this.post, this.pending));
    } else {
      Object.assign(this.session.cfg, { mode: cfg.mode, lang: cfg.lang, review: cfg.review, maxSteps: cfg.maxSteps });
    }
    return this.session;
  }

  private async onMessage(m: Message): Promise<void> {
    switch (m.type) {
      case 'ready': {
        this.post({ type: 'words', words: THINKING_WORDS });
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root) {
          const cfg = readConfig(root);
          this.post({ type: 'status', text: `${cfg.provider} · ${cfg.model} · ${cfg.mode}` });
          this.restore(root);
        }
        return;
      }
      case 'send':
        return this.send(String(m.text ?? ''), m.orchestrate === true, m.best3 === true);
      case 'stop':
        this.session?.abort();
        return;
      case 'confirmResult':
        this.pending.get(String(m.id))?.(m.decision === 'always' ? 'always' : m.decision === 'yes' ? 'yes' : 'no');
        return;
      case 'open':
        return this.open(String(m.file), Number(m.line));
      case 'newChat':
        this.newChat();
        return;
    }
  }

  private async send(text: string, viaOrchestrator: boolean, best3: boolean): Promise<void> {
    const task = text.trim();
    if (!task) return;
    const session = this.ensureSession();
    if (!session) return;
    if (session.busy) {
      this.post({ type: 'warn', message: 'Aguarde a tarefa atual terminar ou clique em Parar.' });
      return;
    }
    this.post({ type: 'status', text: `${session.cfg.provider} · ${session.cfg.model} · ${session.cfg.mode}` });
    this.post({ type: 'busy', value: true });
    try {
      let out: string;
      if (viaOrchestrator) out = await orchestrate(session, task);
      else if (best3) {
        const result = await session.track(() => bestOf(session.cfg, session.ui, task, 3, undefined, session.signal));
        session.addUsage(result.usage);
        out = result.answer;
      } else {
        out = await session.run(task);
        void this.state.update(OPEN_SESSION, session.id);
      }
      if (STOP_PREFIXES.some((p) => out.startsWith(p))) this.post({ type: 'warn', message: out });
      else this.post({ type: 'answer', text: out });
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      const cost = session.costUsd();
      this.post({ type: 'usage', input: session.usage.input, output: session.usage.output, cost });
      this.post({ type: 'busy', value: false });
    }
  }

  private async open(file: string, line: number): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const target = path.resolve(root, file);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const position = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position), preview: true });
    } catch {
      const matches = await vscode.workspace.findFiles(`**/${file}`, '**/node_modules/**', 1);
      const found = matches[0];
      if (!found) {
        void vscode.window.showWarningMessage(`TrackAI: arquivo ${file} não encontrado no workspace.`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(found);
      const position = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position), preview: true });
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri, context.workspaceState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('trackai.chat', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('trackai.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('trackai.focus', () => vscode.commands.executeCommand('trackai.chat.focus')),
  );
}

export function deactivate(): void {}
