import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS as COMPRESS_DEFAULTS } from './compress.mjs';

export const DEFAULTS = {
  enabled: true,
  compress: true, // shrink shell / search / fetch output
  guard: true, // deny-once on wasteful whole-file reads
  frugalPrompt: true, // inject terse working rules at session start
  stats: true,
  index: false, // advertise the code index (.tokenmiser/tm sym|outline|refs|map) at session start; opt-in, see bench/
  outlineOnDeny: true, // big-file guard hands over the file's outline
  snapReads: true, // extend partial reads to the end of the definition they start in
  snapMaxLines: 150,
  enrichSearch: true, // annotate search hits with their enclosing definition + line range
  dataHints: true, // big CSV/JSON/Parquet reads get DuckDB (or head/jq) advice
  bigFileBytes: 16_000, // ~4k tokens: whole-file reads above this get a nudge first
  generatedFileBytes: 8_000, // lockfiles, minified files, sourcemaps
  compressTools: '^(bash|powershell|read_bash|read_powershell|shell|grep|rg|glob|web_fetch|fetch|Bash)$',
  digestChars: 8000, // budget when digesting Copilot's >20 KB spilled outputs
  ...COMPRESS_DEFAULTS,
};

export function homeDir() {
  return process.env.TOKENMISER_HOME || path.join(os.homedir(), '.tokenmiser');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// Precedence: defaults < ~/.tokenmiser/config.json < <project>/.tokenmiser.json < env
export function loadConfig(cwd = process.cwd()) {
  const cfg = { ...DEFAULTS, ...readJson(path.join(homeDir(), 'config.json')), ...readJson(path.join(cwd, '.tokenmiser.json')) };
  const env = process.env;
  if (/^(1|true|yes)$/i.test(env.TOKENMISER_DISABLE ?? '')) cfg.enabled = false;
  if (env.TOKENMISER_MAX_CHARS) cfg.maxChars = Number(env.TOKENMISER_MAX_CHARS) || cfg.maxChars;
  if (env.TOKENMISER_BIG_FILE_BYTES) cfg.bigFileBytes = Number(env.TOKENMISER_BIG_FILE_BYTES) || cfg.bigFileBytes;
  for (const k of ['compress', 'guard', 'frugalPrompt', 'stats', 'index', 'enrichSearch', 'snapReads']) {
    const v = env[`TOKENMISER_${k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`];
    if (v !== undefined) cfg[k] = !/^(0|false|no|off)$/i.test(v);
  }
  return cfg;
}
