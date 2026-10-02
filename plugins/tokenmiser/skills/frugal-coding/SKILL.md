---
name: frugal-coding
description: Credit-saving playbook for coding agents. Use when the user asks to save tokens/credits/premium requests, when a session is getting long or expensive, or when output was trimmed by tokenmiser and you need to decide whether to read the spill file.
---

# Frugal coding

Every token you read stays in context and is re-sent (cheaply, when cached) on every later turn. Reading less early is the biggest saving.

## Reading
- Find before you read: `grep -n`, `rg -n --max-count 20`, glob. Then view only the needed range.
- Don't open lockfiles, minified bundles, sourcemaps, snapshots, `dist/`, `node_modules/`. Grep them if you must.
- Don't re-read a file you already have in context; trust your earlier view plus your own edits.
- For "how does this repo work" questions, delegate to the `scout` agent and work from its pointers.

## Code index (tokenmiser)
- Search hits may end with `[tokenmiser] enclosing definitions` listing `file: L72 in Class.method (L41-85)`. Read exactly that range; it is the whole definition.
- A blocked whole-file read comes with the file's outline (symbols with line ranges). Pick the range from it instead of reading everything.
- When enabled (`"index": true`), `.tokenmiser/tm sym <name>` gives a definition's file and line range (with its class), `.tokenmiser/tm outline <file>` lists a file's symbols, `.tokenmiser/tm refs <name>` lists usages per file, and `.tokenmiser/tm map [dir]` gives a ranked repo overview.

## Data files
- Never read a big CSV/JSON/Parquet file whole. With DuckDB installed: `duckdb -c "DESCRIBE SELECT * FROM 'f.csv'"`, `duckdb -c "SUMMARIZE SELECT * FROM 'f.csv'"`, or a filtered `SELECT … LIMIT 20`. Without it: `head -n 5`, `wc -l`, `jq 'keys'`.

## Shell
- One batched command beats five small ones: `npm test 2>&1 | tail -n 60`.
- Use quiet flags: `npm ci --silent`, `pip install -q`, `cargo build -q`, `git --no-pager log --oneline -n 20`, `pytest -q`, `go test ./... 2>&1 | grep -v '^ok'`.
- Filter failures, not successes: `pytest -q -x`, `jest --silent`, `--reporter=dot`.
- Long output is trimmed by tokenmiser; the full text is saved under `.tokenmiser/spill/`. Open it only when the omitted part matters, and by `grep -n` or line range, never whole.
- You can pipe anything through the compressor yourself: `<cmd> 2>&1 | npx tokenmiser compress` (or `node <plugin>/scripts/tokenmiser.mjs compress`).

## Writing
- Edit with small, targeted replacements; never re-create a whole file to change a few lines.
- Final answers: what changed and anything the user must do. No recap of the steps you took, no restating the request.

## Session hygiene (tell the user when relevant)
- `/clear` between unrelated tasks; `/compact` when a long session gets sluggish.
- `/usage` and `/context` show where credits went; `/statusline` can show `quota` and `ai-used` live.
- `copilot --max-ai-credits N` caps a session; `/subagents` can put helper agents on a cheaper model.
