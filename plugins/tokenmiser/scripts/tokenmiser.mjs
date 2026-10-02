#!/usr/bin/env node
// tokenmiser: cut the tokens (and AI credits) coding agents burn on noisy tool output.
//
//   tokenmiser hook <session-start|pre-tool|post-tool> [--agent copilot|claude]   (stdin: hook JSON)
//   tokenmiser compress [--max-chars N]       pipe any output through the compressor
//   tokenmiser stats [--json] [--reset]       what has been saved so far
//   tokenmiser doctor                         check setup, print credit-saving tips
//   tokenmiser sym <name> | outline <file> | refs <name> | map [dir] [--budget N] | index [--rebuild]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { normalize, respond } from './lib/adapters.mjs';
import { compress, estimateTokens } from './lib/compress.mjs';
import { homeDir, loadConfig } from './lib/config.mjs';
import { findSymbol, formatSymbols, loadIndex, outline, refs, repoMap, repoRoot } from './lib/codeindex.mjs';
import { frugalPrompt } from './lib/frugal.mjs';
import { ensureShim } from './lib/shim.mjs';
import { digestSavedOutput } from './lib/digest.mjs';
import { enrichSearch } from './lib/enrich.mjs';
import { denyMessage, inspect } from './lib/guard.mjs';
import { snapRead } from './lib/snap.mjs';
import { denyOnce, makeSpiller, readStats, recordStat } from './lib/store.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// ---------------------------------------------------------------- hooks
function runHook(event) {
  const agent = flag('agent', 'copilot') === 'claude' ? 'claude' : 'copilot';
  const r = respond[agent];
  let payload = {};
  try {
    payload = JSON.parse(readStdin() || '{}');
  } catch {
    return; // never break the agent over a malformed payload
  }
  const call = normalize(payload);
  const cfg = loadConfig(call.cwd);
  if (!cfg.enabled) return;

  if (event === 'session-start') {
    let tm = null;
    if (cfg.index) {
      tm = ensureShim(repoRoot(call.cwd), call.cwd);
      // Warm the index in the background so the first query is instant.
      try {
        spawn(process.execPath, [new URL(import.meta.url).pathname, 'index', '--quiet'], { cwd: call.cwd, detached: true, stdio: 'ignore' }).unref();
      } catch {}
    }
    if (cfg.frugalPrompt) emit(r.context(frugalPrompt({ agent, tm })));
    return;
  }

  if (event === 'pre-tool') {
    if (cfg.snapReads) {
      const snap = snapRead(call, cfg);
      if (snap) {
        if (cfg.stats) recordStat({ kind: 'snap', agent, tool: call.tool, session: call.sessionId, added: snap.added });
        emit(r.rewrite(snap.args));
        return;
      }
    }
    if (!cfg.guard) return;
    const hit = inspect(call, cfg);
    if (!hit) return;
    if (denyOnce(call.sessionId, hit.key)) {
      if (cfg.stats) recordStat({ kind: 'deny', agent, tool: call.tool, session: call.sessionId, bytes: hit.bytes });
      emit(r.deny(denyMessage(hit.reason)));
    } else if (cfg.stats) {
      recordStat({ kind: 'override', agent, tool: call.tool, session: call.sessionId, bytes: hit.bytes });
    }
    return;
  }

  if (event === 'post-tool') {
    if (call.resultText == null) return;
    const command = String(call.args.command ?? '');
    const isShell = /^(bash|powershell|shell)$/i.test(call.tool);
    const isSearch = /^(grep|rg|glob)$/i.test(call.tool) || (isShell && /^\s*(rg|grep|git grep)\b/.test(command));
    let text = null;
    let context = null;

    // An explicit file dump (cat/head/tail/sed -n …) is a read: the agent wants those exact
    // lines, so trimming it only forces a re-read. Big dumps are the read guard's job.
    const isFileDump = isShell && /^\s*(cat|head|tail|nl|bat|type|Get-Content|sed\s+-n)\b[^|;&]*$/.test(command);
    if (cfg.compress && !isFileDump && new RegExp(cfg.compressTools).test(call.tool)) {
      const digest = digestSavedOutput(call.resultText, cfg);
      if (digest) {
        text = digest.text;
        if (cfg.stats) recordStat({ kind: 'digest', agent, tool: call.tool, session: call.sessionId, before: digest.before, after: digest.text.length });
      } else {
        // Search results: line numbers are the payload, so never fold "similar" lines.
        const res = compress(call.resultText, isSearch ? { ...cfg, collapseSimilar: false } : cfg, makeSpiller(call.cwd));
        if (res.changed) {
          text = res.text;
          if (cfg.stats) recordStat({ kind: 'compress', agent, tool: call.tool, session: call.sessionId, before: res.before, after: res.after });
        }
      }
    }
    if (cfg.enrichSearch && isSearch) {
      context = enrichSearch(call.resultText, { cwd: call.cwd, command });
      if (context && cfg.stats) recordStat({ kind: 'enrich', agent, tool: call.tool, session: call.sessionId });
    }
    if (text != null || context) emit(r.post({ text, context }, call));
  }
}

