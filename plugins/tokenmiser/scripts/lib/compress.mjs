// Lossy-but-safe compression of tool output before the model sees it.
// Everything that is cut is recoverable from the spill file.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// Lines that carry no information for an agent: spinners, progress bars,
// download/fetch chatter from package managers and build tools.
const NOISE = [
  /^\s*[⠀-⣿|/\\-]\s*$/, // lone spinner frame
  /[█▓▒░━─=#>]{12,}/, // progress bars
  /^\s*\d{1,3}(\.\d+)?%\s*(\||$)/, // "42% |"
  /^\s*(Downloading|Downloaded|Fetching|Fetched|Resolving|Resolved|Unpacking|Progress|Receiving objects|Resolving deltas|Counting objects|Compressing objects|remote: (Counting|Compressing|Enumerating|Total))\b.*\d/i,
  /^\s*(npm (http|timing|sill|verb)|idealTree|reify:|\[#+\.*\])/,
  /^\s*Collecting \S+$/, // pip
  /^\s*(Using cached|Requirement already satisfied:)/, // pip
  /^\s*(Compiling|Checking|Downloaded|Fresh) \S+ v\d/, // cargo
  /^\s*\d+ packages? are looking for funding/,
  /^\s*run `npm fund`/,
];

const IMPORTANT = /\b(error|errors|fail(ed|ure|ing)?|fatal|panic|exception|traceback|assert(ion)?|warn(ing)?|denied|not found|undefined|cannot|unable|segmentation|expected|received|✗|✖|×)\b|^\s*(E|F)\s|^\s*at\s.+:\d+|:\d+:\d+/i;

export const DEFAULTS = {
  maxChars: 6000, // budget for the text the model sees (~1.5k tokens)
  headLines: 30,
  tailLines: 50,
  maxImportant: 40, // important lines kept from the elided middle
  minSavings: 0.15, // don't bother rewriting for less than 15% saved
  collapseSimilar: true, // fold runs of lines that differ only in numbers (off for search results)
};

export function estimateTokens(textOrChars) {
  const n = typeof textOrChars === 'number' ? textOrChars : (textOrChars?.length ?? 0);
  return Math.ceil(Math.max(0, n) / 4);
}

function cleanLines(text) {
  const out = [];
  for (let raw of text.replace(ANSI, '').split(/\r?\n/)) {
    // carriage-return redraws: only the final frame matters
    if (raw.includes('\r')) raw = raw.split('\r').filter(Boolean).pop() ?? '';
    const line = raw.replace(/\s+$/, '');
    if (NOISE.some((re) => re.test(line))) continue;
    if (line === '' && out.length && out[out.length - 1] === '') continue;
    out.push(line);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

// Collapse runs of identical lines, and runs of lines that differ only in numbers
// ("test 1 passed", "test 2 passed", ...).
function dedupeRuns(lines, collapseSimilar) {
  const shape = (l) => l.replace(/\d+(\.\d+)?/g, '#');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    if (j - i > 2) {
      out.push(`${lines[i]}  [×${j - i}]`);
      i = j;
      continue;
    }
    const s = shape(lines[i]);
    j = i + 1;
    while (collapseSimilar && j < lines.length && s !== lines[i] && shape(lines[j]) === s) j++;
    if (j - i > 4) {
      out.push(lines[i], `  … ${j - i - 2} similar lines …`, lines[j - 1]);
      i = j;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out;
}

function truncate(lines, opts, spillNote) {
  const { headLines, tailLines, maxImportant } = opts;
  if (lines.length <= headLines + tailLines) return lines;
  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const middle = lines.slice(headLines, lines.length - tailLines);
  const keep = new Set();
  for (let k = 0; k < middle.length && keep.size < maxImportant; k++) {
    if (IMPORTANT.test(middle[k])) {
      if (k > 0) keep.add(k - 1);
      keep.add(k);
      if (k + 1 < middle.length) keep.add(k + 1);
    }
  }
  const kept = [];
  let gap = 0;
  const flush = () => {
    if (gap && keep.size) kept.push(`  … ${gap} lines omitted …`);
    gap = 0;
  };
  middle.forEach((l, k) => {
    if (keep.has(k)) {
      flush();
      kept.push(l);
    } else gap++;
  });
  flush();
  return [...head, ...kept, `[tokenmiser: ${middle.length - keep.size} of ${lines.length} lines omitted${spillNote}]`, ...tail];
}

// Hard cap on characters (protects against single enormous lines, minified JSON, etc.)
function capChars(text, maxChars, spillNote) {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.4);
  const tailLen = maxChars - headLen;
  return `${text.slice(0, headLen)}\n[tokenmiser: ${text.length - maxChars} chars omitted${spillNote}]\n${text.slice(-tailLen)}`;
}

/**
 * Compress tool output. Returns { text, changed, truncated, before, after }.
 * `spill` is an optional function(original) => path, called only when content is dropped.
 */
export function compress(input, options = {}, spill) {
  const opts = { ...DEFAULTS, ...options };
  const original = String(input ?? '');
  const before = original.length;
  let lines = dedupeRuns(cleanLines(original), opts.collapseSimilar);
  let text = lines.join('\n');
  let truncated = false;
  let spillNote = '';
  const needsCut = text.length > opts.maxChars;
  if (needsCut && spill) {
    try {
      const p = spill(original);
      if (p) spillNote = `; full output: ${p}`;
    } catch {
      /* spilling is best-effort */
    }
  }
  if (needsCut) {
    truncated = true;
    text = capChars(truncate(lines, opts, spillNote).join('\n'), opts.maxChars, spillNote);
  }
  const after = text.length;
  const changed = before - after > 0 && (truncated || (before - after) / Math.max(before, 1) >= opts.minSavings);
  return { text: changed ? text : original, changed, truncated, before, after: changed ? after : before };
}
