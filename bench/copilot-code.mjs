#!/usr/bin/env node
// Coding benchmark for GitHub Copilot CLI: plant one bug in a fresh clone, ask the
// agent to find and fix it, then verify by running the whole test suite.
//
//   node bench/copilot-code.mjs <repo-dir> --py <python-with-deps> [--tasks bench/code-tasks-flask.json]
//                               [--reps 2] [--jobs 2] [--model <id>] [--out bench/copilot-code-results.json]
//
// <repo-dir> must be a clean git clone whose tests pass with `PYTHONPATH=src <py> -m pytest`.
// Every run works in its own throwaway `git clone` copy. The agent runs with
// --allow-all-tools --allow-all-paths, so use this on a machine/repo where that is acceptable.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const repo = path.resolve(argv[0] ?? '.');
const py = path.resolve(opt('py', 'python3'));
const reps = Number(opt('reps', 2));
const jobs = Number(opt('jobs', 2));
const model = opt('model', null);
const bin = opt('copilot', 'copilot');
const out = opt('out', fileURLToPath(new URL('./copilot-code-results.json', import.meta.url)));
const plugin = fileURLToPath(new URL('../plugins/tokenmiser', import.meta.url));
const tasks = JSON.parse(fs.readFileSync(path.resolve(opt('tasks', fileURLToPath(new URL('./code-tasks-flask.json', import.meta.url)))), 'utf8'));
const testCmd = `PYTHONPATH=src ${py} -m pytest`;
const PROMPT = `Some tests in this repository fail. Find the bug in src/ and fix it. Do not modify anything under tests/. Run the tests with: \`${testCmd}\` (add any pytest options you like). You are done when the whole suite passes. Be concise.`;

let installed = false;
try {
  installed = /tokenmiser/.test(execFileSync(bin, ['plugin', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
} catch {}
const SETUPS = {
  none: { args: [], env: { TOKENMISER_DISABLE: '1' } },
  plugin: { args: installed ? [] : ['--plugin-dir', plugin], env: {} },
};

function parseUsage(text) {
  const num = (s) => {
    if (!s) return 0;
    const m = s.replace(/,/g, '').match(/([\d.]+)\s*([kKmM]?)/);
    return m ? Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] ?? 1)) : 0;
  };
  const line = text.split('\n').find((l) => /^\s*Tokens\b/.test(l)) ?? '';
  return {
    input: num(line.split('•')[0].match(/↑\s*([\d.,]+\s*[kKmM]?)/)?.[1]),
    output: num(line.match(/↓\s*([\d.,]+\s*[kKmM]?)/)?.[1]),
    credits: parseFloat(text.match(/^\s*AI Credits\s+([\d.]+)/im)?.[1] ?? 'NaN'),
  };
}

function sh(cmd, cwd) {
  try {
    return { ok: true, out: execFileSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function run(task, setup, rep) {
  const s = SETUPS[setup];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-code-'));
  const work = path.join(tmp, 'repo');
  execFileSync('git', ['clone', '-q', repo, work], { stdio: 'ignore' });
  const file = path.join(work, task.file);
  const src = fs.readFileSync(file, 'utf8');
  if (src.split(task.find).length !== 2) throw new Error(`${task.id}: "find" must match exactly once`);
  fs.writeFileSync(file, src.replace(task.find, task.replace));
  execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', 'commit', '-qam', 'baseline'], { cwd: work });

  const share = path.join(tmp, 'session.md');
  const args = ['-p', PROMPT, '--allow-all-tools', '--allow-all-paths', '--no-color', '--share', share, ...s.args];
  if (model) args.push('--model', model);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd: work, env: { ...process.env, ...s.env, TOKENMISER_HOME: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    p.stdout.on('data', (d) => (so += d));
    p.stderr.on('data', (d) => (so += d));
    p.on('close', () => {
      const seconds = Math.round((Date.now() - t0) / 1000);
      const suite = sh(`${testCmd} -q -p no:cacheprovider`, work);
      const testsTouched = sh('git status --porcelain -- tests', work).out.trim() !== '';
      const fixedLine = fs.readFileSync(file, 'utf8').includes(task.find);
      let md = '';
      try {
        md = fs.readFileSync(share, 'utf8');
      } catch {}
      const tm = {};
      try {
        for (const l of fs.readFileSync(path.join(tmp, 'stats.jsonl'), 'utf8').split('\n').filter(Boolean)) {
          const k = JSON.parse(l).kind;
          tm[k] = (tm[k] ?? 0) + 1;
        }
      } catch {}
      const row = {
        task: task.id, setup, rep, seconds,
        ok: suite.ok && !testsTouched,
        exactFix: fixedLine,
        suite: suite.out.trim().split('\n').pop(),
        toolCalls: (md.match(/^### `/gm) ?? []).length,
        ...parseUsage(so),
        tm,
      };
      process.stderr.write(`${setup.padEnd(7)} ${task.id.padEnd(16)} rep${rep} ${row.ok ? 'FIXED' : 'FAILED'} tools=${row.toolCalls} credits=${row.credits} in=${row.input} out=${row.output} ${seconds}s tm=${JSON.stringify(tm)}\n`);
      fs.rmSync(work, { recursive: true, force: true });
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
const pct = (a, b) => (b ? `${((a / b - 1) * 100).toFixed(0)}%` : '');
console.log(`\n${tasks.length} bug-fix tasks × ${reps} reps, repo ${path.basename(repo)}${model ? `, model ${model}` : ''}${installed ? ' (using the installed plugin)' : ''}\n`);
console.log('setup    fixed   tool calls  input tok  output tok  AI credits  seconds');
for (const s of Object.keys(SETUPS)) {
  const r = rows.filter((x) => x.setup === s);
  console.log(`${s.padEnd(8)} ${`${r.filter((x) => x.ok).length}/${r.length}`.padEnd(7)} ${of(s, 'toolCalls').toFixed(1).padEnd(11)} ${Math.round(of(s, 'input')).toLocaleString().padEnd(10)} ${Math.round(of(s, 'output')).toLocaleString().padEnd(11)} ${of(s, 'credits').toFixed(2).padEnd(11)} ${of(s, 'seconds').toFixed(0)}`);
}
console.log(`\nplugin vs none: AI credits ${pct(of('plugin', 'credits'), of('none', 'credits'))}, input ${pct(of('plugin', 'input'), of('none', 'input'))}, tool calls ${pct(of('plugin', 'toolCalls'), of('none', 'toolCalls'))}`);
console.log(`Raw rows: ${out}`);
