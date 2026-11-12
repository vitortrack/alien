import fs from 'node:fs';
import path from 'node:path';
import { managedSkillsDir, type Skill } from './skills.js';
import type { Provider, Usage } from './types.js';

export const SKILL_REVIEW_AFTER_STEPS = 10;
const NAME = /^[a-z0-9][a-z0-9-]{2,60}$/;
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export type ReviewInput = { turns: { task: string; answer: string }[]; task: string; trace: string[]; answer: string };
type Proposal = { name: string | null; description?: string; body?: string };

const SYSTEM = `You maintain the skill library of a coding agent. Review the session below and decide whether a skill should be created or updated.

Signals that warrant a skill update:
- The user corrected the agent's style, format, verbosity, workflow or sequence of steps (a later turn says what was wrong).
- A non-trivial technique, fix, workaround, debugging path or tool-usage pattern emerged that a future session would benefit from.
- An editable skill that applies here turned out to be wrong, incomplete or outdated.

Preference order: 1) update an EDITABLE skill that covers this class of task (rewrite its full body, keeping what is still valid); 2) create a new CLASS-LEVEL skill when none covers it. The name must describe a class of tasks (e.g. "nestjs-endpoint-changes"), never a ticket number, error string or today's task. Skills marked read-only belong to the project or the user: never reuse their names; if one of them is wrong, say so instead of saving.

Do not capture: secrets, one-off facts about this task, file contents, transcripts of errors (distill them to the rule), or anything the project instructions already say.

Reply with JSON only, no prose:
{"name": "<skill-name>", "description": "<when to use it, one sentence>", "body": "<full SKILL.md body in Markdown>"}
or {"name": null} when nothing is worth saving. Most smooth sessions without corrections or new techniques produce {"name": null}.`;

function prompt(input: ReviewInput, skills: Skill[]): string {
  const managed = managedSkillsDir();
  const listing = skills.map((s) => `- ${s.name} (${s.dir.startsWith(managed) ? 'editable' : 'read-only'}): ${s.description}`).join('\n') || '(none)';
  const editable = skills
    .filter((s) => s.dir.startsWith(managed))
    .map((s) => `<skill name="${s.name}">\n${clip(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'), 4000)}\n</skill>`)
    .join('\n');
  const turns = input.turns.slice(-6).map((t) => `<turn>\nUser: ${clip(t.task, 1000)}\nAgent: ${clip(t.answer, 1000)}\n</turn>`).join('\n');
  return [
    `<skills>\n${listing}\n</skills>`,
    editable && `<editable_skills>\n${editable}\n</editable_skills>`,
    turns && `<earlier_turns>\n${turns}\n</earlier_turns>`,
    `<task>\n${clip(input.task, 3000)}\n</task>`,
    `<tool_calls>\n${input.trace.slice(-40).join('\n')}\n</tool_calls>`,
    `<final_answer>\n${clip(input.answer, 1500)}\n</final_answer>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function parse(text: string): Proposal | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(json) as Proposal;
  } catch {
    return null;
  }
}

export function saveProposal(proposal: Proposal | null, skills: Skill[]): string | null {
  const { name, description, body } = proposal ?? {};
  if (!name || !description?.trim() || !body?.trim() || !NAME.test(name)) return null;
  const existing = skills.find((s) => s.name === name);
  if (existing && !existing.dir.startsWith(managedSkillsDir())) return null;
  const file = path.join(managedSkillsDir(), name, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description.replace(/\s+/g, ' ').trim()}\n---\n\n${body.trim()}\n`);
  return file;
}

export async function reviewSkills(provider: Provider, skills: Skill[], input: ReviewInput, signal: AbortSignal): Promise<{ usage: Usage; saved: string | null }> {
  provider.addUser(prompt(input, skills));
  const r = await provider.step({ system: SYSTEM, tools: [], signal, onText: () => undefined, onThinking: () => undefined });
  return { usage: r.usage, saved: saveProposal(parse(r.text), skills) };
}
