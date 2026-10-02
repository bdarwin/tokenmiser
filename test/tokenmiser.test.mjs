import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { normalize } from '../plugins/tokenmiser/scripts/lib/adapters.mjs';
import { compress } from '../plugins/tokenmiser/scripts/lib/compress.mjs';
import { DEFAULTS } from '../plugins/tokenmiser/scripts/lib/config.mjs';
import { digestSavedOutput } from '../plugins/tokenmiser/scripts/lib/digest.mjs';
import { inspect } from '../plugins/tokenmiser/scripts/lib/guard.mjs';

const CLI = new URL('../plugins/tokenmiser/scripts/tokenmiser.mjs', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-test-'));

function hook(event, payload, agent = 'copilot', env = {}) {
  const r = spawnSync('node', [CLI, 'hook', event, '--agent', agent], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, TOKENMISER_HOME: path.join(tmp, 'home'), ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const testRun = (n) =>
  [
    '\x1b[32mnpm WARN deprecated foo@1.0.0\x1b[0m',
    ...Array.from({ length: 30 }, (_, i) => `\r[${'#'.repeat(i)}] ${i}%`),
    ...Array.from({ length: n }, (_, i) => `  ✓ handles case ${i} (${i}ms)`),
    '  ✗ checkout applies discount',
    '    AssertionError: expected 90 to equal 81',
    '      at Context.<anonymous> (test/checkout.test.js:42:17)',
    ...Array.from({ length: n }, (_, i) => `  ✓ api returns 200 for route ${i}`),
    `Tests: 1 failed, ${2 * n} passed`,
  ].join('\n');

test('compress keeps failures and the summary, drops the noise', () => {
  const input = testRun(400);
  const res = compress(input, DEFAULTS);
  assert.ok(res.changed);
  assert.ok(res.after < input.length / 10, `${res.after} vs ${input.length}`);
  assert.match(res.text, /AssertionError: expected 90 to equal 81/);
  assert.match(res.text, /checkout\.test\.js:42:17/);
  assert.match(res.text, /Tests: 1 failed, 800 passed/);
  assert.doesNotMatch(res.text, /\x1b\[/);
  assert.doesNotMatch(res.text, /####/);
});

test('compress leaves small, clean output untouched', () => {
  const input = 'On branch main\nnothing to commit, working tree clean';
  const res = compress(input, DEFAULTS);
  assert.equal(res.changed, false);
  assert.equal(res.text, input);
});

test('compress collapses identical lines', () => {
  const res = compress(Array(50).fill('retrying connection...').join('\n'), DEFAULTS);
  assert.equal(res.text, 'retrying connection...  [×50]');
});

test('compress truncates long unique output, keeps middle errors and spills', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `row ${i} ${Math.random().toString(36)}`);
  lines[1500] = 'src/app.ts:120:7 - error TS2322: Type string is not assignable to number';
  let spilled = null;
  const res = compress(lines.join('\n'), DEFAULTS, (t) => ((spilled = t), '.tokenmiser/spill/x.log'));
  assert.ok(res.truncated);
  assert.ok(res.after <= DEFAULTS.maxChars + 200);
  assert.match(res.text, /error TS2322/);
  assert.match(res.text, /full output: \.tokenmiser\/spill\/x\.log/);
  assert.equal(spilled, lines.join('\n'));
});

test('search results keep line numbers when collapseSimilar is off', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `src/a.js:${i * 10}: const x = foo();`).join('\n');
  const res = compress(lines, { ...DEFAULTS, collapseSimilar: false });
  assert.equal(res.changed, false);
});

test('normalize understands Copilot and Claude payloads', () => {
  const c = normalize({ sessionId: 's', cwd: '/w', toolName: 'bash', toolArgs: '{"command":"ls"}', toolResult: { resultType: 'success', textResultForLlm: 'out' } });
  assert.deepEqual([c.tool, c.args.command, c.resultText], ['bash', 'ls', 'out']);
  const k = normalize({ session_id: 's', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a', stderr: 'b' } });
  assert.deepEqual([k.tool, k.args.command, k.resultText], ['Bash', 'ls', 'a\nb']);
});

test('guard flags big files, generated files and recursive listings only', () => {
  fs.writeFileSync(path.join(tmp, 'big.txt'), 'x'.repeat(DEFAULTS.bigFileBytes + 1));
  fs.writeFileSync(path.join(tmp, 'small.txt'), 'hello');
  fs.writeFileSync(path.join(tmp, 'yarn.lock'), 'y'.repeat(DEFAULTS.generatedFileBytes + 1));
  const call = (tool, args) => inspect({ tool, args, cwd: tmp }, DEFAULTS);
  assert.ok(call('view', { path: 'big.txt' }));
  assert.equal(call('view', { path: 'big.txt', view_range: [1, 50] }), null);
  assert.equal(call('view', { path: 'small.txt' }), null);
  assert.match(call('Read', { file_path: 'yarn.lock' }).reason, /generated/);
  assert.equal(call('Read', { file_path: 'big.txt', limit: 100 }), null);
  assert.ok(call('bash', { command: 'cat big.txt' }));
  assert.equal(call('bash', { command: 'cat big.txt | grep foo' }), null);
  assert.ok(call('bash', { command: 'ls -R' }));
  assert.equal(call('bash', { command: 'ls -la' }), null);
});

test('digest replaces Copilot spill preview with a useful summary', () => {
  const file = path.join(tmp, 'copilot-tool-output.txt');
  fs.writeFileSync(file, testRun(1500));
  const preview = `Output too large to read at once (60.1 KB). Saved to: ${file}\nConsider using tools like rg...\n\nPreview (first 500 chars):\nnpm WARN\n<shellId: 3 completed with exit code 1>`;
  const d = digestSavedOutput(preview, DEFAULTS);
  assert.match(d.text, /AssertionError/);
  assert.match(d.text, /Tests: 1 failed/);
  assert.match(d.text, /<shellId: 3 completed with exit code 1>$/);
  assert.ok(d.text.includes(file));
  assert.equal(digestSavedOutput('plain output', DEFAULTS), null);
});

test('copilot hooks: session start, deny-once guard, post-tool compression', () => {
  const ctx = hook('session-start', { sessionId: 'a', cwd: tmp });
  assert.match(ctx.additionalContext, /Credit-saving mode/);

  const pre = { sessionId: 'a', cwd: tmp, toolName: 'view', toolArgs: JSON.stringify({ path: 'big.txt' }) };
  assert.equal(hook('pre-tool', pre).permissionDecision, 'deny');
  assert.equal(hook('pre-tool', pre), null, 'identical retry is allowed');
  assert.equal(hook('pre-tool', { ...pre, sessionId: 'b' }).permissionDecision, 'deny', 'memory is per session');

  const post = hook('post-tool', { sessionId: 'a', cwd: tmp, toolName: 'bash', toolArgs: '{}', toolResult: { resultType: 'success', textResultForLlm: testRun(300) } });
  assert.equal(post.modifiedResult.resultType, 'success');
  assert.match(post.modifiedResult.textResultForLlm, /AssertionError/);

  assert.equal(hook('post-tool', { sessionId: 'a', cwd: tmp, toolName: 'edit', toolResult: { textResultForLlm: testRun(300) } }), null, 'edit results untouched');
  assert.equal(hook('post-tool', { sessionId: 'a', cwd: tmp, toolName: 'bash', toolArgs: '{"command":"cat src/app.py"}', toolResult: { textResultForLlm: testRun(300) } }), null, 'explicit file dumps untouched');
  assert.equal(hook('post-tool', { sessionId: 'a', cwd: tmp, toolName: 'bash', toolResult: { textResultForLlm: testRun(300) } }, 'copilot', { TOKENMISER_DISABLE: '1' }), null);
});

test('claude hooks use hookSpecificOutput', () => {
  const ctx = hook('session-start', { session_id: 'c', cwd: tmp }, 'claude');
  assert.match(ctx.hookSpecificOutput.additionalContext, /Credit-saving mode/);
  const deny = hook('pre-tool', { session_id: 'c', cwd: tmp, tool_name: 'Read', tool_input: { file_path: 'big.txt' } }, 'claude');
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  const post = hook('post-tool', { session_id: 'c', cwd: tmp, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: testRun(300), stderr: '' } }, 'claude');
  assert.match(post.hookSpecificOutput.updatedToolOutput.stdout, /AssertionError/);
  assert.equal(post.hookSpecificOutput.updatedToolOutput.stderr, "");
});

test('hooks fail open on garbage input', () => {
  const r = spawnSync('node', [CLI, 'hook', 'pre-tool'], { input: 'not json', encoding: 'utf8', env: { ...process.env, TOKENMISER_HOME: path.join(tmp, 'home') } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('stats reports savings', () => {
  const r = spawnSync('node', [CLI, 'stats', '--json'], { encoding: 'utf8', env: { ...process.env, TOKENMISER_HOME: path.join(tmp, 'home') } });
  const s = JSON.parse(r.stdout);
  assert.ok(s.compressions >= 2);
  assert.ok(s.readsBlocked >= 3);
  assert.ok(s.tokensSavedTotal > 1000);
});

test('passing-test lines are folded, failures kept', () => {
  const out = [
    'collected 6 items',
    'tests/test_a.py::test_one PASSED                [ 16%]',
    'tests/test_a.py::test_error_handling PASSED     [ 33%]',
    'tests/test_a.py::test_three PASSED              [ 50%]',
    'tests/test_a.py::test_four PASSED               [ 66%]',
    'tests/test_b.py::test_five FAILED               [ 83%]',
    'tests/test_b.py::test_six PASSED                [100%]',
    '=== 1 failed, 5 passed ===',
  ].join('\n');
  const res = compress(out, { ...DEFAULTS, minSavings: 0 });
  assert.match(res.text, /… 4 passing test lines …\ntests\/test_b\.py::test_five FAILED/);
  assert.match(res.text, /test_six PASSED/, 'short runs are kept');
});
