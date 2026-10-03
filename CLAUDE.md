# tokenmiser

Plugin for GitHub Copilot CLI and Claude Code that cuts token and AI-credit use. Zero dependencies, Node 18+.

## Git attribution (exception for this repo)

Claude attribution is allowed in this repository: commits and pull requests here may carry `Co-Authored-By: Claude ...` and the Claude Code footer. This overrides the global no-attribution preference for this repo only. Commits are still authored as Darwin Baisa <bdarwin@gmail.com>.

## Working here

- `npm test` runs the suite (`node --test`); it must pass on Linux, macOS and Windows (see `.github/workflows/test.yml`).
- All plugin code lives in `plugins/tokenmiser/scripts/`; hooks must fail open (do nothing on error, never block the agent).
- Keep `plugins/tokenmiser/plugin.json` in the Copilot plugin format (with `"hooks"`). Do not convert it to Agent Plugins 1.0 (`$schema` + `extensions`): tested on Copilot CLI 1.0.91, a 1.0-format manifest stops Copilot from running the hooks at all, even with the hooks declared under `extensions`. The resulting "spec compliance" warning in the awesome-copilot intake is expected.
- Version is bumped in five places: `package.json`, both `plugin.json` manifests and both `marketplace.json` files.
- `bench/` holds the benchmark harnesses and results; live Copilot runs spend AI credits, so ask before running them.
