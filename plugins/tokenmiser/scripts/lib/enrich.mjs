// Search enrichment: when a search returns file:line hits, tell the agent which
// definition each hit sits in and that definition's exact line range. Agents
// otherwise guess a read window ("offset 270, limit 80"), come up short, and
// spend another turn reading more. Works on whatever search the agent already ran,
// so it needs no change in agent behaviour.
import fs from 'node:fs';
import path from 'node:path';
import { extractSymbols, langOf } from './codeindex.mjs';

const MAX_FILES = 8;
const MAX_CHARS = 1500;

function symbolsFor(abs) {
  if (!langOf(abs) || langOf(abs) === 'md') return null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 1_000_000) return null;
    return extractSymbols(fs.readFileSync(abs, 'utf8'), langOf(abs));
  } catch {
    return null;
  }
}

// A lone file argument in a grep/rg command, for output lines that carry no filename.
function soleFileArg(command, cwd) {
  if (!command || !/^\s*(rg|grep|git grep)\b/.test(command) || /[|;&]/.test(command)) return null;
  const files = command
    .split(/\s+/)
    .slice(1)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => t && !t.startsWith('-') && fs.existsSync(path.resolve(cwd, t)) && fs.statSync(path.resolve(cwd, t)).isFile());
  return files.length === 1 ? files[0] : null;
}

/** Returns a short note to append to a search result, or null. */
export function enrichSearch(text, { cwd = process.cwd(), command = '' } = {}) {
  if (!text) return null;
  const hits = new Map(); // file -> Set(line)
  const lone = soleFileArg(command, cwd);
  // Copilot's rg tool groups hits: "[grep content: … under DIR]", "file.py (3 match(es)):", "  72: text"
  const base = text.match(/^\[grep content:.*? under (.+?)\]\s*$/m)?.[1] ?? '';
  const resolve = (f) => {
    const inBase = path.resolve(cwd, base, f);
    return base && fs.existsSync(inBase) ? path.join(base, f) : f;
  };
  const add = (file, line) => {
    if (!file || !line) return;
    if (!hits.has(file)) {
      if (hits.size >= MAX_FILES) return;
      hits.set(file, new Set());
    }
    hits.get(file).add(line);
  };
  let group = null;
  let located = 0;
  const cache = new Map();
  const linesOf = (abs) => {
    if (!cache.has(abs)) {
      let v = null;
      try {
        if (fs.statSync(abs).size <= 1_000_000) v = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      } catch {}
      cache.set(abs, v);
    }
    return cache.get(abs);
  };
  for (const raw of text.split('\n')) {
    let m = raw.match(/^(\S.*?) \(\d+ match(?:\(es\)|es)?\):\s*$/);
    if (m) {
      group = resolve(m[1]);
      continue;
    }
    m = raw.match(/^<match path="([^"]+)" line=(\d+)>/); // Copilot grep_search
    if (m) {
      add(path.relative(cwd, m[1]).startsWith('..') ? m[1] : path.relative(cwd, m[1]), +m[2]);
      continue;
    }
    m = raw.match(/^(?:\.\/)?([^\s:][^:\n]*?\.[A-Za-z0-9]+)[:-](\d+)[:-]/);
    if (m) {
      add(resolve(m[1]), +m[2]);
      continue;
    }
    m = raw.match(/^\s*(\d+)[:-]/);
    if (m && (group || lone)) {
      add(group ?? lone, +m[1]);
      continue;
    }
    // "path:matched text" with no line number (Copilot's grep tool): find where that
    // text sits in the file, so the agent doesn't spend calls hunting for the line.
    m = raw.match(/^(?:\.\/)?([^\s:][^:\n]*?\.[A-Za-z0-9]+):\s*(.*?\S)(?:\s+\[×\d+\])?\s*$/);
    if (m && located < 12) {
      const file = resolve(path.isAbsolute(m[1]) && !path.relative(cwd, m[1]).startsWith('..') ? path.relative(cwd, m[1]) : m[1]);
      const want = m[2].trim();
      const src = linesOf(path.resolve(cwd, file));
      if (!src || want.length < 4) continue;
      let found = 0;
      for (let i = 0; i < src.length && found < 3; i++) {
        if (src[i].trim() === want) {
          add(file, i + 1);
          found++;
          located++;
        }
      }
    }
  }
  const out = [];
  for (const [file, lines] of hits) {
    const syms = symbolsFor(path.resolve(cwd, file));
    if (!syms?.length) continue;
    const bySym = new Map();
    for (const ln of [...lines].sort((a, b) => a - b)) {
      // innermost definition containing the line
      let best = null;
      for (const s of syms) if (s.line <= ln && s.end >= ln && (!best || s.indent >= best.indent)) best = s;
      if (!best) continue;
      if (!bySym.has(best)) bySym.set(best, []);
      bySym.get(best).push(ln);
    }
    for (const [s, lns] of bySym) {
      const at = lns.length > 4 ? `L${lns.slice(0, 4).join(',L')},…` : `L${lns.join(',L')}`;
      out.push(`${file}: ${at} in ${s.qname ?? s.name} (L${s.line}-${s.end})`);
    }
  }
  if (!out.length) return null;
  let note = `[tokenmiser] enclosing definitions — read just these ranges:\n${out.join('\n')}`;
  if (note.length > MAX_CHARS) note = note.slice(0, MAX_CHARS).replace(/\n[^\n]*$/, '\n…');
  return note;
}
