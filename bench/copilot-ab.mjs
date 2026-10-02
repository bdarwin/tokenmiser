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
import { spawn } from 'node:child_process';
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
// "none" also sets TOKENMISER_DISABLE in case tokenmiser is installed globally.
const SETUPS = {
  none: { args: [], env: { TOKENMISER_DISABLE: '1' } },
  plugin: { args: ['--plugin-dir', plugin], env: {} },
};

// "↑ 1.2m (980k cached) • ↓ 3.4k" -> numbers
function parseTokens(text) {
  const num = (s) => {
    if (!s) return 0;
    const m = s.replace(/,/g, '').match(/([\d.]+)\s*([kKmM]?)/);
    return m ? Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] ?? 1)) : 0;
  };
  const line = text.split('\n').find((l) => /^\s*Tokens\b/.test(l)) ?? '';
  return {
    input: num(line.match(/↑\s*([\d.,]+\s*[kKmM]?)/)?.[1]),
    cached: num(line.match(/\(([\d.,]+\s*[kKmM]?)\s*cached/i)?.[1]),
    output: num(line.match(/↓\s*([\d.,]+\s*[kKmM]?)/)?.[1]),
    credits: text.match(/([\d.]+)\s*AI credits?/i)?.[1] ?? null,
    raw: line.trim(),
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
      const row = {
        task: task.id, setup, rep, exit: code,
        ok: [].concat(task.expect).some((e) => answer.includes(e)),
        toolCalls: (md.match(/^### `/gm) ?? []).length,
        modelCalls: (md.match(/^### Copilot\s*$/gm) ?? []).length,
        ...tok,
        answer: answer.slice(0, 600),
      };
      process.stderr.write(`${setup.padEnd(7)} ${task.id.padEnd(22)} rep${rep} tools=${row.toolCalls} ${tok.raw || '(no token line)'} ${row.ok ? 'ok' : 'MISS'}\n`);
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
const base = avg(rows.filter((x) => x.setup === 'none').map((x) => x.input));
console.log(`\n${tasks.length} tasks × ${reps} reps, repo ${path.basename(repo)}${model ? `, model ${model}` : ''}\n`);
console.log('setup    correct  avg tool calls  avg input tok  avg cached  avg output tok  input vs none');
for (const s of Object.keys(SETUPS)) {
  const r = rows.filter((x) => x.setup === s);
  const inp = avg(r.map((x) => x.input));
  console.log(`${s.padEnd(8)} ${`${r.filter((x) => x.ok).length}/${r.length}`.padEnd(8)} ${avg(r.map((x) => x.toolCalls)).toFixed(1).padEnd(15)} ${Math.round(inp).toLocaleString().padEnd(14)} ${Math.round(avg(r.map((x) => x.cached))).toLocaleString().padEnd(11)} ${Math.round(avg(r.map((x) => x.output))).toLocaleString().padEnd(15)} ${s === 'none' ? '' : `${((inp / base - 1) * 100).toFixed(0)}%`}`);
}
console.log(`\nRaw rows: ${out}`);
