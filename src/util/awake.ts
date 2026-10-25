import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Impedisce lo stop del computer finché l'audit è in corso (un audit completo può durare più di un'ora).
 * macOS: caffeinate; Linux: systemd-inhibit; Windows: SetThreadExecutionState. Restituisce la funzione che
 * rilascia il blocco. Con il coperchio chiuso un Mac va comunque in stop (salvo alimentatore e monitor esterno).
 */
export function keepAwake(log: (m: string) => void = () => {}): () => void {
  let child: ChildProcess | null = null;
  try {
    if (process.platform === 'darwin') {
      // -i: niente stop per inattività; -s: niente stop di sistema con l'alimentatore; -w: termina con questo processo
      child = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      child = spawn('systemd-inhibit', ['--what=idle:sleep', '--who=Scookie', '--why=Audit in corso', '--mode=block', 'sleep', 'infinity'], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      const ps =
        "$t = Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);' -Name P -Namespace W -PassThru; " +
        'while ($true) { $t::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep 30 }';
      child = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    }
    child?.on('error', () => {
      child = null;
      log('Impossibile impedire lo stop del computer: tenerlo acceso e sveglio fino alla fine dell\'audit.');
    });
    if (child) log('Il computer resta sveglio fino alla fine dell\'audit (con il coperchio chiuso un Mac va comunque in stop).');
  } catch {
    child = null;
  }
  return () => {
    child?.kill();
    child = null;
  };
}
