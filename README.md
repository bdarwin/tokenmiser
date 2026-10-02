# tokenmiser

**Spend fewer AI credits in GitHub Copilot CLI (and Claude Code).**

Copilot CLI now bills by tokens (input, cached input, output). Most of those tokens are not your code. They are noise: test runners printing 1,200 passing tests, `npm install` progress bars, a lockfile the agent `cat`-ed "just to check". Everything that enters the context window is paid for again, as cached input, on every later turn of the session.

tokenmiser is a plugin that sits between the agent and its tools and keeps that noise out.

## What it does

| Piece | Hook | Effect |
|---|---|---|
| **Output compressor** | `postToolUse` | Shell, `rg`/`glob` and `web_fetch` output is cleaned before the model sees it: ANSI codes and progress bars are stripped, repeated and near-identical lines are folded, and head + tail + **every error line** are kept. Anything dropped is saved to a file whose path is in the output, so nothing is lost. |
| **Huge-output digest** | `postToolUse` | Above ~20 KB, Copilot CLI replaces shell output with a 500-char preview, and the agent then spends several turns digging through it with `head`/`tail`/`rg`. tokenmiser replaces that preview with a digest of the full output (errors first), which saves those turns. |
| **Big-read guard** | `preToolUse` | The first whole-file read of a big or generated file (lockfiles, `*.min.js`, sourcemaps, `dist/`, …) and bare `ls -R` / `find .` are denied. For source files the denial **includes the file's outline** (every definition with its line range), so the next call can be a precise range read. **Repeating the exact same call is allowed**, so the agent is never stuck. |
| **Read snapping** | `preToolUse` | Agents guess read windows (`offset 273, limit 25`) and then spend a whole extra turn reading the rest of the function. If a range read starts in a definition but stops before its end, tokenmiser extends it to the end (up to 150 lines). |
| **Search annotations** | `postToolUse` | Search hits get a short note naming the definition each hit sits in and its exact range: `blueprints.py: L72,L74 in BlueprintSetupState.__init__ (L41-85)`. |
| **Data-file hints** | `preToolUse` | A big CSV/JSON/Parquet read is redirected to a query: `duckdb -c "SUMMARIZE …"` when DuckDB is installed, `head`/`wc`/`jq` otherwise. |
| **Frugal prompt** | `sessionStart` | ~150 tokens of working rules: answer tersely, locate before reading, batch shell steps, use quiet flags, make focused edits. |
| **Code index** | CLI (opt-in for agents) | `tokenmiser sym <name>`, `outline <file>`, `refs <name>`, `map [dir]`: definitions with line ranges and enclosing class, from a zero-dependency index of your repo (`.tokenmiser/index.json`, incremental; Django's 3,000 files index in 0.7 s). The annotations, snapping and outlines above use the same parser. |
| **`scout` agent** (Claude Code) | – | Codebase explorer on Haiku that answers with `file:line` pointers. Copilot CLI already has a built-in `explore` agent on a lightweight model, so the Copilot side uses that. |
| **`frugal-coding` skill** | – | A longer playbook (quiet flags per tool, data files, session hygiene) that loads only when relevant. |
| **`tokenmiser` CLI** | – | `stats` shows what was saved, `compress` filters any pipe, `doctor` checks your setup and lists Copilot settings that save credits. |

### Measured in the real Copilot CLI (v1.0.90)

| Tool call | What the model saw without tokenmiser | With tokenmiser |
|---|---|---|
| Test run, 300 tests, 1 failure (13 KB) | 13,448 chars | **420 chars**, failure, stack line and summary kept |
| Test run, 1,200 tests (48 KB) | 500-char preview, **failure not visible** | **533 chars**, failure, summary and full-log path |
| `cat package-lock.json` (54 KB) | whole file, ~14k tokens | denied once with "grep it instead" |

### Benchmarked (Claude Code, Haiku, 60 runs per repo)

Same code-navigation questions with and without the plugin; details and caveats in [bench/README.md](bench/README.md).

| Repo | Cost vs no plugin | Correct answers |
|---|---|---|
| Flask (89 files) | **−13%** | 29/30 (none: 28/30) |
| Django (2,983 files) | **−15%** | 30/30 (none: 30/30) |

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

`"index": true` also creates `.tokenmiser/tm` and tells the agent about the code-index commands. In the benchmark this was the most accurate setup but not cheaper, so it is off by default.

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
