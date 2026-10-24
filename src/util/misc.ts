import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Anteprima di un valore: abbastanza per riconoscerlo, non per riusarlo. */
export function preview(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max)}… (${value.length} car.)` : value;
}

/** Nome sicuro per file. */
export function slug(text: string, max = 60): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max) || 'x'
  );
}

export function timestampForPath(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Rifiuta se la promessa non si risolve entro `ms`: una pagina bloccata non deve fermare l'intera esecuzione. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: nessuna risposta dopo ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Chiude una pagina o un contesto senza mai bloccarsi; ritorna l'errore, se c'è stato. */
export async function closeSafely(target: { close(): Promise<void> }, ms = 30000, label = 'chiusura'): Promise<string | null> {
  try {
    await withTimeout(target.close(), ms, label);
    return null;
  } catch (e) {
    return (e as Error).message.split('\n')[0];
  }
}
