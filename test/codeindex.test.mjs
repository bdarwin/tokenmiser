import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractSymbols, findSymbol, loadIndex, outline, refs, repoMap } from '../plugins/tokenmiser/scripts/lib/codeindex.mjs';
import { DEFAULTS } from '../plugins/tokenmiser/scripts/lib/config.mjs';
import { inspect } from '../plugins/tokenmiser/scripts/lib/guard.mjs';

const CLI = new URL('../plugins/tokenmiser/scripts/tokenmiser.mjs', import.meta.url).pathname;
const names = (text, lang) => extractSymbols(text, lang).map((s) => `${s.name}@${s.line}-${s.end}`);

test('js/ts: classes, methods, functions, arrows, types', () => {
  const src = [
    "import { x } from './util';", // 1
    'export interface Opts { a: number }', // 2
    'export type Id = string;', // 3
    'export class Cart {', // 4
    '  constructor() {}', // 5
    '  addItem(item: Item): void {', // 6
    '    if (item) {', // 7
    '    }', // 8
    '  }', // 9
    '  async total() {', // 10
    '    return 1;', // 11
    '  }', // 12
    '}', // 13
    '', // 14
    '/** Helper. */', // 15
    'export const applyDiscount = (c, pct) => c * pct;', // 16
    'export default async function main() {}', // 17
  ].join('\n');
  assert.deepEqual(names(src, 'js'), ['Opts@2-2', 'Id@3-3', 'Cart@4-13', 'addItem@6-9', 'total@10-12', 'applyDiscount@16-16', 'main@17-17']);
});

test('python: nested classes and defs with ranges', () => {
  const src = ['class Repo:', '    def get(self, id):', '        return id', '', '    async def save(self):', '        pass', '', '', 'def helper():', '    return 2'].join('\n');
  assert.deepEqual(names(src, 'py'), ['Repo@1-6', 'get@2-3', 'save@5-6', 'helper@9-10']);
});

test('go, rust, java, ruby, php, c, markdown', () => {
  assert.deepEqual(names('type Server struct {\n}\nfunc (s *Server) Start() error {\n}\nfunc New() *Server {\n}', 'go').map((n) => n.split('@')[0]), ['Server', 'Start', 'New']);
  assert.deepEqual(names('pub struct Pool {}\nimpl Pool {\n    pub async fn get(&self) {}\n}\nfn main() {}', 'rs').map((n) => n.split('@')[0]), ['Pool', 'Pool', 'get', 'main']);
  assert.deepEqual(names('public class Bank {\n  public static int balance(String id) {\n    return 0;\n  }\n}', 'java').map((n) => n.split('@')[0]), ['Bank', 'balance']);
  assert.deepEqual(names('module Billing\n  class Invoice\n    def paid?\n    end\n  end\nend', 'rb').map((n) => n.split('@')[0]), ['Billing', 'Invoice', 'paid?']);
  assert.deepEqual(names('<?php\nclass User {\n  public function save() {}\n}', 'php').map((n) => n.split('@')[0]), ['User', 'save']);
  assert.deepEqual(names('#define MAX 10\nstruct node {\n};\nstatic int parse_args(int argc, char **argv)\n{\n}', 'c').map((n) => n.split('@')[0]), ['MAX', 'node', 'parse_args']);
  assert.deepEqual(names('# Title\n```\n# not a heading\n```\n## Install', 'md').map((n) => n.split('@')[0]), ['Title', 'Install']);
});

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-idx-'));
  const w = (f, t) => (fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), t));
  w('src/cart.ts', "import { money } from './money';\nexport class Cart {\n  checkout() {\n    return money(1);\n  }\n}\n");
  w('src/money.ts', 'export function money(n: number) {\n  return n;\n}\n');
  w('src/checkout.ts', "import { money } from './money';\nexport const pay = () => money(2);\n");
  w('test/cart.test.ts', "import { Cart } from '../src/cart';\nfunction checkoutWorks() {}\n");
  w('node_modules/dep/index.js', 'function hidden() {}\n');
  w('.gitignore', 'node_modules\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  return { root, w };
}

test('index: respects .gitignore, finds symbols, refreshes incrementally', () => {
  const { root, w } = makeRepo();
  let idx = loadIndex(root);
  assert.equal(idx.changed, 4);
  assert.ok(!Object.keys(idx.files).some((f) => f.includes('node_modules')));
  assert.ok(fs.existsSync(path.join(root, '.tokenmiser', 'index.json')));
  assert.equal(fs.readFileSync(path.join(root, '.tokenmiser', '.gitignore'), 'utf8'), '*\n');

  const hit = findSymbol(idx, 'money').hits[0];
  assert.deepEqual([hit.file, hit.line, hit.end], ['src/money.ts', 1, 3]);
  // exact matches win; non-test files rank before tests for fuzzy matches
  assert.equal(findSymbol(idx, 'checkout').hits[0].file, 'src/cart.ts');

  idx = loadIndex(root);
  assert.equal(idx.changed, 0, 'nothing re-parsed when nothing changed');
  w('src/money.ts', 'export function money(n: number) {\n  return n;\n}\nexport function cents(n) {}\n');
  idx = loadIndex(root);
  assert.equal(idx.changed, 1);
  assert.equal(findSymbol(idx, 'cents').hits[0].line, 4);
});

