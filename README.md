# tokenmiser

**Spend fewer AI credits in GitHub Copilot CLI (and Claude Code).**

Copilot CLI bills by tokens (input, cached input, output). Most of those tokens are not your code. They are noise: test runners printing hundreds of passing tests, progress bars, a whole file read to find one function, a second read because the first window was too short. Everything that enters the context is sent again, as cached input, on every later request of the session, and every extra tool call re-sends the ~13k-token system prompt and tool definitions too.

tokenmiser is a plugin that sits between the agent and its tools. It shrinks what comes back, and it shapes calls so the agent needs fewer of them.

## At a glance

| | Without tokenmiser | With tokenmiser |
|---|---|---|
| Copilot CLI, live agent on Flask ([benchmark](#copilot-cli-live-agent-benchmark)) | 2.36 AI credits per question, 8/10 correct | **2.03 (−14%)**, 10/10 correct |
| Copilot CLI, scripted debug session ([replay](#copilot-cli-replay-real-cli-scripted-model)) | ~153k input tokens, 9 tool calls | **~114k (−25%)**, 6 tool calls |
| Claude Code, live agent on Flask ([benchmark](#claude-code-live-agent-benchmark)) | $0.0333 per question | **$0.0291 (−13%)**, 29/30 correct (vs 28/30) |
| Claude Code, live agent on Django | $0.0313 per question | **$0.0267 (−15%)**, 30/30 correct (vs 30/30) |

### Before / after: one test run in Copilot CLI

A test run with 300 passing tests and one failure (13 KB). Copilot CLI passes it to the model whole:

```text
npm WARN deprecated foo@1.0.0
[#                                       ] 2%[##                                      ] 5%[###  …(progress bar redraws)…
  ✓ module_1 handles case 1 (1ms)
  ✓ module_2 handles case 2 (2ms)
  … 296 more passing lines …
Tests: 1 failed, 300 passed                                    → 12,885 chars
```

With tokenmiser, the model gets:

```text
npm WARN deprecated foo@1.0.0
  … 150 passing test lines …
  ✗ checkout applies discount
    AssertionError: expected 90 to equal 81
      at Context.<anonymous> (test/checkout.test.js:42:17)
  … 150 passing test lines …
Tests: 1 failed, 300 passed                                    → 288 chars
```

At 47 KB the gap is about information, not size. Copilot replaces the output with a 500-character preview that **doesn't contain the failure**, so the agent needs more calls to dig for it. tokenmiser hands over the same 401-character summary, with the failure and the path to the full log.

## Compared with Copilot CLI on its own

Copilot CLI (1.0.90) already does some of this. tokenmiser fills the gaps and stays out of the way where Copilot already handles it.

| Situation | Copilot CLI on its own | With tokenmiser |
|---|---|---|
| pytest output under ~20 KB | Compacts it itself ("Shell output was automatically compacted") | Left alone |
| Other noisy output under ~20 KB (custom scripts, test runners Copilot doesn't recognise) | Passed through whole | Progress bars, ANSI codes, passing tests and repeats folded; errors, head and tail kept; full output saved to a file |
| Any shell output over ~20 KB | 500-char preview + temp file; the agent digs with `rg`/`head`/`tail` | Digest of the full output with every error line, plus the temp-file path |
| `view` of a file over ~20 KB | Refused with a generic hint | Refused with the file's **outline** (definitions and line ranges), so the next read is exact |
| `view` of a 16–20 KB file, or a lockfile/minified file over 8 KB | Read whole | Blocked once with the outline or a grep hint; an identical retry goes through |
| A line-range read that cuts a function short | Returned as asked; the agent reads again | Extended to the end of the function (≤150 lines) |
| Search hits | Raw matches, sometimes without line numbers | Plus the line, the enclosing definition and its range: `L72 in BlueprintSetupState.__init__ (L41-85)` |
| Big CSV / JSON / Parquet | Read or refused | Pointed at `duckdb -c "SUMMARIZE …"` (or `head`/`jq`) |
| An explicit `cat`/`head`/`sed -n` of a file | Passed through | Passed through (it's a read; trimming would force a re-read) |
| Exploration on a cheap model | Built-in `explore` agent | Same; the session prompt tells the agent to use it |

## What it does

| Piece | Hook | Effect |
|---|---|---|
| **Output compressor** | `postToolUse` | Shell, search and `web_fetch` output is cleaned before the model sees it: ANSI codes, progress bars and traceback caret lines are stripped; passing-test runs, repeated and near-identical lines are folded; head, tail and **every error line** are kept. Anything dropped is saved to a file whose path is in the output. |
| **Huge-output digest** | `postToolUse` | Replaces Copilot's 500-char preview of >20 KB output with a digest of the full output (errors first). |
| **Big-read guard** | `preToolUse` | The first whole-file read of a big or generated file (lockfiles, `*.min.js`, sourcemaps, `dist/`, …) and bare `ls -R` / `find .` are denied. For source files the denial **includes the file's outline**. **Repeating the exact same call is allowed**, so the agent is never stuck. |
| **Read snapping** | `preToolUse` | If a range read starts in a definition but stops before its end, it's extended to the end (up to 150 lines), which saves the re-read. |
| **Search annotations** | `postToolUse` | Search hits get a short note naming the definition each hit sits in and its exact range. |
| **Data-file hints** | `preToolUse` | Big CSV/JSON/Parquet reads are redirected to a query: DuckDB when installed, `head`/`wc`/`jq` otherwise. |
| **Frugal prompt** | `sessionStart` | ~150 tokens of working rules: answer tersely, locate before reading, batch shell steps, use quiet flags, make focused edits. |
| **Code index** | CLI (opt-in for agents) | `tokenmiser sym <name>`, `outline <file>`, `refs <name>`, `map [dir]`: definitions with line ranges and enclosing class, from a zero-dependency incremental index (`.tokenmiser/index.json`; Kubernetes' 13,800 source files in 2.3 s). The annotations, snapping and outlines use the same parser. |
| **`scout` agent** (Claude Code only) | – | Codebase explorer on Haiku that answers with `file:line` pointers. Copilot already has its own `explore` agent. |
| **`frugal-coding` skill** | – | A longer playbook (quiet flags per tool, data files, session hygiene) that loads only when relevant. |
| **`tokenmiser` CLI** | – | `stats` shows what was saved, `compress` filters any pipe, `doctor` checks your setup and lists Copilot settings that save credits. |

## Benchmarks

### Copilot CLI (live agent benchmark)

A real Copilot subscription, Copilot CLI 1.0.91 on macOS, model `claude-haiku-4.5`, the five Flask questions, 10 runs per setup, usage as reported by Copilot itself:

| Setup | Correct | Avg input tokens | Avg AI credits | vs none |
|---|---|---|---|---|
| none | 8/10 | 106,830 | 2.36 | |
| tokenmiser 0.2.2 | 10/10 | 87,220 | 2.03 | **−18% input, −14% credits** |

Ten runs per setup is a small sample, and single runs range from 1.5 to 3.9 credits, so read this as a direction, not a guarantee. An earlier round with 0.2.1 showed no saving at all, and the reason was instructive: with a real model, Copilot's agent and its built-in `explore` sub-agent mostly use tools named `grep_search`, `file_search` and `read_file`, which 0.2.1 didn't watch. 0.2.2 covers them.

### Copilot CLI replay (real CLI, scripted model)

The real Copilot CLI runs a fixed debug session on Flask: run the suite, run one module, search, read a function, open a big file, read a config. A scripted fake model issues the calls, so the hooks, Copilot's own compaction and its prompts are all real, and the replay measures exactly what Copilot sends to the model. Where a result came back incomplete, the script adds the follow-up call an agent would need to reach the same information, listed in [`bench/replay-flask.json`](bench/replay-flask.json).

| Step | Without tokenmiser | With tokenmiser |
|---|---|---|
| pytest -v (whole suite, 1 failure) | ~419 (2 calls: preview, then grep the saved log) | ~1,057 (digest with the full traceback) |
| pytest -v (one module) | ~109 (Copilot compacts it) | ~89 |
| rg url_prefix (content) | ~358 | ~509 (with enclosing definitions) |
| view blueprints.py L273-300 | ~1,084 (2 calls: the window was short) | ~1,084 (snapped to the function's end) |
| view app.py (whole, 64 KB) | ~629 (2 calls: refused, then grep for definitions) | ~1,072 (refused with the outline) |
| cat pyproject.toml | ~1,649 | ~1,649 |
| **Total input incl. system prompt and tool definitions** | **~153k** (10 requests) | **~114k, −25%** (7 requests) |

Per call, tokenmiser often sends *more* (a full traceback, a whole function, an outline), because that's what saves the next call. Each avoided call saves about 13k tokens of system prompt and tool definitions plus the conversation so far. A scripted model can't react, so this measures the mechanics; the live benchmark below measures a real agent.

### Claude Code (live agent benchmark)

Claude Code, headless on Haiku, answering five "where is / how does" questions per repo, 30 runs per setup per repo:

| Repo | Setup | Correct | Avg cost | vs none |
|---|---|---|---|---|
| Flask (89 files) | none | 28/30 | $0.0333 | |
| | tokenmiser | 29/30 | $0.0291 | **−13%** |
| | tokenmiser + index prompt | 30/30 | $0.0352 | +6% |
| Django (2,983 files) | none | 30/30 | $0.0313 | |
| | tokenmiser | 30/30 | $0.0267 | **−15%** |
| | tokenmiser + index prompt | 30/30 | $0.0266 | −15% |

Most of the saving is uncached input, which was about 40% lower. Telling the agent about the index commands made answers slightly more accurate but not cheaper, so it's opt-in. Run-to-run noise is large; details in [bench/README.md](bench/README.md).

### Run the benchmarks yourself (no Copilot subscription needed)

| Harness | Needs | Measures |
|---|---|---|
| [`bench/copilot-replay.mjs`](bench/copilot-replay.mjs) | Copilot CLI installed. **No account, no API key** (it starts its own scripted model through BYOK mode) | What Copilot sends to the model, with and without tokenmiser |
| [`bench/copilot-ab.mjs`](bench/copilot-ab.mjs) | Copilot CLI plus **either** a Copilot login **or** your own model via BYOK: an Anthropic/OpenAI/Azure API key, or a free local model with Ollama | A live agent: tool calls, input/cached/output tokens, correctness |
| [`bench/claude-ab.mjs`](bench/claude-ab.mjs) | Claude Code | The same, in Claude Code |

```bash
git clone --depth 1 https://github.com/pallets/flask /tmp/flask
cd /tmp/flask && python3 -m venv .venv && .venv/bin/pip install -q -e . pytest && cd -
node bench/copilot-replay.mjs /tmp/flask                     # no account needed

# live agent through BYOK, e.g. Anthropic:
COPILOT_PROVIDER_TYPE=anthropic COPILOT_PROVIDER_BASE_URL=https://api.anthropic.com \
COPILOT_PROVIDER_API_KEY=sk-ant-… COPILOT_MODEL=claude-haiku-4-5 \
node bench/copilot-ab.mjs /tmp/flask --reps 3
```

BYOK runs the real Copilot agent (same tools, prompts and hooks) and bills your provider instead of Copilot credits, so token counts carry over and the credit price doesn't. The harnesses run tools without asking, so point them at a throwaway clone.

## Status

Early (0.2.x). Tested on Linux and macOS with Copilot CLI 1.0.90–1.0.91 and Claude Code 2.1. Windows is untested. Hooks fail open, so a Copilot update that changes tool names or output formats turns features off rather than breaking the agent; `tokenmiser stats` shows whether the hooks are doing anything.

## Install

Requires **Node.js 18+** on `PATH`. If node is missing, every hook exits cleanly and does nothing; it never blocks the agent.

### GitHub Copilot CLI

```bash
copilot plugin marketplace add bdarwin/tokenmiser
copilot plugin install tokenmiser@tokenmiser
```

Restart Copilot CLI and use `/env` to check the hooks are loaded.

### Claude Code

```text
/plugin marketplace add bdarwin/tokenmiser
/plugin install tokenmiser@tokenmiser
```

In Claude Code, Bash output is compressed, Grep/Bash searches are annotated, and `Read`/`Bash` reads are guarded and snapped. The `tokenmiser:scout` agent is available too.

### The CLI (optional)

```bash
npx github:bdarwin/tokenmiser stats       # or: node <plugin>/scripts/tokenmiser.mjs stats
npm test 2>&1 | npx github:bdarwin/tokenmiser compress
```

## Code index

```text
$ tokenmiser sym add_url_rule
src/flask/sansio/app.py:605-661  [App] def add_url_rule(self, rule: str, endpoint: str | None = None, …
src/flask/sansio/blueprints.py:87-116  [BlueprintSetupState] def add_url_rule(self, rule: str, …
src/flask/sansio/scaffold.py:376-441  [Scaffold] def add_url_rule(self, rule: str, …

$ tokenmiser outline src/flask/sansio/blueprints.py
src/flask/sansio/blueprints.py — 693 lines, 42 symbols
L34-116  class BlueprintSetupState:
  L41-85  def __init__(self, blueprint: Blueprint, app: App, options: t.Any, first_registration: bool) -> None:
  …
```

Definitions are found with per-language patterns (JS/TS, Python, Go, Rust, Java/Kotlin/C#/Swift/Scala/Dart, Ruby, PHP, C/C++, Markdown headings). That's fast and needs no dependencies, but it's not a full parser, so unusual formatting can be missed. `refs` uses `rg` when available, otherwise `git grep`.

### Why not DuckDB for the index?

Copilot CLI already ships DuckDB (its `session_store_sql` tool queries your past sessions) and a SQLite scratch database (`sql`). Bundling DuckDB again would add ~70 MB of native binaries per platform to a plugin that is installed by copying files. A plain JSON index is enough for symbol lookups. Where DuckDB *does* save tokens is querying big data files instead of reading them, so tokenmiser points the agent at it when it's installed.

## See what you saved

```text
$ tokenmiser stats
tokenmiser — estimated input tokens kept out of the context window
  sessions            1
  outputs compressed  1  (97% smaller, ~3,117 tokens)
  big reads blocked   1  (0 retried anyway, ~13,729 tokens)
  huge outputs digested 1  (error lines surfaced up front instead of a 500-char preview; saves follow-up turns)
  reads snapped       2  (range extended to the end of the definition; saves a re-read)
  searches annotated  3  (hits labelled with their enclosing definition and line range)
  total               ~16,846 tokens
```

These are estimates (chars ÷ 4) of tokens kept out **once**. Each token kept out is also not re-sent on later turns, so real savings are higher. Use Copilot's `/usage` for exact numbers.

## Configure

Settings are layered: defaults < `~/.tokenmiser/config.json` < `<repo>/.tokenmiser.json` < environment variables.

```json
{
  "compress": true,
  "guard": true,
  "snapReads": true,
  "enrichSearch": true,
  "frugalPrompt": true,
  "index": false,
  "maxChars": 6000,
  "digestChars": 8000,
  "bigFileBytes": 16000,
  "generatedFileBytes": 8000,
  "snapMaxLines": 150
}
```

`"index": true` also creates `.tokenmiser/tm` and tells the agent about the code-index commands. In the benchmarks this made the agent more direct (57% fewer tool calls on Kubernetes) but not cheaper in AI credits, so it is off by default.

| Env var | Effect |
|---|---|
| `TOKENMISER_DISABLE=1` | turn everything off |
| `TOKENMISER_COMPRESS=0`, `TOKENMISER_GUARD=0`, `TOKENMISER_SNAP_READS=0`, `TOKENMISER_ENRICH_SEARCH=0`, `TOKENMISER_FRUGAL_PROMPT=0` | turn one feature off |
| `TOKENMISER_INDEX=1` | advertise the code index to the agent |
| `TOKENMISER_MAX_CHARS=10000` | larger budget per tool output |
| `TOKENMISER_HOME` | where stats and session state live (default `~/.tokenmiser`) |

Trimmed output is saved to `.tokenmiser/spill/` in your project; the folder ignores itself in git, and only the newest 40 files are kept.

## Copilot settings that save even more

A plugin can't change these for you, but they matter as much as anything above:

- `copilot --max-ai-credits 60` (or `/limits`) puts a hard cap on a session.
- `/subagents`: put helper agents (explore, task) on a small model.
- `/model` → Auto with the `efficiency` tier (`--auto-tier efficiency`).
- `/statusline` → add `quota` and `ai-used`, so the meter is always visible.
- `/clear` between unrelated tasks, and `/compact` when a session drags.
- `--max-autopilot-continues 3` stops runaway autopilot loops.

## How it's built

```
.github/plugin/marketplace.json      Copilot CLI marketplace
.claude-plugin/marketplace.json      Claude Code marketplace
plugins/tokenmiser/
  plugin.json                        Copilot manifest  → hooks/copilot-hooks.json, skills/
  .claude-plugin/plugin.json         Claude manifest   → hooks/hooks.json, claude-agents/, skills/
  scripts/tokenmiser.mjs             one zero-dependency entry point for every hook and command
  scripts/lib/                       compress · digest · guard · snap · enrich · codeindex · adapters (Copilot/Claude dialects) · config · store
test/                                node --test suite (npm test)
bench/                               A/B benchmark harness, tasks and results
```

Hooks fail open: bad input, a crash, or a missing `node` all mean "do nothing", never "block the agent".

## License

MIT
