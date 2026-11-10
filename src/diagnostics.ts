import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

type Diagnostic = { file?: { fileName: string; getLineAndCharacterOfPosition(p: number): { line: number; character: number } }; start?: number; code: number; category: number; messageText: unknown };
type LanguageService = { getSyntacticDiagnostics(f: string): Diagnostic[]; getSemanticDiagnostics(f: string): Diagnostic[] };
type Ts = {
  sys: { useCaseSensitiveFileNames: boolean; readFile(p: string): string | undefined; fileExists(p: string): boolean; readDirectory: unknown; directoryExists: unknown; getDirectories: unknown; realpath?: unknown };
  getParsedCommandLineOfConfigFile(p: string, o: object, host: object): { fileNames: string[]; options: object } | undefined;
  createLanguageService(host: object, registry: unknown): LanguageService;
  createDocumentRegistry(): unknown;
  getDefaultLibFilePath(o: object): string;
  flattenDiagnosticMessageText(m: unknown, nl: string): string;
  ScriptSnapshot: { fromString(s: string): unknown };
  DiagnosticCategory: { Error: number };
};

const MAX_REPORTED = 8;
const RELIABLE_WITHOUT_TYPES = new Set([2300, 2304, 2448, 2451, 2454, 2552, 6133, 6192, 6196, 6198]);
const UNUSED = new Set([6133, 6192, 6196, 6198]);
const isReliable = (code: number): boolean => code < 2000 || RELIABLE_WITHOUT_TYPES.has(code);
const services = new Map<string, { ts: Ts; ls: LanguageService; files: () => string[]; checking: { file: string } } | null>();

function nearestConfig(root: string, file: string): string | null {
  for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) break;
  }
  return null;
}

function service(config: string) {
  if (services.has(config)) return services.get(config)!;
  let created = null;
  try {
    const ts = createRequire(config)('typescript') as Ts;
    const parse = () => ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    const options = { ...parse()?.options, skipLibCheck: true, noEmit: true };
    const checking = { file: '' };
    const files = () => parse()?.fileNames ?? [];
    const mtime = (f: string) => {
      try {
        const st = fs.statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '0';
      }
    };
    const host = {
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getCompilationSettings: () => options,
      getScriptFileNames: () => [checking.file],
      resolveModuleNames: (names: string[]) => names.map(() => undefined),
      getScriptVersion: mtime,
      getScriptSnapshot: (f: string) => {
        const text = ts.sys.readFile(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => path.dirname(config),
      getDefaultLibFileName: (o: object) => ts.getDefaultLibFilePath(o),
    };
    created = { ts, ls: ts.createLanguageService(host, ts.createDocumentRegistry()), files, checking };
  } catch {
    created = null;
  }
  services.set(config, created);
  return created;
}

export interface TypeError {
  key: string;
  line: string;
  blocking: boolean;
}

export function typeErrors(root: string, relative: string): TypeError[] {
  if (!/\.(ts|tsx|mts|cts)$/.test(relative) || relative.endsWith('.d.ts')) return [];
  const file = path.resolve(root, relative);
  const config = nearestConfig(path.resolve(root), file);
  const svc = config && service(config);
  if (!svc || !svc.files().includes(file)) return [];
  svc.checking.file = file;
  return [...svc.ls.getSyntacticDiagnostics(file), ...svc.ls.getSemanticDiagnostics(file)]
    .filter((d) => d.category === svc.ts.DiagnosticCategory.Error && isReliable(d.code))
    .map((d) => {
      const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      const key = `TS${d.code}: ${svc.ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
      return { key, line: `${relative}${at ? `:${at.line + 1}:${at.character + 1}` : ''} ${key}`, blocking: !UNUSED.has(d.code) };
    });
}

export function formatErrors(errors: TypeError[]): string {
  const more = errors.length > MAX_REPORTED ? `\n… and ${errors.length - MAX_REPORTED} more` : '';
  return `${errors.slice(0, MAX_REPORTED).map((e) => e.line).join('\n')}${more}`;
}

export function typeDiagnostics(root: string, relative: string): string {
  const errors = typeErrors(root, relative);
  return errors.length ? `[diagnostics] The type checker (this file only, imports not resolved) reports ${errors.length} error(s) in this file after your edit:\n${formatErrors(errors)}` : '';
}
