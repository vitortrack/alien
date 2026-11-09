"""Repository map for TrackAI: files ranked by how well their path and exported
symbols match the request (content is left to grep/semantic_search, so files
that merely mention a word do not get promoted), plus which files import them. Python is parsed with ast, JS/TS
with regexes, SQL by its CREATE/ALTER TABLE statements. Standard library only.

usage: python3 repomap.py <root> <request> [budget_chars]
"""
import ast
import math
import os
import re
import subprocess
import sys
import unicodedata
from collections import defaultdict

JS = ('.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts')
TEXT = JS + ('.py', '.sql', '.vue', '.svelte', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.html', '.json', '.md', '.yml', '.yaml', '.toml')
IGNORED = re.compile(r'(^|/)(node_modules|dist|build|out|coverage|vendor|__pycache__|\.git|\.next|\.venv|venv)/|\.min\.js$|(^|/)package-lock\.json$')
MAX_FILES = 6000
MAX_BYTES = 200_000
STOP = set(
    'a o os as de do da dos das e em no na nos nas um uma para por com que se ao sem mais muito '
    'the and for with this that from into not all any ser esta este neste nesta isso essa esse '
    'deve precisa todas todos ficam fica novo nova novos novas adicione adicionar crie criar '
    'consegue pesquisar projeto quero preciso fazer faca pode'.split()
)

JS_EXPORT = re.compile(r'^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)', re.M)
JS_EXPORT_LIST = re.compile(r'^\s*export\s*\{([^}]*)\}', re.M)
CJS_EXPORT = re.compile(r'(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=')
JS_IMPORT = re.compile(r"""(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]""", re.M)
SQL_TABLE = re.compile(r'(?:create|alter)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?["`]?([\w.]+)', re.I)


def words(text):
    text = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode().lower()
    return {w[:5] for w in re.findall(r'[a-z0-9]{3,}', text) if w not in STOP}


def list_files(root):
    try:
        out = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root, capture_output=True, timeout=15).stdout
        files = [f for f in out.decode('utf8', 'replace').split('\0') if f]
    except (OSError, subprocess.SubprocessError):
        files = []
    if not files:
        for d, dirs, names in os.walk(root):
            dirs[:] = [x for x in dirs if not x.startswith('.') and not IGNORED.search(x + '/')]
            files += [os.path.relpath(os.path.join(d, n), root).replace(os.sep, '/') for n in names]
    return [f for f in files if f.endswith(TEXT) and not IGNORED.search(f)][:MAX_FILES]


def resolve_js(src, spec, fileset):
    if spec.startswith('@/') and '/src/' in '/' + src:
        base = ('/' + src)[1:('/' + src).index('/src/') + 4] + spec[2:]
    elif spec.startswith('.'):
        base = os.path.normpath(os.path.join(os.path.dirname(src), spec)).replace(os.sep, '/')
    else:
        return None
    stem = re.sub(r'\.[mc]?js$', '', base)
    for candidate in [base] + [stem + e for e in JS] + [base + '/index' + e for e in JS]:
        if candidate in fileset:
            return candidate
    return None


def resolve_py(src, module, level, fileset):
    parts = []
    if level:
        base = os.path.dirname(src)
        for _ in range(level - 1):
            base = os.path.dirname(base)
        parts = [base] if base else []
    rel = '/'.join(parts + (module.split('.') if module else []))
    for prefix in ('', 'src/'):
        for candidate in (prefix + rel + '.py', prefix + rel + '/__init__.py'):
            if candidate in fileset:
                return candidate
    return None


def analyze(path, text, fileset):
    symbols, imports = [], []
    if path.endswith('.py'):
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return symbols, imports
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and not node.name.startswith('_'):
                symbols.append(node.name)
            elif isinstance(node, ast.Assign):
                symbols += [t.id for t in node.targets if isinstance(t, ast.Name) and t.id.isupper()]
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports += [resolve_py(path, a.name, 0, fileset) for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                imports.append(resolve_py(path, node.module, node.level, fileset))
                imports += [resolve_py(path, f'{node.module}.{a.name}' if node.module else a.name, node.level, fileset) for a in node.names]
    elif path.endswith(JS):
        symbols = JS_EXPORT.findall(text) + CJS_EXPORT.findall(text)
        for group in JS_EXPORT_LIST.findall(text):
            symbols += [s.split(' as ')[-1].strip() for s in group.split(',') if s.strip()]
        imports = [resolve_js(path, next(g for g in m if g), fileset) for m in JS_IMPORT.findall(text)]
    elif path.endswith('.sql'):
        symbols = [f'table {t}' for t in dict.fromkeys(SQL_TABLE.findall(text))]
    return list(dict.fromkeys(symbols)), sorted({i for i in imports if i and i != path})


def main():
    root, request = sys.argv[1], sys.argv[2]
    budget = int(sys.argv[3]) if len(sys.argv) > 3 else 3500
    files = list_files(root)
    fileset = set(files)
    wanted = words(request)
    symbols, imported_by, score = {}, defaultdict(list), {}
    for f in files:
        try:
            with open(os.path.join(root, f), encoding='utf8') as fh:
                text = fh.read(MAX_BYTES)
        except (OSError, UnicodeDecodeError):
            continue
        symbols[f], imports = analyze(f, text, fileset)
        for target in imports:
            imported_by[target].append(f)
        named = len(wanted & (words(f) | words(' '.join(symbols[f]))))
        score[f] = 3 * named
    for f in score:
        score[f] += 0.5 * math.log1p(len(imported_by[f]))

    def describe(f):
        syms = symbols[f]
        line = f
        if syms:
            line += '  exports: ' + ', '.join(syms[:8]) + (f' (+{len(syms) - 8})' if len(syms) > 8 else '')
        users = imported_by[f]
        if f.endswith(JS + ('.py',)):
            line += f'  ← {len(users)}: ' + ', '.join(users[:3]) + (' …' if len(users) > 3 else '') if users else '  ← none'
        return line

    shown, used = [], 0
    for f in sorted(score, key=lambda f: (-score[f], f)):
        if score[f] <= 0:
            continue
        line = describe(f)
        if used + len(line) + 1 > budget:
            break
        shown.append(line)
        used += len(line) + 1
    listed = {line.split('  ')[0] for line in shown}
    rest = defaultdict(int)
    for f in score:
        if f not in listed:
            rest[os.path.dirname(f) or '.'] += 1
    print('Repository map (built by the harness; most relevant to the request first). "← N: files" = files that import it; "← none" = nothing in the repo imports it.')
    print('\n'.join(shown))
    if rest:
        other = sorted(rest.items(), key=lambda kv: -kv[1])
        print('Not listed: ' + ', '.join(f'{d}/ ({n})' for d, n in other[:25]) + (f', … {len(other) - 25} more dirs' if len(other) > 25 else ''))


if __name__ == '__main__':
    main()
