# Benchmark

`claude-ab.mjs` asks Claude Code (headless) the same code-navigation questions under three setups and records turns, tool calls, tokens and cost from the CLI's own usage report:

| setup | what's on |
|---|---|
| `none` | no plugin |
| `plugin` | tokenmiser defaults: output compression, read guard with outlines, search annotations, read snapping |
| `plugin+index` | defaults + the session prompt advertising `.tokenmiser/tm sym/outline/refs/map` (`TOKENMISER_INDEX=1`) |

```bash
git clone --depth 1 https://github.com/pallets/flask /tmp/flask
node bench/claude-ab.mjs /tmp/flask --tasks bench/tasks-flask.json --reps 3 --model haiku
```

A run counts as correct when the answer names the expected function or file (`expect` in the task file).

## Results (2026-10-02, Claude Code 2.1.286, Haiku, 2 rounds × 5 questions × 3 runs = 30 runs per setup per repo)

**Flask** (89 source files)

| setup | correct | avg turns | avg input tokens | uncached input | avg cost | vs none |
|---|---|---|---|---|---|---|
| none | 28/30 | 4.7 | 140k | 7k | $0.0333 | |
| plugin | 29/30 | 5.1 | 152k | 4k | $0.0291 | **−13%** |
| plugin+index | 30/30 | 6.2 | 188k | 5k | $0.0352 | +6% |

**Django** (2,983 source files)

| setup | correct | avg turns | avg input tokens | uncached input | avg cost | vs none |
|---|---|---|---|---|---|---|
| none | 30/30 | 5.3 | 154k | 5k | $0.0313 | |
| plugin | 30/30 | 5.1 | 148k | 3k | $0.0267 | **−15%** |
| plugin+index | 30/30 | 5.2 | 150k | 3k | $0.0266 | −15% |

What this says:
- The default plugin was cheaper in every one of the four rounds (−9% to −19%). Most of the saving is uncached input, about 40% lower, because tool output that enters the context is smaller.
- Advertising the `tm` commands did not lower cost. Haiku rarely called them and sometimes added an orienting call, which on a small repo cost more turns. It was the most accurate setup, so it stays available as an opt-in (`"index": true`), but is off by default.
- Run-to-run noise is large (one setup's average moved from 5.7 to 4.5 turns between rounds), so differences under ~10% in a single round mean little. Measure your own workload with Copilot's `/usage`.

Not measured here: Copilot CLI with a real model (needs a Copilot subscription; the hooks themselves were verified end to end in Copilot CLI 1.0.90 against a scripted model), edit-heavy tasks, and larger models.
