// Zero-dependency code index: definitions per file with line ranges, kept in
// <repo>/.tokenmiser/index.json and refreshed incrementally (mtime + size).
// Lets an agent answer "where is X / what's in this file" in one call instead of
// a chain of grep + view round trips.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 4;
const MAX_FILE_BYTES = 1_000_000;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|target|vendor|coverage|\.next|\.venv|venv|__pycache__|\.tokenmiser)\//;
const SKIP_FILES = /\.(min\.(js|css)|map|lock|snap)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

const EXT = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js',
  py: 'py', pyi: 'py',
  go: 'go',
  rs: 'rs',
  java: 'java', kt: 'java', kts: 'java', cs: 'java', scala: 'java', swift: 'java', dart: 'java',
  rb: 'rb',
  php: 'php',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', m: 'c', mm: 'c',
  md: 'md', mdx: 'md',
};

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'new', 'await', 'typeof', 'sizeof', 'elif', 'when', 'match', 'super', 'this', 'constructor']);

// [regex, kind, nameGroup]. Group 1 is always the leading indentation.
const PATTERNS = {
  js: [
    [/^(\s*)(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class', 2],
    [/^(\s*)(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface', 2],
    [/^(\s*)(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, 'type', 2],
    [/^(\s*)(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum', 2],
    [/^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function', 2],
    [/^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'function', 2],
    [/^(\s+)(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^{]+)?\{\s*$/, 'method', 2],
  ],
  py: [
    [/^(\s*)class\s+([A-Za-z_]\w*)/, 'class', 2],
    [/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function', 2],
  ],
  go: [
    [/^()func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, 'method', 2],
    [/^()func\s+([A-Za-z_]\w*)/, 'function', 2],
    [/^()type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, 'type', 2],
    [/^()type\s+([A-Za-z_]\w*)\s/, 'type', 2],
  ],
  rs: [
    [/^(\s*)(?:pub(?:\([\w:]+\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"\w+"\s+)?fn\s+([A-Za-z_]\w*)/, 'function', 2],
    [/^(\s*)(?:pub(?:\([\w:]+\))?\s+)?(struct|enum|trait|union)\s+([A-Za-z_]\w*)/, 'type', 3],
    [/^(\s*)(?:pub(?:\([\w:]+\))?\s+)?mod\s+([A-Za-z_]\w*)/, 'module', 2],
    [/^(\s*)impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)/, 'impl', 2],
  ],
  java: [
    [/^(\s*)(?:[\w@]+\s+)*(?:class|interface|enum|record|object|struct|protocol|extension|mixin)\s+([A-Za-z_]\w*)/, 'class', 2],
    [/^(\s*)(?:[\w@]+\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/, 'method', 2],
    [/^(\s*)(?:[\w@]+\s+)*func\s+([A-Za-z_]\w*)/, 'method', 2],
    [/^(\s*)(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|sealed|open|partial|extern)\s+)+[\w<>\[\],.? ]+?\s+([A-Za-z_]\w*)\s*\([^;]*$/, 'method', 2],
  ],
  rb: [
    [/^(\s*)(?:class|module)\s+([A-Z][\w:]*)/, 'class', 2],
    [/^(\s*)def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, 'method', 2],
  ],
  php: [
    [/^(\s*)(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, 'class', 2],
    [/^(\s*)(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)/, 'function', 2],
  ],
  c: [
    [/^()(?:typedef\s+)?(?:struct|class|enum|union)\s+([A-Za-z_]\w*)\s*(?::[^{]*)?\{?\s*$/, 'type', 2],
    [/^()#define\s+([A-Za-z_]\w*)/, 'macro', 2],
    [/^()(?:[\w:*&<>,]+\s+)+\**&?([A-Za-z_][\w:~]*)\s*\([^;]*$/, 'function', 2],
  ],
  md: [[/^()(#{1,3})\s+(.+?)\s*#*$/, 'heading', 3]],
};

export function langOf(file) {
  return EXT[path.extname(file).slice(1).toLowerCase()] ?? null;
}

export function extractSymbols(text, lang) {
  const pats = PATTERNS[lang];
  if (!pats) return [];
  const lines = text.split(/\r?\n/);
  const syms = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lang === 'md' && /^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || line.length > 400) continue;
    for (const [re, kind, g] of pats) {
      const m = line.match(re);
      if (!m) continue;
      const name = m[g];
      if (!name || CONTROL.has(name)) continue;
      const indent = lang === 'md' ? m[2].length - 1 : m[1].replace(/\t/g, '    ').length;
      syms.push({ name, kind, line: i + 1, indent, sig: signature(lines, i, lang) });
      break;
    }
  }
  // End line = just before the next symbol at the same or shallower depth.
  for (let k = 0; k < syms.length; k++) {
    let end = lines.length;
    for (let j = k + 1; j < syms.length; j++) {
      if (syms[j].indent <= syms[k].indent) {
        end = syms[j].line - 1;
        break;
      }
    }
    // Python blocks end at the first line that dedents to the definition's own level
    // (skipping the signature's continuation lines, blank lines and comments).
    if (lang === 'py') {
      let body = syms[k].line; // 0-based index of the line after the def line
      let depth = 0;
      for (let j = syms[k].line - 1; j < end; j++) {
        depth += (lines[j].match(/[([{]/g) ?? []).length - (lines[j].match(/[)\]}]/g) ?? []).length;
        if (depth <= 0) {
          body = j + 1;
          break;
        }
      }
      for (let j = body; j < end; j++) {
        const l = lines[j];
        if (!l.trim() || /^\s*#/.test(l)) continue;
        if (l.match(/^\s*/)[0].replace(/\t/g, '    ').length <= syms[k].indent) {
          end = j;
          break;
        }
      }
    }
    // Trailing blank lines and the next symbol's doc comment don't belong to this one.
    // Also drop the enclosing scope's closing lines (`}`, `end`), which sit at a shallower indent.
    const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    while (
      end > syms[k].line &&
      (/^\s*($|\/\/|\/\*|\*|#(?!\s*(include|define|if|endif))|@\w)/.test(lines[end - 1] ?? '') || (lang !== 'md' && indentOf(lines[end - 1]) < syms[k].indent))
    )
      end--;
    syms[k].end = end;
  }
  // Qualify nested symbols with their container: "App.add_url_rule".
  for (let k = 0; k < syms.length; k++) {
    for (let j = k - 1; j >= 0; j--) {
      if (syms[j].indent < syms[k].indent && syms[j].end >= syms[k].line) {
        if (lang !== 'md') syms[k].qname = `${syms[j].qname ?? syms[j].name}.${syms[k].name}`;
        break;
      }
    }
  }
  return syms;
}

// One-line signature; joins continuation lines of multi-line parameter lists.
function signature(lines, i, lang) {
  let sig = lines[i].trim();
  if (lang !== 'md') {
    let depth = (sig.match(/\(/g) ?? []).length - (sig.match(/\)/g) ?? []).length;
    for (let j = i + 1; depth > 0 && j < Math.min(lines.length, i + 12); j++) {
      const t = lines[j].trim();
      sig += (sig.endsWith('(') ? '' : ' ') + t;
      depth += (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
    }
  }
  sig = sig.replace(/\s*\{\s*$/, '').replace(/,\s*\)/, ')').replace(/\s+/g, ' ');
  return sig.length > 140 ? sig.slice(0, 139) + '…' : sig;
}

export function repoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    try {
      return fs.realpathSync.native(cwd);
    } catch {
      return path.resolve(cwd);
    }
  }
}

function listFiles(root) {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean);
  } catch {
    files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.test(rel + '/') && files.length < 50_000) walk(rel);
        } else files.push(rel);
      }
    };
    walk('');
  }
  return files.filter((f) => langOf(f) && !SKIP_DIRS.test(f) && !SKIP_FILES.test(f));
}

function indexPath(root) {
  return path.join(root, '.tokenmiser', 'index.json');
}

/** Load the index for the repo containing `cwd`, refreshing only changed files. */
export function loadIndex(cwd, { rebuild = false } = {}) {
  const root = repoRoot(cwd);
  let old = { files: {} };
  if (!rebuild) {
    try {
      old = JSON.parse(fs.readFileSync(indexPath(root), 'utf8'));
      if (old.version !== VERSION) old = { files: {} };
    } catch {}
  }
  const files = {};
  let changed = 0;
  for (const rel of listFiles(root)) {
    let st;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    const prev = old.files[rel];
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
      files[rel] = prev;
      continue;
    }
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const lang = langOf(rel);
    files[rel] = {
      mtime: st.mtimeMs,
      size: st.size,
      lines: text.split('\n').length,
      symbols: extractSymbols(text, lang).map((s) => [s.name, s.kind, s.line, s.end, s.indent, s.sig, s.qname ?? s.name]),
      imports: lang === 'md' ? [] : importsOf(text),
    };
    changed++;
  }
  const removed = Object.keys(old.files).some((f) => !files[f]);
  const index = { version: VERSION, root, files };
  if (changed || removed) {
    try {
      fs.mkdirSync(path.dirname(indexPath(root)), { recursive: true });
      const ignore = path.join(root, '.tokenmiser', '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
      fs.writeFileSync(indexPath(root), JSON.stringify(index));
    } catch {}
  }
  index.changed = changed;
  return index;
}

// Module specifiers a file imports, reduced to their last one or two path segments
// ("django.db.models" -> "db/models", "./money" -> "money").
function importsOf(text) {
  const out = new Set();
  const re = /(?:import\s[^'"]*?from\s*|import\s*\(?\s*|require\s*\(\s*|^\s*from\s+|^\s*import\s+|#include\s*[<"]|\buse\s+)['"]?([\w@./:-]+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const segs = m[1]
      .replace(/['">;)]+$/, '')
      .replace(/\.(m?[jt]sx?|py|h|hpp|rb|php)$/, '')
      .split(/[/:.]+/)
      .filter((x) => x && x !== '@');
    if (segs.length && segs[segs.length - 1].length > 1) out.add(segs.slice(-2).join('/'));
  }
  return [...out].slice(0, 200);
}

// The import keys under which other files would refer to this one.
function moduleKeys(file) {
  const parts = file.replace(/\.\w+$/, '').split('/');
  if (/^(index|__init__|mod|main)$/.test(parts[parts.length - 1]) && parts.length > 1) parts.pop();
  const base = parts[parts.length - 1];
  return { two: parts.slice(-2).join('/'), one: base };
}

const sym = (t) => ({ name: t[0], kind: t[1], line: t[2], end: t[3], indent: t[4], sig: t[5], qname: t[6] ?? t[0] });

// ------------------------------------------------------------------ queries

export function findSymbol(index, query, limit = 20) {
  const q = query.toLowerCase();
  const hits = [];
  for (const [file, f] of Object.entries(index.files)) {
    for (const t of f.symbols) {
      if (t[1] === 'heading') continue;
      const n = t[0].toLowerCase();
      const qn = (t[6] ?? t[0]).toLowerCase();
      // "App.add_url_rule" matches qualified names; plain names match the symbol itself.
      const score = t[0] === query || t[6] === query ? 0 : n === q || qn === q ? 1 : qn.endsWith('.' + q) ? 1 : n.startsWith(q) ? 2 : qn.includes(q) ? 3 : -1;
      if (score >= 0) hits.push({ file, score, ...sym(t) });
    }
  }
  hits.sort((a, b) => a.score - b.score || /test|spec/i.test(a.file) - /test|spec/i.test(b.file) || a.file.localeCompare(b.file));
  const top = hits.length ? Math.min(hits[0].score, 2) : 0;
  const best = top <= 1 ? hits.filter((h) => h.score === top) : hits;
  return { total: best.length, hits: best.slice(0, limit) };
}

export function formatSymbols({ total, hits }, query) {
  if (!hits.length) return `No definition matching "${query}" in the index. Try: tokenmiser refs ${query}`;
  const lines = hits.map((h) => `${h.file}:${h.line}-${h.end}  ${h.qname !== h.name ? `[${h.qname.slice(0, -h.name.length - 1)}] ` : ''}${h.sig}`);
  if (total > hits.length) lines.push(`… ${total - hits.length} more (narrow the name)`);
  return lines.join('\n');
}

export function outline(index, file, opts) {
  let abs = path.resolve(file);
  try {
    abs = fs.realpathSync.native(abs); // index.root is a real path (see repoRoot)
  } catch {}
  const rel = path.relative(index.root, abs).replace(/\\/g, '/');
  const f = index.files[rel] ?? index.files[file];
  if (f) return formatOutline(rel, f.lines, f.symbols.map(sym), opts);
  return outlineFile(path.resolve(file), rel, opts); // not indexed (new, ignored, too big): parse directly
}

/** Outline a single file without touching the index (used by the read guard). */
export function outlineFile(abs, label = abs, opts) {
  const lang = langOf(abs);
  if (!lang) return null;
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const syms = extractSymbols(text, lang);
  return syms.length ? formatOutline(label, text.split('\n').length, syms, opts) : null;
}

function formatOutline(rel, lineCount, syms, { maxEntries = 80 } = {}) {
  const depthOf = [];
  const shown = syms.slice(0, maxEntries).map((s, i) => {
    let depth = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (syms[j].indent < s.indent && syms[j].end >= s.line) {
        depth = depthOf[j] + 1;
        break;
      }
    }
    depthOf[i] = depth;
    return `${'  '.repeat(depth)}L${s.line}-${s.end}  ${s.kind === 'heading' ? s.name : s.sig}`;
  });
  const head = `${rel} — ${lineCount} lines, ${syms.length} symbols`;
  const more = syms.length > maxEntries ? [`… ${syms.length - maxEntries} more`] : [];
  return [head, ...shown, ...more].join('\n');
}

/** Ranked repo outline that fits a token budget. */
export function repoMap(index, { dir = '', budget = 1500 } = {}) {
  const prefix = dir ? dir.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/?$/, '/') : '';
  const entries = Object.entries(index.files).filter(([f]) => !prefix || f.startsWith(prefix));
  const inbound = {};
  for (const [, f] of Object.entries(index.files)) for (const imp of f.imports) inbound[imp] = (inbound[imp] ?? 0) + 1;
  const scored = entries.map(([file, f]) => {
    const base = path.basename(file).replace(/\.\w+$/, '');
    const keys = moduleKeys(file);
    // Two-segment matches are precise; bare-name matches only count for relative-style imports.
    const refsIn = (inbound[keys.two] ?? 0) + (keys.two === keys.one ? 0 : (inbound[keys.one] ?? 0) * 0.25);
    const minIndent = Math.min(...f.symbols.map((t) => t[4]));
    const top = f.symbols.filter((t) => t[1] !== 'heading' && t[4] === minIndent);
    let score = Math.log2(1 + refsIn) * 3 + Math.log2(1 + top.length) + (/^(index|main|app|cli|server|mod|lib|__init__)$/.test(base) ? 2 : 0);
    if (/(^|\/)(tests?|spec|__tests__|examples?|fixtures?|docs?)\//i.test(file) || /[._-](test|spec)\./i.test(file)) score -= 4;
    score -= file.split('/').length * 0.3;
    return { file, f, top, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const maxChars = budget * 4;
  const out = [];
  let used = 0;
  let shown = 0;
  for (const { file, f, top } of scored) {
    const names = top.map((t) => t[0]);
    const line = `${file} (${f.lines})${names.length ? ': ' + names.slice(0, 12).join(', ') + (names.length > 12 ? ', …' : '') : ''}`;
    if (used + line.length + 1 > maxChars) break;
    out.push(line);
    used += line.length + 1;
    shown++;
  }
  const hidden = scored.length - shown;
  const header = `${prefix || './'} — ${scored.length} source files, most central first (lines in parens)`;
  return [header, ...out, ...(hidden > 0 ? [`… ${hidden} more files; zoom in with: tokenmiser map <dir>`] : [])].join('\n');
}

/** Compact usages via ripgrep (or grep): per-file line numbers + a few snippets. */
export function refs(root, name, { maxSnippets = 12, maxFiles = 40 } = {}) {
  let raw = '';
  const opts = { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    raw = execFileSync('rg', ['-n', '-w', '-F', '--no-heading', '--max-columns', '160', '--glob', '!.tokenmiser', name], opts);
  } catch (e) {
    if (e.status === 1) raw = '';
    else {
      try {
        raw = execFileSync('git', ['grep', '--untracked', '-n', '-w', '-F', name, '--', '.', ':!.tokenmiser'], opts);
      } catch (e2) {
        raw = e2.stdout ?? '';
      }
    }
  }
  const byFile = new Map();
  for (const l of raw.split('\n')) {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    if (!byFile.has(m[1])) byFile.set(m[1], []);
    byFile.get(m[1]).push({ line: +m[2], text: m[3].trim() });
  }
  if (!byFile.size) return `No uses of "${name}" found.`;
  const total = [...byFile.values()].reduce((n, a) => n + a.length, 0);
  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  const out = [`${total} uses of "${name}" in ${files.length} files`];
  let snippets = 0;
  for (const [file, hits] of files.slice(0, maxFiles)) {
    const nums = hits.map((h) => h.line);
    out.push(`${file}: L${nums.slice(0, 15).join(', L')}${nums.length > 15 ? ` (+${nums.length - 15})` : ''}`);
    if (snippets < maxSnippets) {
      out.push(`    ${hits[0].text.slice(0, 140)}`);
      snippets++;
    }
  }
  if (files.length > maxFiles) out.push(`… ${files.length - maxFiles} more files`);
  return out.join('\n');
}
