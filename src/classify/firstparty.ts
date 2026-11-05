import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { RequestRecord, SessionResult, StatsProbe } from '../types.js';

/**
 * Stato dei cookie di uno strumento di statistica ospitato sul sito (Matomo/Piwik), da fatti osservabili:
 * - "senza cookie": nessun cookie _pk_* o MATOMO_SESSID in nessuna sessione, parametro _id vuoto o assente in tutti gli
 *   hit, e come prova accessoria "disableCookies" nella configurazione _paq oppure hasCookies() falso letto a fine pagina;
 * - "con cookie": il sito scrive _pk_id o _pk_ses;
 * - "non determinabile": negli altri casi (es. hit con i parametri nel corpo, prova accessoria assente).
 * Lo strumento non qualifica il trattamento (es. "tecnico" o "esente"): documenta i fatti e dichiara quelli che dal
 * browser non si vedono.
 */
export type CookieState = 'senza-cookie' | 'con-cookie' | 'non-determinabile';
export interface CookieMode {
  state: CookieState;
  /** Fatti a sostegno, in parole. */
  facts: string[];
  /** Parametri degli hit che indicano dati dell'utente inviati (uid, variabili personalizzate, dimensioni con valore). */
  userData: string[];
}

export const COOKIE_STATE_LABEL: Record<CookieState, string> = {
  'senza-cookie': 'senza cookie',
  'con-cookie': 'con cookie',
  'non-determinabile': 'non determinabile',
};

/** Condizioni che contano per la qualificazione e che dal browser non si possono verificare. */
export const UNVERIFIABLE = [
  "mascheramento (anonimizzazione) dell'indirizzo IP sul server di raccolta",
  'durata di conservazione dei dati raccolti',
  'assenza di incroci con altre fonti o di uso per altre finalità',
  'titolarità e gestione del server di raccolta (chi riceve e tratta i dati)',
];

const MATOMO = /^(matomo|piwik)\b/i;
export const isMatomo = (vendor: string) => MATOMO.test(vendor) && !/piwik pro/i.test(vendor);
const isCollect = (r: RequestRecord) => r.method !== 'GET' || /[?&](rec|idsite)=/.test(r.url);

function query(u: string): URLSearchParams | null {
  try {
    return new URL(u).searchParams;
  } catch {
    return null;
  }
}

/** Stato dei cookie di Matomo/Piwik in un sito, dalle sessioni valide di quel sito. */
export function matomoCookieMode(sessions: SessionResult[]): CookieMode {
  const facts: string[] = [];
  const pk = [...new Set(sessions.flatMap((s) => s.cookies.filter((c) => /^_pk_|^MATOMO_SESSID$/.test(c.name)).map((c) => c.name.replace(/\..*$/, ''))))];
  const hits = sessions.flatMap((s) => s.requests.filter((r) => r.tracker && isMatomo(r.tracker.company) && isCollect(r)));
  const userData = userDataParams(hits);
  if (pk.some((n) => /^_pk_(id|ses)$/.test(n))) {
    return { state: 'con-cookie', facts: [`cookie scritti: ${pk.join(', ')}`], userData };
  }
  const withQuery = hits.filter((r) => query(r.url)?.has('idsite') || query(r.url)?.has('rec'));
  const idSet = withQuery.filter((r) => (query(r.url)?.get('_id') ?? '') !== '');
  const probes = sessions.flatMap((s) => s.statsProbe ?? []);
  const disable = probes.some((p) => p.paq?.includes('disableCookies'));
  const hasCookiesFalse = probes.some((p) => p.hasCookies === false);
  const hasCookiesTrue = probes.some((p) => p.hasCookies === true);
  facts.push(pk.length ? `cookie di Matomo scritti: ${pk.join(', ')}` : `nessun cookie _pk_* o MATOMO_SESSID in ${sessions.length === 1 ? '1 sessione' : `${sessions.length} sessioni`}`);
  if (hits.length) {
    facts.push(
      withQuery.length < hits.length
        ? `${hits.length - withQuery.length} hit su ${hits.length} con i parametri nel corpo della richiesta: il parametro _id non è leggibile`
        : idSet.length
          ? `parametro _id valorizzato in ${idSet.length} hit su ${hits.length}`
          : `parametro _id vuoto o assente in tutti gli hit (${hits.length})`,
    );
  }
  if (disable) facts.push('"disableCookies" nella configurazione _paq della pagina');
  if (hasCookiesFalse) facts.push('hasCookies() del tracker falso, letto a fine pagina');
  if (hasCookiesTrue) facts.push('hasCookies() del tracker vero, letto a fine pagina');
  if (!probes.length) facts.push('configurazione del tracker non letta (rilevazione precedente alla 0.1.2 e pagina non presente nel file HAR)');
  const ok = !pk.length && hits.length > 0 && withQuery.length === hits.length && !idSet.length && (disable || hasCookiesFalse) && !hasCookiesTrue;
  return { state: ok ? 'senza-cookie' : 'non-determinabile', facts, userData };
}

/** Parametri che indicano dati dell'utente negli hit di Matomo: uid, variabili personalizzate, dimensioni con valore. */
function userDataParams(hits: RequestRecord[]): string[] {
  const count = new Map<string, number>();
  for (const r of hits) {
    const q = query(r.url);
    if (!q) continue;
    for (const [k, v] of q) {
      if (!v) continue;
      if (k === 'uid' || k === '_cvar' || k === 'cvar' || /^dimension\d+$/.test(k)) count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  return [...count].map(([k, n]) => `${k} (in ${n === 1 ? '1 hit' : `${n} hit`})`);
}

/**
 * Configurazione di Matomo nelle pagine di una rilevazione già raccolta, dal file HAR (documenti HTML salvati):
 * i comandi _paq scritti nella pagina (es. "disableCookies"). Solo per le sessioni senza la lettura a fine pagina.
 */
export function probesFromHar(runDir: string, sessions: SessionResult[]): number {
  let n = 0;
  for (const s of sessions) {
    if (s.statsProbe?.length || !s.har) continue;
    const entries = readHar(runDir, s.har);
    if (!entries) continue;
    const found: StatsProbe[] = [];
    for (const e of entries) {
      const text = e.response?.content?.text;
      if (!text || !/text\/html/.test(e.response?.content?.mimeType ?? '') || !text.includes('_paq')) continue;
      const paq = paqCommands(e.response!.content!.encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text);
      if (paq.length) found.push({ url: e.request.url, paq, hasCookies: null, source: 'har' });
    }
    if (found.length) {
      s.statsProbe = found;
      n++;
    }
  }
  return n;
}

/** Comandi _paq.push([...]) scritti nel codice della pagina. */
export function paqCommands(html: string): string[] {
  return [...new Set([...html.matchAll(/_paq\.push\(\s*\[\s*['"]([A-Za-z]+)['"]/g)].map((m) => m[1]))];
}

interface HarEntry {
  request: { url: string };
  response?: { content?: { text?: string; mimeType?: string; encoding?: string } };
}

function readHar(runDir: string, har: string): HarEntry[] | null {
  for (const rel of [har, `${har}.gz`, har.replace(/\.gz$/, '')]) {
    const p = join(runDir, rel);
    if (!existsSync(p)) continue;
    try {
      const buf = readFileSync(p);
      return (JSON.parse((rel.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8')) as { log: { entries: HarEntry[] } }).log.entries;
    } catch {
      return null;
    }
  }
  return null;
}
