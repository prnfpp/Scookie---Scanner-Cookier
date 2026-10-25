import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TOOL_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/**
 * Versione esatta del codice (commit di git, con "+modifiche" se ci sono cambiamenti non registrati): rende la
 * rilevazione ripetibile con lo stesso codice. Null se lo strumento non è una copia del repository.
 */
export const TOOL_COMMIT: string | null = (() => {
  try {
    const cwd = fileURLToPath(new URL('../../', import.meta.url));
    const opts = { cwd, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], timeout: 5000 };
    const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], opts).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], opts).trim();
    return head + (dirty ? '+modifiche' : '');
  } catch {
    return null;
  }
})();
