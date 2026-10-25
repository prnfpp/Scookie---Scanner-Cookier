import { STAGE_LABEL, type Category, type InteractionReport, type Evidence, type RequestRecord, type SessionResult, type Stage } from '../types.js';

export const CATEGORY_LABEL: Record<Category, string> = {
  tecnico: 'tecnico',
  funzionalita: 'funzionalità',
  statistica: 'statistica',
  marketing: 'marketing/pubblicità',
  'registrazione-sessioni': 'registrazione sessioni/heatmap',
  social: 'social',
  sconosciuta: 'non classificata',
};

export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    const list = m.get(k) ?? [];
    list.push(i);
    m.set(k, list);
  }
  return m;
}

export function sessionEvidence(s: SessionResult, labels: string[]): Evidence[] {
  const out = s.screenshots.filter((e) => labels.some((l) => e.label.includes(l)));
  if (s.har) out.push({ label: `HAR sessione ${s.id}`, file: s.har });
  return out;
}

/** Estratto di una richiesta per la scheda della criticità (il dettaglio completo è nel HAR). */
export function requestExcerpt(r: RequestRecord, s: SessionResult): Record<string, unknown> {
  return {
    sessione: s.id,
    har: s.har,
    seq: r.seq,
    momento: r.at,
    msDallaScelta: r.msFromChoice,
    ...(r.msFromRevoke != null ? { msDallaRevoca: r.msFromRevoke } : {}),
    metodo: r.method,
    url: r.url.length > 500 ? `${r.url.slice(0, 500)}…` : r.url,
    tipo: r.resourceType,
    stato: r.status,
    pagina: r.pageUrl,
    ...(r.fromServiceWorker ? { daServiceWorker: true } : {}),
    ...(r.consentParams ? { parametriConsenso: r.consentParams } : {}),
    ...(describeGoogleConsent(r.consentParams) ? { consensoGoogle: describeGoogleConsent(r.consentParams) } : {}),
  };
}

/**
 * Ping di Google Consent Mode con consenso negato o non impostato per ad_storage e analytics_storage.
 * Formato gcs: G1<ad_storage><analytics_storage>, dove 1 = concesso, 0 = negato, "-" = non impostato.
 */
export function isConsentModeDeniedPing(r: RequestRecord): boolean {
  const gcs = r.consentParams?.gcs;
  return !!gcs && /^G1[0-][0-]$/.test(gcs);
}

export const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10) : 'sessione');

export function hostsSummary(reqs: RequestRecord[], max = 5): string {
  const hosts = [...new Set(reqs.map((r) => r.host))];
  return hosts.slice(0, max).join(', ') + (hosts.length > max ? ` e altri ${hosts.length - max}` : '');
}

/**
 * Descrive quando compaiono gli elementi di una criticità "prima della scelta":
 * già al caricamento oppure solo dopo lo scroll (che non è una scelta sul banner).
 */
export function stageWhen(stages: Stage[]): { when: string; onlyAfterScroll: boolean } {
  const onlyAfterScroll = stages.length > 0 && stages.every((s) => s === 'scroll');
  return {
    onlyAfterScroll,
    when: onlyAfterScroll
      ? 'prima di qualsiasi scelta sul banner, ma solo dopo lo scroll della pagina'
      : 'prima di qualsiasi scelta sul banner, già al caricamento della pagina',
  };
}

export const stageLabel = (s: Stage) => STAGE_LABEL[s];

/** "1 richiesta", "3 richieste". */
export const nReq = (n: number) => `${n} ${n === 1 ? 'richiesta' : 'richieste'}`;

/**
 * Come è stata eseguita la scelta, descrivendo l'elemento realmente cliccato:
 * "cliccando il pulsante "Rifiuta tutti"", "chiudendo il banner con la X di chiusura (…)", "tramite l'API del CMP".
 */
export function choiceHow(i: InteractionReport): string {
  if (i.via === 'api') return `tramite l'API del gestore del consenso, senza click su un pulsante (${i.detail})`;
  const els = (i.clicked?.length ? i.clicked : [i.detail]).map(withArticle);
  if (i.layer === 'chiusura-x') return `chiudendo il banner con ${els[0]}`;
  return `cliccando ${els.join(' e poi ')}`;
}

/** "pulsante "Rifiuta"" → "il pulsante "Rifiuta""; "X di chiusura" → "la X di chiusura". */
export const withArticle = (label: string) =>
  /^(pulsante|link)\b/.test(label) ? `il ${label}` : /^X\b/.test(label) ? `la ${label}` : label;

/** Livelli di forza della prova, dal più debole al più forte. */
export type EvidenceLevel = 'risorsa' | 'raccolta' | 'identificativo';

export const EVIDENCE_LABEL: Record<EvidenceLevel, string> = {
  risorsa: 'risorsa scaricata dal fornitore (script, contenuto o immagine statica): nessun dato di raccolta osservato',
  raccolta: 'dati di navigazione inviati al fornitore (richiesta di raccolta con parametri)',
  identificativo: 'identificativo memorizzato nel browser (cookie o storage)',
};

/**
 * Forza della prova di un gruppo di richieste: scaricare uno script è meno di inviare una raccolta di dati.
 * Raccolta = richiesta POST, oppure richiesta di tipo pixel/beacon/xhr/fetch con parametri nell'URL.
 */
