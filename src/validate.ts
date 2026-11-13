import type { Input, ToolSpec } from './types.js';

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

const WRAPPERS = ['parameters', 'arguments', 'input'];

function parsed(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export type Validation = { error: string | null; ignored: string[] };

export function validateInput(spec: ToolSpec, input: unknown): Validation {
  const ignored: string[] = [];
  const fail = (error: string): Validation => ({ error, ignored });
  if (typeOf(input) !== 'object') return fail('arguments must be a JSON object');
  const obj = input as Input;
  const wrapped = WRAPPERS.map((k) => parsed(obj[k])).find((v): v is Input => typeOf(v) === 'object' && spec.schema.required.every((r) => (v as Input)[r] !== undefined));
  if (wrapped && spec.schema.required.some((r) => obj[r] === undefined)) {
    for (const key of Object.keys(obj)) delete obj[key];
    Object.assign(obj, wrapped);
  }
  for (const key of spec.schema.required) {
    if (obj[key] === undefined) return fail(`missing required field "${key}"`);
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = spec.schema.properties[key];
    if (!prop) {
      ignored.push(key);
      delete obj[key];
      continue;
    }
    if (value === undefined || value === null) {
      delete obj[key];
      continue;
    }
    const numeric = prop.type === 'integer' || prop.type === 'number';
    if (numeric && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      obj[key] = Number(value);
    }
    if (prop.type === 'boolean' && (value === 'true' || value === 'false')) obj[key] = value === 'true';
    if ((prop.type === 'array' || prop.type === 'object') && typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeOf(parsed) === prop.type) obj[key] = parsed;
      } catch {
        // keep the string; the type check below reports it
      }
    }
    const want = numeric ? 'number' : prop.type;
    const got = typeOf(obj[key]);
    if (got !== want) return fail(`field "${key}" must be ${prop.type}, got ${got}`);
    if (prop.type === 'integer' && !Number.isInteger(obj[key])) return fail(`field "${key}" must be an integer`);
    if (prop.enum && !prop.enum.includes(obj[key] as string)) return fail(`field "${key}" must be one of: ${prop.enum.join(', ')}`);
  }
  return { error: null, ignored };
}
