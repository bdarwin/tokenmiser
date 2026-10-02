# Benchmarks

Three harnesses:

| Harness | Needs | Measures |
|---|---|---|
| `copilot-replay.mjs` | Copilot CLI only. No account or API key: it starts its own scripted model (BYOK mode) | What Copilot sends to the model for a fixed session ([`replay-flask.json`](replay-flask.json)), with and without tokenmiser |
| `copilot-ab.mjs` | Copilot CLI with a Copilot login, or BYOK (your Anthropic/OpenAI/Azure key, or a local Ollama model) | A live Copilot agent: tool calls, input/cached/output tokens, correctness |
| `claude-ab.mjs` | Claude Code | A live Claude Code agent: turns, tokens, cost, correctness |

```bash
node bench/copilot-replay.mjs /tmp/flask
COPILOT_PROVIDER_TYPE=anthropic COPILOT_PROVIDER_BASE_URL=https://api.anthropic.com COPILOT_PROVIDER_API_KEY=sk-ant-… \
  COPILOT_MODEL=claude-haiku-4-5 node bench/copilot-ab.mjs /tmp/flask --reps 3
```

The replay needs Flask's test environment (`python3 -m venv .venv && .venv/bin/pip install -e . pytest` inside the clone).

## Copilot CLI replay (2026-10-02, Copilot CLI 1.0.90)

| Step | Without tokenmiser | With tokenmiser |
|---|---|---|
| pytest -v (whole suite, 1 failure) | ~419 (2 calls) | ~1,057 |
| pytest -v (one module) | ~109 | ~89 |
| rg url_prefix (content) | ~358 | ~509 |
| view blueprints.py L273-300 | ~1,084 (2 calls) | ~1,084 |
| view app.py (whole, 64 KB) | ~629 (2 calls) | ~1,072 |
| cat pyproject.toml | ~1,649 | ~1,649 |
| **Total input incl. system prompt + tool definitions** | **~153k** (10 requests) | **~114k, −25%** (7 requests) |

Follow-up calls (the "2 calls" cells) are modelled: they are the calls an agent needs to reach the same information when the first result came back incomplete. They are listed in the script and can be edited.

## Claude Code live benchmark (`claude-ab.mjs`)

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
