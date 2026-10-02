#!/usr/bin/env node
// A/B benchmark: same questions, three setups, Claude Code headless.
//   node bench/claude-ab.mjs <repo-dir> [--tasks bench/tasks-flask.json] [--reps 2] [--model haiku] [--jobs 3] [--out bench/results.json]
// Setups: "none" (no plugin), "plugin" (tokenmiser, index off), "plugin+index" (tokenmiser, index on).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const repo = path.resolve(argv[0] ?? '.');
const reps = Number(opt('reps', 2));
const model = opt('model', 'haiku');
const jobs = Number(opt('jobs', 3));
const out = opt('out', new URL('./results.json', import.meta.url).pathname);
const plugin = new URL('../plugins/tokenmiser', import.meta.url).pathname;
const tasks = JSON.parse(fs.readFileSync(path.resolve(opt('tasks', new URL('./tasks-flask.json', import.meta.url).pathname)), 'utf8'));
const SETUPS = {
  none: { plugin: false, env: {} },
  plugin: { plugin: true, env: { TOKENMISER_INDEX: '0' } },
  'plugin+index': { plugin: true, env: { TOKENMISER_INDEX: '1' } },
};
const TOOLS = ['Read', 'Grep', 'Glob', 'Bash(.tokenmiser/tm:*)', 'Bash(rg:*)', 'Bash(grep:*)', 'Bash(git grep:*)', 'Bash(ls:*)', 'Bash(find:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(sed:*)', 'Bash(wc:*)'];

function run(task, setup, rep) {
  const s = SETUPS[setup];
  const args = ['-p', task.q + ' Be concise.', '--model', model, '--output-format', 'stream-json', '--verbose', '--allowedTools', ...TOOLS, '--disallowedTools', 'Task', 'Agent'];
  if (s.plugin) args.push('--plugin-dir', plugin);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bench-'));
  return new Promise((resolve) => {
    const p = spawn('claude', args, { cwd: repo, env: { ...process.env, ...s.env, TOKENMISER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    p.stdout.on('data', (d) => (so += d));
    p.on('close', () => {
      const events = so.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
      const j = events.find((e) => e.type === 'result') ?? {};
      const calls = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c) => c.type === 'tool_use'));
      const u = j.usage ?? {};
      const row = {
        task: task.id, setup, rep,
        ok: [].concat(task.expect).some((e) => String(j.result ?? '').includes(e)),
        turns: j.num_turns ?? null,
        toolCalls: calls.length,
        indexCalls: calls.filter((c) => String(c.input?.command ?? '').includes('.tokenmiser/tm')).length,
        reads: calls.filter((c) => c.name === 'Read').length,
        enriched: so.includes('[tokenmiser] enclosing definitions'),
        input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        uncached: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        output: u.output_tokens ?? 0,
        cost: j.total_cost_usd ?? null,
        tools: calls.map((c) => `${c.name}:${JSON.stringify(c.input).slice(0, 100)}`),
        answer: String(j.result ?? '').slice(0, 600),
      };
      process.stderr.write(`${setup.padEnd(13)} ${task.id.padEnd(22)} rep${rep} turns=${row.turns} tools=${row.toolCalls} tm=${row.indexCalls} in=${row.input} out=${row.output} $${row.cost?.toFixed?.(4)} ${row.ok ? 'ok' : 'MISS'}\n`);
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
console.log(`\n${tasks.length} tasks × ${reps} reps, model ${model}, repo ${path.basename(repo)}\n`);
console.log('setup          correct  avg turns  avg tools  used index  avg input tok  avg output tok  avg cost');
for (const s of Object.keys(SETUPS)) {
  const r = rows.filter((x) => x.setup === s);
  console.log(`${s.padEnd(14)} ${`${r.filter((x) => x.ok).length}/${r.length}`.padEnd(8)} ${avg(r.map((x) => x.turns)).toFixed(1).padEnd(10)} ${avg(r.map((x) => x.toolCalls)).toFixed(1).padEnd(10)} ${`${r.filter((x) => x.indexCalls || x.enriched).length}/${r.length}`.padEnd(11)} ${Math.round(avg(r.map((x) => x.input))).toLocaleString().padEnd(14)} ${Math.round(avg(r.map((x) => x.output))).toLocaleString().padEnd(15)} $${avg(r.map((x) => x.cost ?? 0)).toFixed(4)}`);
}