test('outline, map and refs', () => {
  const { root } = makeRepo();
  const idx = loadIndex(root);
  assert.match(outline(idx, path.join(root, 'src/cart.ts')), /src\/cart\.ts — \d+ lines, 2 symbols\nL2-6  export class Cart\n  L3-5  checkout\(\)/);
  const map = repoMap(idx, { budget: 1000 });
  assert.ok(map.indexOf('src/money.ts') < map.indexOf('test/cart.test.ts'), 'imported file ranks above tests');
  assert.ok(repoMap(idx, { budget: 10 }).includes('more files'), 'budget is respected');
  assert.match(refs(root, 'money'), /^\d+ uses of "money" in 3 files/);
});

test('guard hands over an outline for big source files and DuckDB/shell advice for data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-guard-'));
  const body = Array.from({ length: 800 }, (_, i) => `function f${i}() {\n  return ${i};\n}\n`).join('');
  fs.writeFileSync(path.join(dir, 'big.js'), body);
  fs.writeFileSync(path.join(dir, 'rows.csv'), 'a,b\n' + '1,2\n'.repeat(10_000));
  const hit = inspect({ tool: 'view', args: { path: 'big.js' }, cwd: dir }, DEFAULTS);
  assert.match(hit.reason, /Outline:\nbig\.js — \d+ lines, 800 symbols\nL1-3  function f0\(\)/);
  assert.ok(hit.reason.length < 6000, 'outline is capped');
  const data = inspect({ tool: 'view', args: { path: 'rows.csv' }, cwd: dir }, DEFAULTS);
  assert.match(data.reason, /data file/);
  assert.match(data.reason, /duckdb|head -n 5/);
});

test('CLI: with index on, session start creates the tm shim and advertises it (off by default)', () => {
  const { root } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-home-'));
  const r = spawnSync('node', [CLI, 'hook', 'session-start', '--agent', 'copilot'], { input: JSON.stringify({ sessionId: 's', cwd: root }), encoding: 'utf8', env: { ...process.env, TOKENMISER_HOME: home, TOKENMISER_INDEX: '1' } });
  const ctx = JSON.parse(r.stdout).additionalContext;
  assert.match(ctx, /`\.tokenmiser\/tm sym X`/);
  assert.match(ctx, /built-in "explore" agent/);
  const out = execFileSync(path.join(root, '.tokenmiser', 'tm'), ['sym', 'money'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /^src\/money\.ts:1-3  export function money/);
  const off = spawnSync('node', [CLI, 'hook', 'session-start'], { input: JSON.stringify({ cwd: root }), encoding: 'utf8', env: { ...process.env, TOKENMISER_HOME: home } });
  assert.doesNotMatch(JSON.parse(off.stdout).additionalContext, /Code index/);
});

test('search enrichment names the enclosing definition and its range', async () => {
  const { enrichSearch } = await import('../plugins/tokenmiser/scripts/lib/enrich.mjs');
  const { root } = makeRepo();
  const note = enrichSearch('src/cart.ts:4:    return money(1);\nsrc/money.ts:2:  return n;\n', { cwd: root });
  assert.match(note, /src\/cart\.ts: L4 in Cart\.checkout \(L3-5\)/);
  assert.match(note, /src\/money\.ts: L2 in money \(L1-3\)/);
  // grep on a single file prints no filename: take it from the command
  assert.match(enrichSearch('4:    return money(1);', { cwd: root, command: 'grep -n money src/cart.ts' }), /Cart\.checkout/);
  assert.equal(enrichSearch('no hits here', { cwd: root }), null);
});

test('post-tool hook: compression and enrichment together, both dialects', () => {
  const { root } = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-home-'));
  const run = (agent, payload) => JSON.parse(spawnSync('node', [CLI, 'hook', 'post-tool', '--agent', agent], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, TOKENMISER_HOME: home } }).stdout);
  const cp = run('copilot', { sessionId: 's', cwd: root, toolName: 'rg', toolArgs: '{}', toolResult: { resultType: 'success', textResultForLlm: 'src/money.ts:2:  return n;' } });
  assert.match(cp.additionalContext, /in money \(L1-3\)/);
  assert.equal(cp.modifiedResult, undefined, 'small result left as is');
  const cl = run('claude', { session_id: 's', cwd: root, tool_name: 'Grep', tool_input: { pattern: 'money' }, tool_response: { mode: 'content', content: 'src/cart.ts:4:    return money(1);' } });
  assert.match(cl.hookSpecificOutput.additionalContext, /Cart\.checkout/);
  assert.equal(cl.hookSpecificOutput.updatedToolOutput, undefined);
});

