export type EditResult =
  | { ok: true; content: string; firstLine: number; lastLine: number; strategy: string; count: number }
  | { ok: false; error: string };

type Normalizer = { name: string; norm: (line: string) => string; reindent: boolean };

const UNICODE: [RegExp, string][] = [
  [/[‘’‛′]/g, "'"],
  [/[“”″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/[  -​ ]/g, ' '],
  [/…/g, '...'],
];

const ascii = (s: string): string => UNICODE.reduce((acc, [re, to]) => acc.replace(re, to), s);

const NORMALIZERS: Normalizer[] = [
  { name: 'ignoring trailing whitespace', norm: (l) => l.trimEnd(), reindent: false },
  { name: 'ignoring indentation', norm: (l) => l.trim(), reindent: true },
  { name: 'normalizing unicode punctuation', norm: (l) => ascii(l).trim(), reindent: true },
];

const indentOf = (line: string): string => line.match(/^\s*/)![0];

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function exactPositions(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) found.push(i);
  return found;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]!.trim()) start++;
  while (end > start && !lines[end - 1]!.trim()) end--;
  return lines.slice(start, end);
}

function indentUnit(lines: string[]): string | null {
  const indents = lines.filter((l) => l.trim()).map(indentOf);
  let unit: string | null = null;
  for (const a of indents) {
    for (const b of indents) {
      if (b.length > a.length && b.startsWith(a)) {
        const step = b.slice(a.length);
        if (!unit || step.length < unit.length) unit = step;
      }
    }
  }
  return unit;
}

function reindent(newLines: string[], oldLines: string[], actualLines: string[]): string[] {
  const oldBase = indentOf(oldLines.find((l) => l.trim()) ?? '');
  const actualBase = indentOf(actualLines.find((l) => l.trim()) ?? '');
  const oldUnit = indentUnit(oldLines) ?? indentUnit(newLines);
  const actualUnit = indentUnit(actualLines) ?? (actualBase.includes('\t') ? '\t' : oldUnit);
  return newLines.map((line) => {
    if (!line.trim()) return line;
    const indent = indentOf(line);
    if (!indent.startsWith(oldBase)) return actualBase + line.trimStart();
    const extra = indent.slice(oldBase.length);
    if (!oldUnit || !actualUnit || oldUnit === actualUnit) return actualBase + extra + line.trimStart();
    let levels = 0;
    let rest = extra;
    while (rest.startsWith(oldUnit)) {
      rest = rest.slice(oldUnit.length);
      levels++;
    }
    return actualBase + actualUnit.repeat(levels) + rest + line.trimStart();
  });
}

function bigrams(s: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    map.set(g, (map.get(g) ?? 0) + 1);
  }
  return map;
}

export function similarity(a: string, b: string): number {
  const x = a.replace(/\s+/g, ' ').trim();
  const y = b.replace(/\s+/g, ' ').trim();
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  const gx = bigrams(x);
  const gy = bigrams(y);
  let overlap = 0;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0);
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

function closestHint(lines: string[], oldLines: string[]): string {
  const n = Math.min(Math.max(oldLines.length, 1), 60);
  const target = oldLines.join('\n');
  let best = { score: 0, at: -1 };
  for (let i = 0; i + n <= lines.length && i < 20_000; i++) {
    const score = similarity(lines.slice(i, i + n).join('\n'), target);
    if (score > best.score) best = { score, at: i };
  }
  if (best.score < 0.6) return '';
  const shown = lines
    .slice(best.at, best.at + n)
    .map((l, k) => `${String(best.at + k + 1).padStart(5)}\t${l}`)
    .join('\n');
  return `\nDid you mean these lines (${Math.round(best.score * 100)}% similar)?\n${shown}`;
}

export function applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): EditResult {
  const crlf = content.includes('\r\n') && !/(^|[^\r])\n/.test(content);
  const text = crlf ? content.replace(/\r\n/g, '\n') : content;
  const oldStr = oldString.replace(/\r\n/g, '\n');
  const newStr = newString.replace(/\r\n/g, '\n');
  const finish = (updated: string, firstLine: number, lastLine: number, strategy: string, count: number): EditResult => ({
    ok: true,
    content: crlf ? updated.replace(/\n/g, '\r\n') : updated,
    firstLine,
    lastLine,
    strategy,
    count,
  });

  if (!oldStr) return { ok: false, error: 'old_string is empty. Use write_file to create a file.' };
  if (oldStr === newStr) return { ok: false, error: 'old_string and new_string are identical; nothing to change.' };

  const positions = exactPositions(text, oldStr);
  if (positions.length > 1 && !replaceAll) {
    const lines = positions.map((p) => lineOf(text, p)).join(', ');
    return {
      ok: false,
      error: `old_string matches ${positions.length} places (lines ${lines}). Include more surrounding lines so it identifies exactly one place, or set replace_all=true to change all of them.`,
    };
  }
  if (positions.length) {
    const first = lineOf(text, positions[0]!);
    const updated = replaceAll ? text.split(oldStr).join(newStr) : text.slice(0, positions[0]) + newStr + text.slice(positions[0]! + oldStr.length);
    const last = lineOf(updated, (replaceAll ? updated.lastIndexOf(newStr) : positions[0]!) + newStr.length);
    return finish(updated, first, last, 'exact', replaceAll ? positions.length : 1);
  }

  const lines = text.split('\n');
  const oldLines = trimBlankEdges(oldStr.split('\n'));
  if (oldLines.length) {
    for (const { name, norm, reindent: fix } of NORMALIZERS) {
      const wanted = oldLines.map(norm);
      const hits: number[] = [];
      for (let i = 0; i + wanted.length <= lines.length; i++) {
        let same = true;
        for (let j = 0; j < wanted.length && same; j++) same = norm(lines[i + j]!) === wanted[j];
        if (same) hits.push(i);
      }
      if (hits.length > 1 && !replaceAll) {
        return {
          ok: false,
          error: `old_string matches ${hits.length} places when ${name} (lines ${hits.map((h) => h + 1).join(', ')}). Include more surrounding lines so it identifies exactly one place.`,
        };
      }
      if (!hits.length) continue;
      let newLines = trimBlankEdges(newStr.split('\n'));
      const out = [...lines];
      for (const at of [...hits].reverse()) {
        const replacement = fix ? reindent(newLines, oldLines, lines.slice(at, at + oldLines.length)) : newLines;
        out.splice(at, oldLines.length, ...replacement);
        newLines = trimBlankEdges(newStr.split('\n'));
      }
      const first = hits[0]! + 1;
      return finish(out.join('\n'), first, first + Math.max(newLines.length, 1) - 1, name, hits.length);
    }
  }

  const already = newStr.trim() && text.includes(newStr) ? '\nNote: new_string already exists in the file — the change may already be applied.' : '';
  return {
    ok: false,
    error: `old_string was not found, even ignoring whitespace and unicode punctuation. Re-read the exact lines with read_file and copy them verbatim.${closestHint(lines, oldLines)}${already}`,
  };
}

export function snippet(content: string, firstLine: number, lastLine: number, context = 4): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const from = Math.max(1, firstLine - context);
  const to = Math.min(lines.length, lastLine + context);
  return lines
    .slice(from - 1, to)
    .map((l, k) => `${String(from + k).padStart(5)}\t${l}`)
    .join('\n');
}
