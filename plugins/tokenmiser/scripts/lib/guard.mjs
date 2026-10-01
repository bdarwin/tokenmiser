import fs from 'node:fs';
import path from 'node:path';

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

function checkFile(file, cwd, cfg) {
  const size = fileSize(file, cwd);
  if (size == null) return null;
  const generated = GENERATED.some((re) => re.test(file.replace(/\\/g, '/')));
  if (generated && size > cfg.generatedFileBytes) {
    return { bytes: size, reason: `${file} looks generated (${kb(size)}, ${tok(size)}). Don't read it whole: grep it for the exact entry you need.` };
  }
  if (size > cfg.bigFileBytes) {
    return { bytes: size, reason: `${file} is ${kb(size)} (${tok(size)}). Grep/search for the symbol you need first, then view only that line range.` };
  }
  return null;
}

// Returns { key, reason, bytes } when the call looks wasteful, otherwise null.
export function inspect(call, cfg) {
  const { tool, args, cwd } = call;
  const t = tool.toLowerCase();

  // Whole-file reads: Copilot `view {path, view_range}`, Claude `Read {file_path, offset, limit}`
  if (t === 'view' || t === 'read' || t === 'read_file') {
    const file = args.path ?? args.file_path ?? args.filePath;
    const ranged = args.view_range ?? args.viewRange ?? args.limit ?? args.offset;
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
