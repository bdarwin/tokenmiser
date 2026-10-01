# tokenmiser

**Spend fewer AI credits in GitHub Copilot CLI (and Claude Code).**

Copilot CLI now bills by tokens (input, cached input, output). Most of those tokens are not your code. They are noise: test runners printing 1,200 passing tests, `npm install` progress bars, a lockfile the agent `cat`-ed "just to check". Everything that enters the context window is paid for again, as cached input, on every later turn of the session.

tokenmiser is a plugin that sits between the agent and its tools and keeps that noise out.

## What it does

| Piece | Hook | Effect |
|---|---|---|
| **Output compressor** | `postToolUse` | Shell, `rg`/`glob` and `web_fetch` output is cleaned before the model sees it: ANSI codes and progress bars are stripped, repeated and near-identical lines are folded, and head + tail + **every error line** are kept. Anything dropped is saved to a file whose path is in the output, so nothing is lost. |
| **Huge-output digest** | `postToolUse` | Above ~20 KB, Copilot CLI replaces shell output with a 500-char preview, and the agent then spends several turns digging through it with `head`/`tail`/`rg`. tokenmiser replaces that preview with a digest of the full output (errors first), which saves those turns. |
| **Big-read guard** | `preToolUse` | The first whole-file read of a big or generated file (lockfiles, `*.min.js`, sourcemaps, `dist/`, …) and bare `ls -R` / `find .` are denied, with advice to grep or read a line range. **Repeating the exact same call is allowed**, so the agent is never stuck. |
| **Frugal prompt** | `sessionStart` | ~150 tokens of working rules: answer tersely, locate before reading, batch shell steps, use quiet flags, make focused edits. |
| **`scout` agent** | – | Codebase explorer pinned to a cheap model (`claude-haiku-4.5`). It answers "where is X / how does Y work" with `file:line` pointers instead of the main model reading files. |
| **`frugal-coding` skill** | – | A longer playbook (quiet flags per tool, session hygiene) that loads only when relevant. |
| **`tokenmiser` CLI** | – | `stats` shows tokens saved, `compress` filters any pipe, `doctor` checks your setup and lists Copilot settings that save credits. |

### Measured in the real Copilot CLI (v1.0.90)

| Tool call | What the model saw without tokenmiser | With tokenmiser |
|---|---|---|
| Test run, 300 tests, 1 failure (13 KB) | 13,448 chars | **420 chars**, failure, stack line and summary kept |
| Test run, 1,200 tests (48 KB) | 500-char preview, **failure not visible** | **533 chars**, failure, summary and full-log path |
| `cat package-lock.json` (54 KB) | whole file, ~14k tokens | denied once with "grep it instead" |

## Install

Requires **Node.js 18+** on `PATH`. If node is missing, every hook exits cleanly and does nothing; it never blocks the agent.

### GitHub Copilot CLI

```bash
copilot plugin marketplace add bdarwin/tokenmiser
copilot plugin install tokenmiser@tokenmiser
```

Restart Copilot CLI. Use `/env` to check the hooks are loaded and `/agent` to find `tokenmiser:scout`.

### Claude Code

```text
/plugin marketplace add bdarwin/tokenmiser
/plugin install tokenmiser@tokenmiser
```

In Claude Code, Bash output is compressed, and `Read`/`Bash` big reads are guarded.

### The CLI (optional)

```bash
npx github:bdarwin/tokenmiser stats       # or: node <plugin>/scripts/tokenmiser.mjs stats
npm test 2>&1 | npx github:bdarwin/tokenmiser compress
```

## See what you saved

```text
$ tokenmiser stats
tokenmiser — estimated input tokens kept out of the context window
  sessions            1
  outputs compressed  1  (97% smaller, ~3,117 tokens)
  big reads blocked   1  (0 retried anyway, ~13,729 tokens)
  huge outputs digested 1  (error lines surfaced up front instead of a 500-char preview; saves follow-up turns)
  total               ~16,846 tokens
```

These are estimates (chars ÷ 4) of tokens kept out **once**. Each token kept out is also not re-sent on later turns, so real savings are higher. Use Copilot's `/usage` for exact numbers.

## Configure

Settings are layered: defaults < `~/.tokenmiser/config.json` < `<repo>/.tokenmiser.json` < environment variables.

```json
{
  "compress": true,
  "guard": true,
  "frugalPrompt": true,
  "maxChars": 6000,
  "digestChars": 8000,
  "bigFileBytes": 16000,
  "generatedFileBytes": 8000
}
```

| Env var | Effect |
|---|---|
| `TOKENMISER_DISABLE=1` | turn everything off |
| `TOKENMISER_COMPRESS=0`, `TOKENMISER_GUARD=0`, `TOKENMISER_FRUGAL_PROMPT=0` | turn one feature off |
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
  plugin.json                        Copilot manifest  → hooks/copilot-hooks.json, copilot-agents/, skills/
  .claude-plugin/plugin.json         Claude manifest   → hooks/hooks.json, claude-agents/, skills/
  scripts/tokenmiser.mjs             one zero-dependency entry point for every hook and command
  scripts/lib/                       compress · guard · digest · adapters (Copilot/Claude dialects) · config · store
test/                                node --test suite (npm test)
```

Hooks fail open: bad input, a crash, or a missing `node` all mean "do nothing", never "block the agent".

## License

MIT
