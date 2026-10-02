import fs from 'node:fs';
import { compress } from './compress.mjs';

// Copilot CLI replaces shell output above ~20 KB with a 500-char preview and a temp
// file, which usually costs the agent several extra turns of head/tail/rg to find the
// error. Hand it a digest of the full output instead: head, tail and every error line.
const SAVED = /^Output too large to read at once \([^)]*\)\. Saved to: (\S+)/;
export function digestSavedOutput(text, cfg) {
  const m = text.match(SAVED);
  if (!m) return null;
  let full;
  try {
    full = fs.readFileSync(m[1], 'utf8');
  } catch {
    return null;
  }
  const res = compress(full, { ...cfg, maxChars: cfg.digestChars ?? cfg.maxChars }, () => m[1]);
  const status = text.match(/<shellId:[^>]*>\s*$/)?.[0] ?? '';
  const body = res.truncated ? res.text : `${res.text}\n[tokenmiser: full output: ${m[1]}]`;
  return { before: full.length, text: `${body}${status ? '\n' + status.trim() : ''}` };
}
