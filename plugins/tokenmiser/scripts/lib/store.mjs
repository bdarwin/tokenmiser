import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir } from './config.mjs';

const SPILL_KEEP = 40;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function recordStat(entry) {
  try {
    const file = path.join(ensureDir(homeDir()), 'stats.jsonl');
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch {
    /* stats are best-effort */
  }
}

export function readStats() {
  try {
    return fs
      .readFileSync(path.join(homeDir(), 'stats.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Spill files live in the project (agents can always read the workspace without
// extra path permissions). The folder ignores itself so it never gets committed.
export function spillDir(cwd) {
  const candidates = [cwd && path.join(cwd, '.tokenmiser', 'spill'), path.join(os.tmpdir(), 'tokenmiser-spill')];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      ensureDir(dir);
      const ignore = path.join(dir, '..', '.gitignore');
      if (dir.includes(`${path.sep}.tokenmiser${path.sep}`) && !fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
      return dir;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function makeSpiller(cwd) {
  return (text) => {
    const dir = spillDir(cwd);
    if (!dir) return null;
    const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${hash}.log`);
    fs.writeFileSync(file, text);
    prune(dir);
    const rel = cwd ? path.relative(cwd, file) : file;
    return rel.startsWith('..') ? file : rel;
  };
}

function prune(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - SPILL_KEEP))) fs.rmSync(path.join(dir, f), { force: true });
}

// Per-session memory for deny-once: the first wasteful read is blocked with advice,
// an identical retry goes through (the agent may genuinely need it).
export function denyOnce(sessionId, key) {
  try {
    const dir = ensureDir(path.join(homeDir(), 'sessions'));
    const safe = String(sessionId || 'default').replace(/[^\w.-]/g, '_');
    const file = path.join(dir, `${safe}.json`);
    let seen = [];
    try {
      seen = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    if (Math.random() < 0.05) pruneOld(dir);
    if (seen.includes(key)) return false;
    seen.push(key);
    fs.writeFileSync(file, JSON.stringify(seen.slice(-500)));
    return true;
  } catch {
    return false; // if we can't remember, never block
  }
}

function pruneOld(dir, maxAgeMs = 7 * 24 * 3600 * 1000) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true });
    } catch {}
  }
}