test('read snapping extends a partial read to the end of its definition', async () => {
  const { snapRead } = await import('../plugins/tokenmiser/scripts/lib/snap.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-snap-'));
  const lines = ['import x', '', '@decorator', 'def short():', '    return 1', '', 'def long_one():', ...Array.from({ length: 30 }, (_, i) => `    step_${i}()`), '', 'def huge():', ...Array.from({ length: 400 }, () => '    pass')];
  fs.writeFileSync(path.join(dir, 'm.py'), lines.join('\n'));
  const cfg = { snapMaxLines: 150 };
  // Claude Read cut short inside long_one (L7-37): extended to its end
  const r = snapRead({ tool: 'Read', cwd: dir, args: { file_path: 'm.py', offset: 7, limit: 10 } }, cfg);
  assert.deepEqual([r.args.limit, r.symbol, r.added], [31, 'long_one', 21]);
  // Copilot view starting on the decorator line above a def
  const v = snapRead({ tool: 'view', cwd: dir, args: { path: 'm.py', view_range: [6, 8] } }, cfg);
  assert.deepEqual(v.args.view_range, [6, 37]);
  // already covers the definition, open-ended, or huge definition: untouched
  assert.equal(snapRead({ tool: 'Read', cwd: dir, args: { file_path: 'm.py', offset: 4, limit: 5 } }, cfg), null);
  assert.equal(snapRead({ tool: 'view', cwd: dir, args: { path: 'm.py', view_range: [7, -1] } }, cfg), null);
  assert.equal(snapRead({ tool: 'Read', cwd: dir, args: { file_path: 'm.py', offset: 39, limit: 20 } }, cfg), null);
  assert.equal(snapRead({ tool: 'Read', cwd: dir, args: { file_path: 'm.py' } }, cfg), null);
});

test('pre-tool hook emits rewrites in both dialects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-snap2-'));
  fs.writeFileSync(path.join(dir, 'a.js'), ['function f() {', ...Array.from({ length: 20 }, () => '  x();'), '}'].join('\n'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-home-'));
  const run = (agent, payload) => JSON.parse(spawnSync('node', [CLI, 'hook', 'pre-tool', '--agent', agent], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, TOKENMISER_HOME: home } }).stdout);
  assert.deepEqual(run('copilot', { cwd: dir, toolName: 'view', toolArgs: JSON.stringify({ path: 'a.js', view_range: [1, 5] }) }).modifiedArgs.view_range, [1, 22]);
  const cl = run('claude', { cwd: dir, tool_name: 'Read', tool_input: { file_path: 'a.js', offset: 1, limit: 5 } });
  assert.equal(cl.hookSpecificOutput.updatedInput.limit, 22);
  assert.equal(cl.hookSpecificOutput.permissionDecision, undefined, 'never auto-approves');
});

test('search enrichment understands Copilot rg grouped output', async () => {
  const { enrichSearch } = await import('../plugins/tokenmiser/scripts/lib/enrich.mjs');
  const { root } = makeRepo();
  const out = '[grep content: 2 matches across 2 file(s) under src]\nmoney.ts:2:   return n;\n\ncart.ts (2 match(es)):\n  3:   checkout() {\n  4:     return money(1);\n';
  const note = enrichSearch(out, { cwd: root });
  assert.match(note, /src\/money\.ts: L2 in money \(L1-3\)/);
  assert.match(note, /src\/cart\.ts: L3,L4 in Cart\.checkout \(L3-5\)/);
});

test('Copilot read_file / grep_search tool shapes are supported', async () => {
  const { snapRead } = await import('../plugins/tokenmiser/scripts/lib/snap.mjs');
  const { enrichSearch } = await import('../plugins/tokenmiser/scripts/lib/enrich.mjs');
  const { root } = makeRepo();
  const big = path.join(root, 'src/big.py');
  fs.writeFileSync(big, ['def long_one():', ...Array.from({ length: 30 }, (_, i) => `    step_${i}()`), ''].join('\n') + 'x = 1\n'.repeat(4000));
  const s = snapRead({ tool: 'read_file', cwd: root, args: { filePath: big, startLine: 1, endLine: 10 } }, { snapMaxLines: 150 });
  assert.equal(s.args.endLine, 31);
  assert.ok(inspect({ tool: 'read_file', cwd: root, args: { filePath: big } }, DEFAULTS), 'whole-file read_file is guarded');
  assert.equal(inspect({ tool: 'read_file', cwd: root, args: { filePath: big, startLine: 1, endLine: 40 } }, DEFAULTS), null);
  const out = `2 matches\n\`\`\`txt\n<match path="${path.join(root, 'src/cart.ts')}" line=4>\n    return money(1);\n</match>\n\`\`\``;
  assert.match(enrichSearch(out, { cwd: root }), /src\/cart\.ts: L4 in Cart\.checkout \(L3-5\)/);
});

test('search enrichment locates hits that came back without line numbers', async () => {
  const { enrichSearch } = await import('../plugins/tokenmiser/scripts/lib/enrich.mjs');
  const { root } = makeRepo();
  const out = `${path.join(root, 'src/money.ts')}:export function money(n: number) {  [×3]\n`;
  assert.match(enrichSearch(out, { cwd: root }), /src\/money\.ts: L1 in money \(L1-3\)/);
  assert.match(enrichSearch('src/cart.ts:  checkout() {', { cwd: root }), /src\/cart\.ts: L3 in Cart\.checkout \(L3-5\)/);
});
