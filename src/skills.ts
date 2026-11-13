import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alienHome } from './paths.js';

export type Skill = { name: string; description: string; dir: string; tools: string[] };

const MAX_DESCRIPTION = 300;

export const managedSkillsDir = (): string => path.join(alienHome(), 'skills');

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

const subdirs = (base: string): string[] => {
  try {
    return fs.readdirSync(base).sort().map((entry) => path.join(base, entry));
  } catch {
    return [];
  }
};

function pluginSkills(): Array<{ dir: string; prefix: string }> {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    return Object.entries(installed.plugins ?? {}).flatMap(([id, entries]) => {
      const root = entries[0]?.installPath;
      if (!root) return [];
      const prefix = `${id.split('@')[0]}:`;
      let listed: string[] | undefined;
      try {
        listed = (JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')) as { skills?: string[] }).skills;
      } catch {
        listed = undefined;
      }
      const dirs = Array.isArray(listed) ? listed.map((d) => path.join(root, d)) : subdirs(path.join(root, 'skills'));
      return dirs.map((dir) => ({ dir, prefix }));
    });
  } catch {
    return [];
  }
}

function skillCandidates(root: string): Array<{ dir: string; prefix: string }> {
  const bases = [path.join(root, '.claude', 'skills'), path.join(root, '.agents', 'skills')];
  const user = process.env.ALIEN_USER_SKILLS === 'off' ? [] : [path.join(os.homedir(), '.claude', 'skills'), managedSkillsDir()];
  return [...[...bases, ...user].flatMap((base) => subdirs(base).map((dir) => ({ dir, prefix: '' }))), ...(user.length ? pluginSkills() : [])];
}

export function findSkills(root: string): Skill[] {
  const found = new Map<string, Skill>();
  for (const { dir, prefix } of skillCandidates(root)) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const { fields } = frontmatter(text);
    const name = prefix + (fields.name || path.basename(dir));
    if (!found.has(name) && fields.description) found.set(name, { name, description: fields.description.slice(0, MAX_DESCRIPTION), dir, tools: (fields['allowed-tools'] ?? '').split(/[\s,]+/).filter(Boolean) });
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
  const others = (fs.readdirSync(skill.dir, { recursive: true }) as string[]).filter((f) => f !== 'SKILL.md' && !f.split(path.sep).includes('node_modules') && fs.statSync(path.join(skill.dir, f)).isFile());
  const listing = others.length ? `\n\n[Other files in this skill (read them with skill name="${name}" file="<path>"): ${others.slice(0, 40).join(', ')}]` : '';
  return `${body.trim()}${listing}`;
}

export function skillCommand(skills: Skill[], active: Set<string>, text: string): string | null {
  const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !skills.some((s) => s.name === m[1])) return null;
  const name = m[1]!;
  const rest = m[2]?.trim() ?? '';
  if (rest === 'off') {
    active.delete(name);
    return `The skill "${name}" was turned off. Stop following it and confirm in one line.`;
  }
  active.add(name);
  return rest || `The skill "${name}" is now active. Confirm in one line and follow it from now on.`;
}

export function activeSkillsBlock(skills: Skill[], active: Set<string>): string {
  const on = skills.filter((s) => active.has(s.name));
  if (!on.length) return '';
  return `<active_skills>\nThe user turned these skills on for this conversation. Follow them in every step, also after the context is compacted.\n${on.map((s) => `<skill name="${s.name}">\n${readSkill(skills, s.name)}\n</skill>`).join('\n')}\n</active_skills>`;
}
