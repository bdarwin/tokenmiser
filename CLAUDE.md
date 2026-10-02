# tokenmiser

Plugin for GitHub Copilot CLI and Claude Code that cuts token and AI-credit use. Zero dependencies, Node 18+.

## Git attribution (exception for this repo)

Claude attribution is allowed in this repository: commits and pull requests here may carry `Co-Authored-By: Claude ...` and the Claude Code footer. This overrides the global no-attribution preference for this repo only. Commits are still authored as Darwin Baisa <bdarwin@gmail.com>.

## Working here

- `npm test` runs the suite (`node --test`); it must pass on Linux, macOS and Windows (see `.github/workflows/test.yml`).
- All plugin code lives in `plugins/tokenmiser/scripts/`; hooks must fail open (do nothing on error, never block the agent).
- Version is bumped in five places: `package.json`, both `plugin.json` manifests and both `marketplace.json` files.
- `bench/` holds the benchmark harnesses and results; live Copilot runs spend AI credits, so ask before running them.
