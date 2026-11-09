const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'tree', 'pwd', 'echo', 'printf',
  'stat', 'file', 'du', 'df', 'which', 'whereis', 'type', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'basename',
  'dirname', 'realpath', 'readlink', 'date', 'nl', 'column', 'jq', 'true', 'false', 'test', '[', 'cd', 'less', 'more',
  'md5sum', 'sha1sum', 'sha256sum', 'xxd', 'hexdump', 'od', 'strings', 'uname', 'whoami', 'id', 'ps', 'free', 'uptime',
]);

const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'grep', 'describe', 'shortlog', 'reflog', 'cat-file', 'merge-base']);

const HARMLESS_REDIRECTS = /\s*(2>&1|[12]?>\s*\/dev\/null)/g;

export type ShellSegment = string[];

export function splitShell(command: string): ShellSegment[] | null {
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  const pushWord = () => {
    if (word) words.push(word);
    word = '';
  };
  const pushSegment = () => {
    pushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else if (quote === '"' && (c === '`' || (c === '$' && command[i + 1] === '('))) return null;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '\\' && i + 1 < command.length) word += command[++i];
    else if (c === '`' || c === '>' || c === '<' || (c === '$' && command[i + 1] === '(')) return null;
    else if (c === '|' || c === ';' || c === '&' || c === '\n') {
      if (c === '&' && command[i + 1] !== '&') return null;
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      pushSegment();
    } else if (/\s/.test(c)) pushWord();
    else word += c;
  }
  if (quote) return null;
  pushSegment();
  return segments;
}

function segmentIsReadOnly(words: string[]): boolean {
  const [program, ...args] = words;
  if (!program || /=/.test(program)) return false;
  if (program === 'git') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (sub === 'branch') return args.every((a) => ['branch', '-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes'].includes(a));
    return sub !== undefined && GIT_READ_ONLY.has(sub) && !args.some((a) => a === '--output' || a.startsWith('--output='));
  }
  if (program === 'sed') return args.includes('-n') && !args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place') || /(^|;)\s*[0-9,$]*\s*w\s/.test(a));
  if (program === 'find') return !args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(a));
  if (program === 'sort') return !args.some((a) => a === '-o' || a.startsWith('--output'));
  return READ_ONLY.has(program);
}

export function isReadOnlyCommand(command: string): boolean {
  const segments = splitShell(command.replace(HARMLESS_REDIRECTS, ''));
  return segments !== null && segments.length > 0 && segments.every(segmentIsReadOnly);
}

export function programOf(command: string): string {
  const segments = splitShell(command.replace(HARMLESS_REDIRECTS, '')) ?? [command.trim().split(/\s+/)];
  const main = segments.find((s) => s[0] !== 'cd') ?? segments[0] ?? [];
  const [program = 'bash', sub] = main;
  return ['npm', 'npx', 'pnpm', 'yarn', 'git', 'docker', 'cargo', 'go', 'python3', 'pip'].includes(program) && sub && !sub.startsWith('-') ? `${program} ${sub}` : program;
}
