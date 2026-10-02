#!/usr/bin/env node
// A/B benchmark for GitHub Copilot CLI: same questions with and without tokenmiser.
//
//   node bench/copilot-ab.mjs <repo-dir> [--tasks bench/tasks-flask.json] [--reps 3] [--jobs 2] [--model <id>] [--out bench/copilot-results.json]
//
// Works with a Copilot login (any plan that includes Copilot CLI) or with no
// subscription at all via BYOK, e.g. your own API key or a local model:
//   COPILOT_PROVIDER_TYPE=anthropic COPILOT_PROVIDER_BASE_URL=https://api.anthropic.com \
//   COPILOT_PROVIDER_API_KEY=sk-ant-... COPILOT_MODEL=claude-haiku-4-5 node bench/copilot-ab.mjs /tmp/flask
//
// Runs with --allow-all-tools --deny-tool write: point it at a throwaway clone.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const repo = path.resolve(argv[0] ?? '.');
const reps = Number(opt('reps', 3));
const jobs = Number(opt('jobs', 2));
const model = opt('model', null);
const out = opt('out', new URL('./copilot-results.json', import.meta.url).pathname);
const bin = opt('copilot', 'copilot');
const plugin = new URL('../plugins/tokenmiser', import.meta.url).pathname;
const tasks = JSON.parse(fs.readFileSync(path.resolve(opt('tasks', new URL('./tasks-flask.json', import.meta.url).pathname)), 'utf8'));
// If tokenmiser is already installed in Copilot, use that copy (loading it twice would
// run every hook twice); "none" then switches it off with TOKENMISER_DISABLE.
let installed = false;
try {
  installed = /tokenmiser/.test(execFileSync(bin, ['plugin', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
} catch {}
const SETUPS = {
  none: { args: [], env: { TOKENMISER_DISABLE: '1' } },
  plugin: { args: installed ? [] : ['--plugin-dir', plugin], env: {} },
};

// "Tokens ↑ 96.2k (61k read, 17.4k written) • ↓ 1.2k (300 reasoning)" and "AI Credits 2.22 (6s)" -> numbers
function parseTokens(text) {
  const num = (s) => {
    if (!s) return 0;
    const m = s.replace(/,/g, '').match(/([\d.]+)\s*([kKmM]?)/);
    return m ? Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] ?? 1)) : 0;
  };
  const line = text.split('\n').find((l) => /^\s*Tokens\b/.test(l)) ?? '';
  const up = line.split('•')[0] ?? '';
  return {
    input: num(up.match(/↑\s*([\d.,]+\s*[kKmM]?)/)?.[1]),
    cached: num(up.match(/([\d.,]+\s*[kKmM]?)\s*(?:read|cached)/i)?.[1]),
    written: num(up.match(/([\d.,]+\s*[kKmM]?)\s*written/i)?.[1]),
    output: num(line.match(/↓\s*([\d.,]+\s*[kKmM]?)/)?.[1]),
    credits: parseFloat(text.match(/^\s*AI Credits\s+([\d.]+)/im)?.[1] ?? 'NaN'),
    raw: line.trim().replace(/\s+/g, ' '),
  };
}

function run(task, setup, rep) {
  const s = SETUPS[setup];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cbench-'));
  const share = path.join(tmp, 'session.md');
  const args = ['-p', `${task.q} Be concise.`, '--allow-all-tools', '--deny-tool', 'write', '--no-color', '--share', share, ...s.args];
  if (model) args.push('--model', model);
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd: repo, env: { ...process.env, ...s.env, TOKENMISER_HOME: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    p.stdout.on('data', (d) => (so += d));
    p.stderr.on('data', (d) => (so += d));
    p.on('close', (code) => {
      let md = '';
      try {
        md = fs.readFileSync(share, 'utf8');
      } catch {}
      const answer = md.split(/^### Copilot\s*$/m).pop()?.split(/^---\s*$/m)[0]?.trim() ?? '';
      const tok = parseTokens(so);
      // What tokenmiser did in this run, from its own stats log.
      const tm = {};
      try {
        for (const l of fs.readFileSync(path.join(tmp, 'stats.jsonl'), 'utf8').split('\n').filter(Boolean)) {
          const k = JSON.parse(l).kind;
          tm[k] = (tm[k] ?? 0) + 1;
        }
      } catch {}
      const row = {
        task: task.id, setup, rep, exit: code,
        ok: [].concat(task.expect).some((e) => answer.includes(e)),
        toolCalls: (md.match(/^### `/gm) ?? []).length,
        modelCalls: (md.match(/^### Copilot\s*$/gm) ?? []).length,
        ...tok,
        tm,
        answer: answer.slice(0, 600),
      };
      process.stderr.write(`${setup.padEnd(7)} ${task.id.padEnd(22)} rep${rep} tools=${row.toolCalls} credits=${tok.credits || '-'} ${tok.raw || '(no token line)'} tm=${JSON.stringify(tm)} ${row.ok ? 'ok' : 'MISS'}\n`);
      resolve(row);
    });
  });
}

const queue = [];
for (let r = 1; r <= reps; r++) for (const t of tasks) for (const s of Object.keys(SETUPS)) queue.push([t, s, r]);
const rows = [];
await Promise.all(Array.from({ length: jobs }, async () => {
  while (queue.length) rows.push(await run(...queue.shift()));
}));
fs.writeFileSync(out, JSON.stringify(rows, null, 2));

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const of = (s, k) => avg(rows.filter((x) => x.setup === s).map((x) => x[k] || 0));
const hasCredits = rows.some((x) => x.credits > 0);
const pct = (a, b) => (b ? `${((a / b - 1) * 100).toFixed(0)}%` : '');
console.log(`\n${tasks.length} tasks × ${reps} reps, repo ${path.basename(repo)}${model ? `, model ${model}` : ''}${installed ? ' (using the installed plugin)' : ''}\n`);
console.log(`setup    correct  tool calls  input tok  cache-read  cache-written  output tok${hasCredits ? '  AI credits' : ''}`);
for (const s of Object.keys(SETUPS)) {
  const r = rows.filter((x) => x.setup === s);
  const n = (k) => Math.round(of(s, k)).toLocaleString();
  console.log(`${s.padEnd(8)} ${`${r.filter((x) => x.ok).length}/${r.length}`.padEnd(8)} ${of(s, 'toolCalls').toFixed(1).padEnd(11)} ${n('input').padEnd(10)} ${n('cached').padEnd(11)} ${n('written').padEnd(14)} ${n('output').padEnd(10)}${hasCredits ? `  ${of(s, 'credits').toFixed(2)}` : ''}`);
}
console.log(`\nplugin vs none: input ${pct(of('plugin', 'input'), of('none', 'input'))}, tool calls ${pct(of('plugin', 'toolCalls'), of('none', 'toolCalls'))}${hasCredits ? `, AI credits ${pct(of('plugin', 'credits'), of('none', 'credits'))}` : ''}`);
console.log(`\nRaw rows: ${out}`);
