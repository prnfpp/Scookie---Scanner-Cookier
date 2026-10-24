import { readFileSync, writeFileSync } from 'node:fs';

export type HarContent = 'tutti' | 'testo' | 'nessuno';

const TEXT_MIME = /^(text\/|application\/(json|javascript|x-javascript|ecmascript|xml|.*\+json|.*\+xml|x-www-form-urlencoded))/i;
const MAX_TEXT_BYTES = 512 * 1024;

interface HarEntry {
  response?: { content?: { text?: string; encoding?: string; mimeType?: string; size?: number; comment?: string } };
}

/**
 * Riduce un file HAR togliendo i corpi delle risposte che non servono come prova (immagini, font, video,
 * testi molto grandi). I corpi delle richieste, cioè i dati inviati ai terzi, restano sempre: per questo
 * non si usa la modalità "omit" di Playwright, che toglie anche quelli. Ritorna il numero di corpi rimossi.
 */
export function trimHar(path: string, mode: HarContent): number {
  if (mode === 'tutti') return 0;
  const har = JSON.parse(readFileSync(path, 'utf8')) as { log: { comment?: string; entries: HarEntry[] } };
  let removed = 0;
  for (const e of har.log.entries) {
    const c = e.response?.content;
    if (!c || c.text === undefined) continue;
    const keep = mode === 'testo' && TEXT_MIME.test(c.mimeType ?? '') && c.encoding !== 'base64' && c.text.length <= MAX_TEXT_BYTES;
    if (!keep) {
      delete c.text;
      delete c.encoding;
      c.comment = 'corpo della risposta omesso da Scookie (harContenuti)';
      removed++;
    }
  }
  har.log.comment = `Corpi delle risposte: ${mode === 'testo' ? `conservati solo i testuali fino a ${MAX_TEXT_BYTES / 1024} KB` : 'omessi'}; corpi delle richieste conservati.`;
  writeFileSync(path, JSON.stringify(har));
  return removed;
}
