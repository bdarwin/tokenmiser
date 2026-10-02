import fs from 'node:fs';
import path from 'node:path';
import { outlineFile } from './codeindex.mjs';

const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|packages\.lock\.json|flake\.lock)$/,
  /\.min\.(js|css)$/,
  /\.(map|snap)$/,
  /(^|\/)(node_modules|dist|build|out|target|\.next|coverage|vendor|__pycache__)\//,
];

const kb = (n) => `${Math.round(n / 1024)} KB`;
const tok = (n) => `~${Math.round(n / 4 / 1000)}k tokens`;

function fileSize(file, cwd) {
  try {
    const st = fs.statSync(path.resolve(cwd || '.', file));
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

const DATA = /\.(csv|tsv|jsonl|ndjson|parquet|json)$/i;

function onPath(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && exts.some((e) => fs.existsSync(path.join(d, bin + e))));
}

// Big tabular/JSON data: query it instead of reading it. DuckDB reads these formats
// directly with SQL; fall back to plain shell when it isn't installed.
function dataAdvice(file) {
  const q = `'${file.replace(/'/g, "''")}'`;
  if (onPath('duckdb')) {
    return `Query it with DuckDB instead of reading it: \`duckdb -c "DESCRIBE SELECT * FROM ${q}"\` for columns, \`duckdb -c "SUMMARIZE SELECT * FROM ${q}"\` for stats, \`duckdb -c "SELECT ... FROM ${q} WHERE ... LIMIT 20"\` for rows.`;
  }
  if (/\.parquet$/i.test(file)) return 'Parquet is binary; inspect it with a query tool (e.g. duckdb or pandas) rather than reading it.';
  if (/\.json$/i.test(file)) return `Inspect the structure first: \`jq 'keys' ${file}\` or \`head -c 2000 ${file}\`.`;
  return `Look at the shape first: \`head -n 5 ${file}\` and \`wc -l ${file}\`, then filter with grep/awk.`;
}

function checkFile(file, cwd, cfg) {
  const abs = path.resolve(cwd || '.', file);
  const size = fileSize(file, cwd);
  if (size == null) return null;
  const generated = GENERATED.some((re) => re.test(file.replace(/\\/g, '/')));
  if (generated && size > cfg.generatedFileBytes) {
    return { bytes: size, reason: `${file} looks generated (${kb(size)}, ${tok(size)}). Don't read it whole: grep it for the exact entry you need.` };
  }
  if (size <= cfg.bigFileBytes) return null;
  if (DATA.test(file) && cfg.dataHints !== false) {
    return { bytes: size, reason: `${file} is a ${kb(size)} data file (${tok(size)}). ${dataAdvice(file)}` };
  }
  // Hand over the file's outline so the very next call can be a precise line-range read.
  const label = path.relative(cwd || '.', abs).startsWith('..') ? file : path.relative(cwd || '.', abs);
  const map = cfg.outlineOnDeny !== false ? outlineFile(abs, label, { maxEntries: 60 }) : null;
  if (map) {
    return { bytes: size, reason: `${file} is ${kb(size)} (${tok(size)}). View only the line range you need. Outline:\n${map}\n` };
  }
  return { bytes: size, reason: `${file} is ${kb(size)} (${tok(size)}). Grep/search for the symbol you need first, then view only that line range.` };
}

// Returns { key, reason, bytes } when the call looks wasteful, otherwise null.
export function inspect(call, cfg) {
  const { tool, args, cwd } = call;
  const t = tool.toLowerCase();

  // Whole-file reads: Copilot `view {path, view_range}` / `read_file {filePath, startLine, endLine}`,
  // Claude `Read {file_path, offset, limit}`
  if (t === 'view' || t === 'read' || t === 'read_file') {
    const file = args.path ?? args.file_path ?? args.filePath;
    const ranged = args.view_range ?? args.viewRange ?? args.limit ?? args.offset ?? args.startLine ?? args.endLine;
    if (!file || ranged) return null;
    const hit = checkFile(file, cwd, cfg);
    return hit && { key: `read:${file}`, ...hit };
  }

  if (t === 'bash' || t === 'powershell' || t === 'shell') {
    const cmd = String(args.command ?? '').trim();
    const cat = cmd.match(/^(?:cat|type|Get-Content)\s+("[^"]+"|'[^']+'|[^\s|;&<>]+)\s*$/);
    if (cat) {
      const file = cat[1].replace(/^["']|["']$/g, '');
      const hit = checkFile(file, cwd, cfg);
      return hit && { key: `read:${file}`, ...hit };
    }
    if (/^(ls\s+(-\w*R\w*\s*)+\.?\/?|find\s+(\.|\/)\s*|tree\s*\.?)$/.test(cmd)) {
      return {
        key: `list:${cmd}`,
        bytes: 0,
        reason: `"${cmd}" can dump thousands of paths. Prefer \`git ls-files | head -200\`, \`tree -L 2\`, or find with -maxdepth/-name filters.`,
      };
    }
  }
  return null;
}

export function denyMessage(reason) {
  return `tokenmiser blocked this to save credits: ${reason} If you really need the whole thing, repeat the exact same call and it will be allowed.`;
}