// ---------------------------------------------------------------- commands
function cmdCompress() {
  const cfg = { ...loadConfig(), maxChars: Number(flag('max-chars', 0)) || loadConfig().maxChars };
  const res = compress(readStdin(), cfg, makeSpiller(process.cwd()));
  process.stdout.write(res.text.endsWith('\n') ? res.text : res.text + '\n');
  if (res.changed) process.stderr.write(`[tokenmiser] ${res.before} → ${res.after} chars (~${estimateTokens(res.before - res.after)} tokens saved)\n`);
}

function cmdStats() {
  const file = path.join(homeDir(), 'stats.jsonl');
  if (has('reset')) {
    fs.rmSync(file, { force: true });
    console.log('tokenmiser stats reset.');
    return;
  }
  const rows = readStats();
  const sum = { compressions: 0, charsIn: 0, charsOut: 0, denials: 0, deniedBytes: 0, overrides: 0, overrideBytes: 0, digests: 0, snaps: 0, enriched: 0, sessions: new Set(), byTool: {} };
  for (const r of rows) {
    sum.sessions.add(r.session);
    const t = (sum.byTool[r.tool] ??= { calls: 0, saved: 0 });
    if (r.kind === 'compress') {
      sum.compressions++;
      sum.charsIn += r.before;
      sum.charsOut += r.after;
      t.calls++;
      t.saved += r.before - r.after;
    } else if (r.kind === 'deny') {
      sum.denials++;
      sum.deniedBytes += r.bytes || 0;
      t.calls++;
      t.saved += r.bytes || 0;
    } else if (r.kind === 'snap') {
      sum.snaps++;
    } else if (r.kind === 'enrich') {
      sum.enriched++;
    } else if (r.kind === 'digest') {
      sum.digests++;
    } else if (r.kind === 'override') {
      sum.overrides++;
      sum.overrideBytes += r.bytes || 0;
      t.saved -= r.bytes || 0;
    }
  }
  const compressSaved = estimateTokens(sum.charsIn - sum.charsOut);
  const guardSaved = estimateTokens(Math.max(0, sum.deniedBytes - sum.overrideBytes));
  const out = {
    sessions: sum.sessions.size,
    compressions: sum.compressions,
    compressionRatio: sum.charsIn ? +(1 - sum.charsOut / sum.charsIn).toFixed(3) : 0,
    tokensSavedByCompression: compressSaved,
    readsBlocked: sum.denials,
    readsOverridden: sum.overrides,
    tokensSavedByGuard: guardSaved,
    tokensSavedTotal: compressSaved + guardSaved,
    hugeOutputsDigested: sum.digests,
    readsSnappedToDefinition: sum.snaps,
    searchesAnnotated: sum.enriched,
    byTool: Object.fromEntries(Object.entries(sum.byTool).map(([k, v]) => [k, { events: v.calls, tokensSaved: estimateTokens(Math.max(0, v.saved)) }])),
  };
  if (has('json')) return console.log(JSON.stringify(out, null, 2));
  const n = (x) => x.toLocaleString('en-US');
  console.log(`tokenmiser — estimated input tokens kept out of the context window
  sessions            ${n(out.sessions)}
  outputs compressed  ${n(out.compressions)}  (${Math.round(out.compressionRatio * 100)}% smaller, ~${n(compressSaved)} tokens)
  big reads blocked   ${n(out.readsBlocked)}  (${n(out.readsOverridden)} retried anyway, ~${n(guardSaved)} tokens)
  huge outputs digested ${n(out.hugeOutputsDigested)}  (error lines surfaced up front instead of a 500-char preview; saves follow-up turns)
  reads snapped       ${n(out.readsSnappedToDefinition)}  (range extended to the end of the definition; saves a re-read)
  searches annotated  ${n(out.searchesAnnotated)}  (hits labelled with their enclosing definition and line range)
  total               ~${n(out.tokensSavedTotal)} tokens
Note: every token kept out is also not re-sent on each later turn of the session, so real savings are higher.`);
  const tools = Object.entries(out.byTool).sort((a, b) => b[1].tokensSaved - a[1].tokensSaved);
  if (tools.length) console.log('\n  by tool: ' + tools.map(([k, v]) => `${k} ~${n(v.tokensSaved)}`).join(', '));
}

