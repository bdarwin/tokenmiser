// Read snapping: when the agent reads a line range that starts inside a definition
// but stops before that definition ends, extend the read to the definition's end.
// Agents guess read windows ("offset 273, limit 25") and then spend a whole extra
// turn, re-sending the conversation, to read the rest. One slightly longer read is
// far cheaper than a second round trip.
import fs from 'node:fs';
import path from 'node:path';
import { extractSymbols, langOf } from './codeindex.mjs';

const LEAD = 3; // a range may start up to this many lines above the def (decorators, comments)

/** Returns { args, added } with the range extended, or null to leave the call alone. */
export function snapRead(call, cfg) {
  const t = call.tool.toLowerCase();
  const a = call.args;
  const maxLines = cfg.snapMaxLines ?? 150;
  let file;
  let start;
  let end;
  let make;
  if (t === 'read' && (a.offset || a.limit)) {
    // Claude Read: 1-based offset, line count
    file = a.file_path;
    start = Number(a.offset) || 1;
    if (!a.limit) return null;
    end = start + Number(a.limit) - 1;
    make = (newEnd) => ({ ...a, limit: newEnd - start + 1 });
  } else if (t === 'view' && Array.isArray(a.view_range) && a.view_range.length === 2) {
    // Copilot view: [start, end], end -1 = EOF
    file = a.path;
    [start, end] = a.view_range.map(Number);
    if (end === -1) return null;
    make = (newEnd) => ({ ...a, view_range: [start, newEnd] });
  } else if (t === 'read_file' && a.startLine && a.endLine) {
    // Copilot read_file: inclusive startLine/endLine
    file = a.filePath ?? a.path;
    start = Number(a.startLine);
    end = Number(a.endLine);
    make = (newEnd) => ({ ...a, endLine: newEnd });
  } else return null;
  if (!file || !(end >= start)) return null;

  const abs = path.resolve(call.cwd || '.', file);
  const lang = langOf(abs);
  if (!lang || lang === 'md') return null;
  let syms;
  try {
    if (fs.statSync(abs).size > 1_000_000) return null;
    syms = extractSymbols(fs.readFileSync(abs, 'utf8'), lang);
  } catch {
    return null;
  }
  // Outermost definition that starts at (or just below) the range start and isn't huge;
  // fall back to the innermost one containing the start line.
  const starting = syms.filter((s) => s.line >= start && s.line <= start + LEAD && s.end - start + 1 <= maxLines).sort((x, y) => x.indent - y.indent)[0];
  const containing = syms.filter((s) => s.line <= start && s.end >= start).sort((x, y) => y.indent - x.indent)[0];
  const target = starting ?? (containing && containing.end - start + 1 <= maxLines ? containing : null);
  if (!target || target.end <= end) return null;
  return { args: make(target.end), added: target.end - end, symbol: target.qname ?? target.name };
}
