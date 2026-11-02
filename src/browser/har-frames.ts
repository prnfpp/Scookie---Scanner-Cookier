import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { SessionResult } from '../types.js';
import { maskPii } from '../util/pii.js';

interface Entry {
  startedDateTime: string;
  request: { url: string; method: string };
  _frameref?: string;
  _resourceType?: string;
}

function readEntries(runDir: string, har: string): Entry[] | null {
  for (const rel of [`${har}.gz`, har]) {
    const p = join(runDir, rel);
    if (!existsSync(p)) continue;
    try {
      const buf = readFileSync(p);
      return (JSON.parse((rel.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8')) as { log: { entries: Entry[] } }).log.entries;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Attribuzione delle richieste di una rilevazione già raccolta (prima della 0.1.1 la pagina era l'indirizzo verso cui
 * si stava navigando) con i dati del file HAR: ogni voce indica il frame che l'ha generata (`_frameref`). La pagina
 * che ospita un iframe è il documento principale caricato prima del documento dell'iframe. Se una richiesta di un
 * iframe risulta attribuita a un'altra pagina, è partita mentre si lasciava la pagina che lo ospitava: si attribuisce
 * a quella e si marca "inviata all'uscita". Le richieste del frame principale restano come sono (senza il momento del
 * commit della navigazione non si distingue il documento uscente da quello nuovo). Ritorna il numero di richieste
 * riattribuite per sessione.
 */
export function reattributeFromHar(runDir: string, sessions: SessionResult[]): Map<string, number> {
  const changed = new Map<string, number>();
  for (const s of sessions) {
    // già con le informazioni sul frame (rilevazione 0.1.1 o successiva con documento del frame): nulla da fare
    const needExit = !s.requests.some((r) => r.sentOnExit !== undefined);
    const needFrame = !s.requests.some((r) => r.frameUrl !== undefined);
    if (!s.har || (!needExit && !needFrame)) continue;
    const entries = readEntries(runDir, s.har);
    if (!entries?.length || !entries.some((e) => e._frameref)) continue;
    const t = (e: Entry) => Date.parse(e.startedDateTime);
    const docs = entries.filter((e) => e._resourceType === 'document' && e._frameref).sort((a, b) => t(a) - t(b));
    // frame principale: quello che ha caricato la prima pagina della sessione
    const first = s.pages[0];
    const mainRef = docs.find((d) => maskPii(d.request.url) === first || d.request.url === first)?._frameref ?? docs[0]?._frameref;
    if (!mainRef) continue;
    const mainDocs = docs.filter((d) => d._frameref === mainRef);
    // per ogni iframe: la pagina principale caricata prima del suo (ultimo) documento
    const hostOf = (ref: string, at: number): string | null => {
      const own = docs.filter((d) => d._frameref === ref && t(d) <= at).at(-1);
      if (!own) return null;
      const top = mainDocs.filter((d) => t(d) <= t(own)).at(-1);
      return top ? maskPii(top.request.url) : null;
    };
    const byUrl = new Map<string, Entry[]>();
    for (const e of entries) {
      const k = maskPii(e.request.url);
      byUrl.set(k, [...(byUrl.get(k) ?? []), e]);
    }
    let n = 0;
    for (const r of s.requests) {
      if (r.resourceType === 'document') continue;
      const at = Date.parse(r.at);
      const e = (byUrl.get(r.url) ?? []).filter((x) => x.request.method === r.method).sort((a, b) => Math.abs(t(a) - at) - Math.abs(t(b) - at))[0];
      if (!e?._frameref || e._frameref === mainRef || Math.abs(t(e) - at) > 2000) continue;
      if (needFrame) {
        const doc = docs.filter((d) => d._frameref === e._frameref && t(d) <= t(e)).at(-1);
        if (doc) r.frameUrl = maskPii(doc.request.url);
      }
      if (!needExit) continue;
      const host = hostOf(e._frameref, t(e));
      if (host && host !== r.pageUrl) {
        r.pageUrl = host;
        r.sentOnExit = true;
        n++;
      }
    }
    if (n) changed.set(s.id, n);
  }
  return changed;
}