function cmdCode(cmd, arg) {
  const t0 = Date.now();
  const index = loadIndex(process.cwd(), { rebuild: has('rebuild') });
  let out;
  if (cmd === 'index') {
    if (has('quiet')) return;
    const syms = Object.values(index.files).reduce((n, f) => n + f.symbols.length, 0);
    out = `indexed ${Object.keys(index.files).length} files, ${syms} symbols (${index.changed} refreshed) in ${Date.now() - t0} ms → ${path.join(index.root, '.tokenmiser', 'index.json')}`;
  } else if (!arg && cmd !== 'map') {
    out = `usage: tokenmiser ${cmd} <${cmd === 'outline' ? 'file' : 'name'}>`;
    process.exitCode = 1;
  } else if (cmd === 'sym') out = formatSymbols(findSymbol(index, arg, Number(flag('limit', 20))), arg);
  else if (cmd === 'outline') out = outline(index, arg) ?? `No symbols found in ${arg} (unsupported language or empty).`;
  else if (cmd === 'refs') out = refs(index.root, arg);
  else if (cmd === 'map') out = repoMap(index, { dir: arg && !arg.startsWith('--') ? arg : '', budget: Number(flag('budget', 1500)) });
  console.log(out);
}

function cmdDoctor() {
  const ok = (b, msg) => console.log(`${b ? '✔' : '✘'} ${msg}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 18, `node ${process.versions.node} (need ≥ 18)`);
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.accessSync(homeDir(), fs.constants.W_OK);
    ok(true, `state dir writable: ${homeDir()}`);
  } catch {
    ok(false, `state dir not writable: ${homeDir()} (set TOKENMISER_HOME)`);
  }
  const cfg = loadConfig();
  ok(cfg.enabled, `enabled (compress=${cfg.compress}, guard=${cfg.guard}, snapReads=${cfg.snapReads}, enrichSearch=${cfg.enrichSearch}, frugalPrompt=${cfg.frugalPrompt}, index=${cfg.index}, maxChars=${cfg.maxChars})`);
  console.log(`
More ways to save Copilot CLI credits (these are settings, not things a plugin can do for you):
  • Cap a session:        copilot --max-ai-credits 60     (or /limits set max-ai-credits 60)
  • Cheaper subagents:    /subagents → set explore/task agents to a small model (e.g. claude-haiku-4.5, gpt-5-mini)
  • Auto model routing:   copilot --model auto --auto-tier efficiency
  • Watch the meter:      /statusline → add quota + ai-used;  /usage and /context mid-session
  • Fresh context:        /clear between unrelated tasks; /compact when a long session drags
  • Autopilot runaway:    --max-autopilot-continues 3`);
}

const [cmd, sub] = argv;
try {
  if (cmd === 'hook') runHook(sub);
  else if (cmd === 'compress') cmdCompress();
  else if (cmd === 'stats') cmdStats();
  else if (cmd === 'doctor') cmdDoctor();
  else if (['index', 'sym', 'outline', 'refs', 'map'].includes(cmd)) cmdCode(cmd, sub);
  else {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split("\n").slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
} catch (err) {
  // Hooks must fail open: log and let the agent continue untouched.
  process.stderr.write(`[tokenmiser] ${err?.stack || err}\n`);
  if (cmd !== 'hook') process.exitCode = 1;
}
