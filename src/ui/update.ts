import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cartella del tool (il repository clonato da GitHub). */
export const TOOL_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const BRANCH = 'main';

const git = (args: string[], timeout = 20000) =>
  new Promise<string>((ok, ko) =>
    execFile('git', args, { cwd: TOOL_DIR, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out) => (e ? ko(e) : ok(out.trim()))),
  );

export interface UpdateInfo {
  /** Versione in uso (commit breve) e data. */
  current: string | null;
  /** Aggiornamenti su GitHub non ancora scaricati; null se non verificabile. */
  available: number | null;
  /** L'aggiornamento automatico è possibile da qui (icona di avvio su Mac). */
  canRestart: boolean;
  error?: string;
}

/** Confronta la versione in uso con quella su GitHub (ramo principale). */
export async function checkUpdates(): Promise<UpdateInfo> {
  const canRestart = process.platform === 'darwin' && existsSync(join(TOOL_DIR, 'scripts', 'avvia-mac.sh'));
  if (!existsSync(join(TOOL_DIR, '.git'))) return { current: null, available: null, canRestart: false, error: 'cartella del tool non collegata a GitHub' };
  let current: string | null = null;
  try {
    current = await git(['log', '-1', '--format=%h del %cd', '--date=format:%d/%m/%Y']);
    await git(['fetch', '-q', 'origin', BRANCH]);
    const n = Number(await git(['rev-list', '--count', `HEAD..origin/${BRANCH}`]));
    return { current, available: Number.isFinite(n) ? n : null, canRestart };
  } catch (e) {
    return { current, available: null, canRestart, error: `GitHub non raggiungibile (${(e as Error).message.split('\n')[0].slice(0, 120)})` };
  }
}

/**
 * Riavvio con aggiornamento: lo script di avvio (lo stesso dell'icona) parte staccato da questo processo,
 * aspetta che l'interfaccia si chiuda, aggiorna, ricompila e la riapre.
 */
export function restartWithUpdate() {
  const child = spawn('/bin/bash', ['-c', `sleep 2; exec /bin/bash "${join(TOOL_DIR, 'scripts', 'avvia-mac.sh')}" >> "$HOME/Library/Logs/Scookie.log" 2>&1`], {
    cwd: TOOL_DIR,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
