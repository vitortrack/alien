import { styleText } from 'node:util';

export type MarkdownState = { inFence: boolean };

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, code: string) => styleText('cyan', code))
    .replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => styleText('bold', bold))
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, (_, pre: string, em: string) => pre + styleText('italic', em));
}

export function renderMarkdownLine(line: string, state: MarkdownState): string {
  const fence = line.match(/^\s*```(\S*)/);
  if (fence) {
    state.inFence = !state.inFence;
    return styleText('gray', state.inFence ? `┌─ ${fence[1] || 'código'}` : '└─');
  }
  if (state.inFence) return styleText('gray', '│ ') + styleText('yellow', line);
  const heading = line.match(/^(#{1,6})\s+(.*)/);
  if (heading) return styleText(['bold', 'cyan'], inline(heading[2]!));
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return styleText('gray', '─'.repeat(40));
  const quote = line.match(/^\s*>\s?(.*)/);
  if (quote) return styleText('gray', '│ ') + styleText('italic', inline(quote[1]!));
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)/);
  if (bullet) return `${bullet[1]}${styleText('cyan', '•')} ${inline(bullet[2]!)}`;
  return inline(line);
}
