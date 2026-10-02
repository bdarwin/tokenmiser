import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../tokenmiser.mjs', import.meta.url));

// Writes <root>/.tokenmiser/tm (+ tm.cmd on Windows) so the agent has a short command
// for the code index; the plugin's own path is long and not on PATH.
// Returns the command as the agent should type it from `cwd`, or null.
export function ensureShim(root, cwd) {
  try {
    const dir = path.join(root, '.tokenmiser');
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const sh = path.join(dir, 'tm');
    const body = `#!/bin/sh\nexec node "${ENTRY}" "$@"\n`;
    if (!fs.existsSync(sh) || fs.readFileSync(sh, 'utf8') !== body) fs.writeFileSync(sh, body, { mode: 0o755 });
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, 'tm.cmd'), `@node "${ENTRY}" %*\r\n`);
    const rel = path.relative(cwd, sh).replace(/\\/g, '/');
    return rel.startsWith('..') || path.isAbsolute(rel) ? sh : rel.startsWith('.') ? rel : `./${rel}`;
  } catch {
    return null;
  }
}