export function requestEvidenceLevel(reqs: RequestRecord[]): EvidenceLevel {
  const isCollect = (r: RequestRecord) => {
    if (r.method !== 'GET' && r.method !== 'HEAD') return true;
    const hasQuery = r.url.includes('?') && r.url.split('?')[1].length > 0;
    return ['image', 'ping', 'xhr', 'fetch', 'beacon', 'eventsource', 'websocket', 'other'].includes(r.resourceType) && hasQuery;
  };
  return reqs.some(isCollect) ? 'raccolta' : 'risorsa';
}

/**
 * La richiesta che meglio sostiene il livello di prova: una raccolta di dati (meglio se POST e con parametri di consenso)
 * prima di uno script; la telemetria dello script stesso (host metrics.*) per ultima.
 */
export function strongestRequest(reqs: RequestRecord[]): RequestRecord {
  const score = (r: RequestRecord) =>
    (requestEvidenceLevel([r]) === 'raccolta' ? 10 : 0) + (r.method === 'POST' ? 3 : 0) + (r.consentParams ? 1 : 0) - (/^metrics\./.test(r.host) ? 6 : 0) - (r.fromServiceWorker ? 2 : 0);
  return reqs.reduce((best, r) => (score(r) > score(best) ? r : best), reqs[0]);
}

/**
 * Stato del consenso Google in poche parole, per i titoli della sintesi:
 * "con ad_storage negato (senza cookie pubblicitari)" oppure "senza alcun segnale di consenso (Consent Mode assente)".
 */
/**
 * Segnali di consenso Google in un gruppo di richieste: la frase per il titolo vale solo se tutte le richieste
 * con parametri di consenso dicono la stessa cosa; altrimenti lo si dichiara. Più il dettaglio con i conteggi.
 */
export function googleConsentSummary(reqs: RequestRecord[]): { short: string | null; detail: string | null } {
  const withParams = reqs.filter((r) => r.consentParams?.gcs || r.consentParams?.gcd);
  if (!withParams.length) return { short: null, detail: null };
  const counts = new Map<string, { n: number; sw: number }>();
  for (const r of withParams) {
    const k = googleConsentShort(r.consentParams) ?? `gcs=${r.consentParams!.gcs ?? '—'}, gcd=${r.consentParams!.gcd ?? '—'}`;
    const c = counts.get(k) ?? { n: 0, sw: 0 };
    c.n++;
    if (r.fromServiceWorker) c.sw++;
    counts.set(k, c);
  }
  const detail = `Segnali di consenso Google nelle richieste: ${[...counts]
    .map(([k, c]) => `${k} (${c.n === 1 ? '1 richiesta' : `${c.n} richieste`}${c.sw ? `, di cui ${c.sw} da service worker` : ''})`)
    .join('; ')}`;
  const shorts = [...new Set(withParams.map((r) => googleConsentShort(r.consentParams)))];
  const short = shorts.length === 1 && shorts[0] ? shorts[0] : counts.size > 1 ? 'con segnali di consenso diversi tra le richieste' : null;
  return { short, detail };
}

export function googleConsentShort(params: Record<string, string> | undefined): string | null {
  if (!params) return null;
  const gcs = params.gcs;
  if (gcs && /^G1[01-][01-]$/.test(gcs)) {
    if (gcs[2] === '0') return 'con ad_storage negato, cioè senza cookie pubblicitari';
    if (gcs[2] === '1') return 'con consenso pubblicitario dichiarato come concesso';
  }
  const letters = (params.gcd ?? '').slice(2).match(/[a-z]/g) ?? [];
  if (letters.length >= 4 && letters.slice(0, 4).every((l) => l === 'l')) return 'senza alcun segnale di consenso (Consent Mode non impostato)';
  return null;
}

const GCS: Record<string, string> = { '1': 'concesso', '0': 'negato', '-': 'non impostato' };
const GCD: Record<string, string> = {
  l: 'non impostato',
  p: 'negato (predefinito)',
  q: 'negato (predefinito e dopo l\'aggiornamento)',
  t: 'concesso (predefinito)',
  r: 'concesso dopo l\'aggiornamento (predefinito negato)',
  m: 'negato (dopo l\'aggiornamento)',
  n: 'concesso (dopo l\'aggiornamento)',
  u: 'negato dopo l\'aggiornamento (predefinito concesso)',
  v: 'concesso (predefinito e dopo l\'aggiornamento)',
};

/**
 * Traduce i parametri di Google Consent Mode in linguaggio leggibile.
 * gcs = G1<ad_storage><analytics_storage>; gcd codifica ad_storage, analytics_storage, ad_user_data, ad_personalization.
 */
export function describeGoogleConsent(params: Record<string, string> | undefined): string | null {
  if (!params) return null;
  const parts: string[] = [];
  const gcs = /^G1([01-])([01-])$/.exec(params.gcs ?? '');
  if (gcs) parts.push(`gcs=${params.gcs}: ad_storage ${GCS[gcs[1]]}, analytics_storage ${GCS[gcs[2]]}`);
  const gcd = /^1\d?([a-z])\d([a-z])\d([a-z])\d([a-z])/.exec(params.gcd ?? '');
  if (gcd) {
    const names = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];
    parts.push(`gcd=${params.gcd}: ${names.map((n, i) => `${n} ${GCD[gcd[i + 1]] ?? `codice "${gcd[i + 1]}"`}`).join(', ')}`);
  }
  if (params.npa === '1') parts.push('npa=1: annunci non personalizzati richiesti');
  return parts.length ? parts.join('; ') : null;
}
