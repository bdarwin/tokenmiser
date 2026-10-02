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
    // Compare real paths: git reports the resolved root, while cwd may go through a
    // symlink (macOS: /var -> /private/var, /tmp -> /private/tmp).
    const real = (d) => {
      try {
        return fs.realpathSync.native(d); // .native also expands Windows 8.3 short names (RUNNER~1)
      } catch {
        return d;
      }
    };
    const rel = path.relative(real(cwd), real(sh)).replace(/\\/g, '/');
    const cmd = rel.startsWith('..') || path.isAbsolute(rel) ? sh : rel.startsWith('.') ? rel : `./${rel}`;
    // PowerShell/cmd can't run the shell script; point Windows agents at tm.cmd.
    return process.platform === 'win32' ? `${cmd.replace(/\//g, '\\')}.cmd` : cmd;
  } catch {
    return null;
  }
}
