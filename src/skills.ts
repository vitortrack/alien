import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackaiHome } from './paths.js';

export type Skill = { name: string; description: string; dir: string; tools: string[] };

const MAX_DESCRIPTION = 300;

export const managedSkillsDir = (): string => path.join(trackaiHome(), 'skills');

export function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let k = 0; k < lines.length; k++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[k]!);
    if (!m) continue;
    let value = m[2]!.trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      while (k + 1 < lines.length && (/^\s+\S/.test(lines[k + 1]!) || lines[k + 1]!.trim() === '')) block.push(lines[++k]!.trim());
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    }
    fields[m[1]!] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return { fields, body: text.slice(match[0].length) };
}

function skillDirs(root: string): string[] {
  const dirs = [path.join(root, '.claude', 'skills'), path.join(root, '.agents', 'skills')];
  if (process.env.TRACKAI_USER_SKILLS !== 'off') dirs.push(path.join(os.homedir(), '.claude', 'skills'), managedSkillsDir());
  return dirs;
}

export function findSkills(root: string): Skill[] {
  const found = new Map<string, Skill>();
  for (const base of skillDirs(root)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const dir = path.join(base, entry);
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      const { fields } = frontmatter(text);
      const name = fields.name || entry;
      if (!found.has(name) && fields.description) found.set(name, { name, description: fields.description.slice(0, MAX_DESCRIPTION), dir, tools: (fields['allowed-tools'] ?? '').split(/[\s,]+/).filter(Boolean) });
    }
  }
  return [...found.values()];
}

export function readSkill(skills: Skill[], name: string, file?: string): string {
  const skill = skills.find((s) => s.name === name);
  if (!skill) throw new Error(`No skill named "${name}". Available: ${skills.map((s) => s.name).join(', ') || 'none'}.`);
  if (file) {
    const target = path.resolve(skill.dir, file);
    if (!target.startsWith(skill.dir + path.sep)) throw new Error('The file must be inside the skill folder.');
    return fs.readFileSync(target, 'utf8');
  }
  const { body } = frontmatter(fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8'));
  const others = (fs.readdirSync(skill.dir, { recursive: true }) as string[]).filter((f) => f !== 'SKILL.md' && fs.statSync(path.join(skill.dir, f)).isFile());
  const listing = others.length ? `\n\n[Other files in this skill (read them with skill name="${name}" file="<path>"): ${others.slice(0, 40).join(', ')}]` : '';
  return `${body.trim()}${listing}`;
}
