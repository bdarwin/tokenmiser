#!/usr/bin/env node
// Replays a fixed sequence of tool calls through the real Copilot CLI, with and
// without tokenmiser, and reports what Copilot actually sends to the model.
// No Copilot subscription or API key needed: a scripted fake model (BYOK mode)
// issues the tool calls and records every request.
//
//   node bench/copilot-replay.mjs <repo-dir> [--script bench/replay-flask.json] [--copilot copilot]
//
// The fake model doesn't react to results (it can't retry a blocked read, for
// example), so this measures per-call payloads, not a whole agent's behaviour.
// Runs with --allow-all: point it at a throwaway clone.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const repo = path.resolve(argv[0] ?? '.');
const script = JSON.parse(fs.readFileSync(path.resolve(opt('script', fileURLToPath(new URL('./replay-flask.json', import.meta.url)))), 'utf8').replaceAll('{repo}', repo));
const bin = opt('copilot', 'copilot');
const plugin = path.resolve(opt('plugin', fileURLToPath(new URL('../plugins/tokenmiser', import.meta.url))));

// Each setup's call sequence: every step, then that setup's follow-up calls for it.
function plan(setup) {
  return script.steps.flatMap((st, i) => [{ ...st, row: i }, ...(st.followUps?.[setup] ?? []).map((f) => ({ ...f, row: i, followUp: true }))]);
}

function fakeModel(steps, log) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      if (!req.url.includes('chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'gpt-5.4', object: 'model' }] }));
      }
      log.push({ messages: j.messages, tools: j.tools ?? [] });
      const n = j.messages.filter((m) => m.role === 'tool').length;
      const step = steps[n];
      if (step) {
        // {lastSpill}: the file Copilot saved the previous oversized output to
        const prev = [...j.messages].reverse().find((m) => m.role === 'tool');
        const spill = String(prev?.content ?? '').match(/(?:Saved to|full output): (\S+?)\]?(?:\s|$)/)?.[1] ?? '';
        step.args = JSON.parse(JSON.stringify(step.args).replaceAll('{lastSpill}', spill));
      }
      const delta = step
        ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
        : { role: 'assistant', content: 'Done.' };
      const chunk = (d, f = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'gpt-5.4', choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk(delta) + chunk({}, step ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    });
  });
}

async function session(setup) {
  const log = [];
  const steps = plan(setup);
  const server = fakeModel(steps, log);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-replay-'));
  const args = ['-p', 'go', '--allow-all', '--no-color', ...(setup === 'plugin' ? ['--plugin-dir', plugin] : [])];
  const env = {
    ...process.env,
    COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    COPILOT_PROVIDER_API_KEY: 'replay-dummy-key',
    COPILOT_MODEL: 'gpt-5.4',
    TOKENMISER_HOME: home,
    ...(setup === 'none' ? { TOKENMISER_DISABLE: '1' } : {}),
  };
  if (script.prepare) execSync(script.prepare, { cwd: repo, shell: '/bin/bash' });
  try {
    await new Promise((resolve) => spawn(bin, args, { cwd: repo, env, stdio: 'ignore' }).on('close', resolve));
  } finally {
    if (script.cleanup) execSync(script.cleanup, { cwd: repo, shell: '/bin/bash' });
    server.close();
  }
  const last = log[log.length - 1]?.messages ?? [];
  const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
  const toolMsgs = last.filter((m) => m.role === 'tool').map(text);
  // The conversation is re-sent on every request, so a big early result is paid for
  // again and again. "resent" counts the conversation only; "fullInput" adds the
  // system prompt and tool definitions Copilot sends with every request.
  const resent = log.reduce((n, r) => n + r.messages.slice(1).reduce((k, m) => k + text(m).length, 0), 0);
  const fullInput = log.reduce((n, r) => n + JSON.stringify(r.messages).length + JSON.stringify(r.tools).length, 0);
  // Per original step: number of calls and total chars of their results.
  const rows = script.steps.map(() => ({ calls: 0, chars: 0 }));
  steps.forEach((st, k) => {
    rows[st.row].calls++;
    rows[st.row].chars += (toolMsgs[k] ?? '').length;
  });
  return { toolMsgs, rows, steps, requests: log.length, resent, fullInput };
}

const res = { none: await session('none'), plugin: await session('plugin') };
const tok = (c) => `~${Math.round(c / 4).toLocaleString()}`;
console.log(`\nWhat Copilot CLI sent to the model, per tool call (tokens ≈ chars/4) — ${path.basename(repo)}\n`);
console.log('| Step | Without tokenmiser | With tokenmiser |');
console.log('|---|---|---|');
const cell = (r) => `${tok(r.chars)}${r.calls > 1 ? ` (${r.calls} calls)` : ''}`;
script.steps.forEach((s, i) => console.log(`| ${s.label} | ${cell(res.none.rows[i])} | ${cell(res.plugin.rows[i])} |`));
const sum = (r) => r.rows.reduce((n, x) => n + x.chars, 0);
console.log(`| **All tool results** | **${tok(sum(res.none))}** (${res.none.steps.length} calls) | **${tok(sum(res.plugin))}** (${res.plugin.steps.length} calls) |`);
console.log(`| Conversation re-sent to the model, summed over all requests | ~${(res.none.resent / 4 / 1000).toFixed(1)}k | ~${(res.plugin.resent / 4 / 1000).toFixed(1)}k |`);
const pct = Math.round((res.plugin.fullInput / res.none.fullInput - 1) * 100);
console.log(`| **Total input tokens incl. system prompt + tool definitions** (${res.none.requests} vs ${res.plugin.requests} requests) | **~${(res.none.fullInput / 4 / 1000).toFixed(0)}k** | **~${(res.plugin.fullInput / 4 / 1000).toFixed(0)}k (${pct > 0 ? '+' : ''}${pct}%)** |`);
if (argv.includes('--show')) {
  for (const [k, r] of Object.entries(res)) r.toolMsgs.forEach((t, i) => console.log(`\n===== ${k} · ${script.steps[r.steps[i].row].label}${r.steps[i].followUp ? ' (follow-up)' : ''}\n${t.slice(0, 3000)}`));
}
