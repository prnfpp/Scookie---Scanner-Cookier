import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type HarContent = 'tutti' | 'testo' | 'nessuno';

const TEXT_MIME = /^(text\/|application\/(json|javascript|x-javascript|ecmascript|xml|.*\+json|.*\+xml|x-www-form-urlencoded))/i;
const MAX_TEXT_BYTES = 512 * 1024;

interface HarEntry {
  request?: { postData?: { text?: string; _file?: string } };
  response?: { content?: { text?: string; encoding?: string; mimeType?: string; size?: number; comment?: string; _file?: string } };
}

/** Con harContenuti "tutti" i corpi binari si includono fino a questa misura: oltre, il file HAR non sarebbe più leggibile. */
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
/** I corpi delle richieste (dati inviati) restano sempre; oltre questa misura (caricamenti di file) se ne tiene l'inizio. */
const MAX_POST_BYTES = 5 * 1024 * 1024;

/**
 * Compone il file HAR di una sessione registrata con i corpi in file separati (modalità "attach" di Playwright): così
 * i corpi grandi (video, immagini) non passano mai dalla memoria e non entrano nel file. Nel file finale rientrano i
 * corpi delle richieste, sempre, e quelli delle risposte secondo `mode`; la cartella temporanea viene eliminata.
 * Ritorna il numero di corpi di risposta omessi.
 */
export function assembleHar(tmpDir: string, harName: string, dest: string, mode: HarContent): number {
  let removed = 0;
  try {
    const har = JSON.parse(readFileSync(join(tmpDir, harName), 'utf8')) as { log: { comment?: string; entries: HarEntry[] } };
    const size = (f: string) => {
      try {
        return statSync(join(tmpDir, f)).size;
      } catch {
        return -1;
      }
    };
    for (const e of har.log.entries) {
      const post = e.request?.postData;
      if (post?._file) {
        const n = size(post._file);
        if (n >= 0) {
          const buf = readFileSync(join(tmpDir, post._file));
          post.text = buf.subarray(0, MAX_POST_BYTES).toString('utf8') + (n > MAX_POST_BYTES ? `… [corpo di ${n} byte: conservato l'inizio]` : '');
        }
        delete post._file;
      }
      const c = e.response?.content;
      if (!c?._file) continue;
      const n = size(c._file);
      const isText = TEXT_MIME.test(c.mimeType ?? '');
      const keep = n >= 0 && (mode === 'testo' ? isText && n <= MAX_TEXT_BYTES : mode === 'tutti' ? n <= MAX_BINARY_BYTES : false);
      if (keep) {
        const buf = readFileSync(join(tmpDir, c._file));
        if (isText) c.text = buf.toString('utf8');
        else {
          c.text = buf.toString('base64');
          c.encoding = 'base64';
        }
      } else if (n !== 0) {
        c.comment = 'corpo della risposta omesso da Scookie (harContenuti)';
        removed++;
      }
      delete c._file;
    }
    har.log.comment =
      mode === 'tutti'
        ? `Corpi delle risposte: conservati fino a ${MAX_BINARY_BYTES / 1024 / 1024} MB ciascuno; corpi delle richieste conservati.`
        : `Corpi delle risposte: ${mode === 'testo' ? `conservati solo i testuali fino a ${MAX_TEXT_BYTES / 1024} KB` : 'omessi'}; corpi delle richieste conservati.`;
    writeFileSync(dest, JSON.stringify(har));
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  }
  return removed;
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
