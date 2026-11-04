import { NON_TECHNICAL, STAGE_LABEL, type Category, type CookieRecord, type RequestRecord as Req, type InteractionReport, type Evidence, type RequestRecord, type SessionResult, type Stage } from '../types.js';

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
    ...(r.sentOnExit ? { inviataAllUscita: true } : {}),
    ...(r.fromServiceWorker ? { daServiceWorker: true } : {}),
    ...(r.purpose ? { natura: r.purpose } : {}),
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
 * Siti senza alcun meccanismo di consenso: in nessuna sessione valida è comparso un banner né è stato riconosciuto un
 * gestore del consenso. Lo stesso criterio della regola "banner-assente".
 */
export function noBannerSites(sessions: SessionResult[]): Set<string> {
  const out = new Set<string>();
  for (const [site, list] of groupBy(sessions, (s) => s.site)) {
    if (!list.some((s) => s.interaction.bannerVisibleBefore || s.interaction.detectedCmps.length)) out.add(site);
  }
  return out;
}

/** Momento rispetto al consenso: "prima di qualsiasi scelta sul banner" oppure, se il banner non c'è, "senza alcun meccanismo". */
export const NO_BANNER = 'senza alcun meccanismo di consenso (nessun banner rilevato)';
export const beforeChoice = (noBanner: boolean) => (noBanner ? NO_BANNER : 'prima di qualsiasi scelta sul banner');

/**
 * Descrive quando compaiono gli elementi di una criticità "prima della scelta":
 * già al caricamento oppure solo dopo lo scroll (che non è una scelta sul banner).
 * Senza banner nel sito la scelta non esiste: si dice che manca qualsiasi meccanismo di consenso.
 */
export function stageWhen(stages: Stage[], noBanner = false): { when: string; onlyAfterScroll: boolean } {
  const onlyAfterScroll = stages.length > 0 && stages.every((s) => s === 'scroll');
  return {
    onlyAfterScroll,
    when: onlyAfterScroll
      ? `${beforeChoice(noBanner)}, ma solo dopo lo scroll della pagina e il movimento del mouse`
      : `${beforeChoice(noBanner)}, già al caricamento della pagina`,
  };
}

/**
 * Riga "Scenari" di un rilievo: solo gli scenari eseguiti davvero. Uno scenario con scelta in cui la scelta non c'è
 * stata (nessun banner, comando non trovato) ha osservato soltanto lo stato senza scelta: si elenca a parte, come non
 * eseguito, con il motivo.
 */
export function scenariosLine(sessions: SessionResult[], noBanner: boolean): string {
  const done = [...new Set(sessions.filter(executedScenario).map((s) => s.scenario))];
  const skipped = [...new Set(sessions.filter((s) => !executedScenario(s)).map((s) => s.scenario))].filter((x) => !done.includes(x));
  const why = noBanner ? 'nessun banner' : 'scelta non eseguita';
  return `Scenari: ${done.join(', ') || 'nessuno'}${skipped.length ? `; ${skipped.length === 1 ? `${skipped[0]} non eseguito` : `non eseguiti: ${skipped.join(', ')}`} (${why})` : ''}`;
}

/** Scenario eseguito: "nessuna azione", oppure uno scenario con scelta in cui la scelta è avvenuta. */
export const executedScenario = (s: SessionResult) => s.scenario === 'nessuna-azione' || s.interaction.outcome === 'eseguito';

export const stageLabel = (s: Stage, noBanner = false) => (noBanner && s === 'scroll' ? 'dopo lo scroll della pagina e il movimento del mouse, in assenza di banner' : STAGE_LABEL[s]);

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
  // Dopo una scelta: le richieste nel primo secondo e mezzo sono spesso la registrazione della scelta stessa (es. la
  // chiamata che salva il rifiuto) e non provano una raccolta successiva; meglio una richiesta su una pagina seguente.
  const firstPage = reqs.find((r) => r.msFromChoice != null)?.pageUrl;
  const score = (r: RequestRecord) =>
    (requestEvidenceLevel([r]) === 'raccolta' ? 10 : 0) +
    (r.method === 'POST' ? 3 : 0) +
    (r.consentParams ? 1 : 0) -
    (/^metrics\./.test(r.host) ? 6 : 0) -
    (r.fromServiceWorker ? 2 : 0) -
    (r.msFromChoice != null && r.msFromChoice >= 0 && r.msFromChoice < 1500 ? 8 : 0) +
    (r.msFromChoice != null && firstPage && r.pageUrl !== firstPage ? 2 : 0) -
    (uetConsent(r)?.consentOnly ? 4 : 0);
  return reqs.reduce((best, r) => (score(r) > score(best) ? r : best), reqs[0]);
}

/**
 * Consent Mode di Microsoft Advertising (UET): asc=G concesso, asc=D negato; evt=consent è il solo segnale di
 * consenso, senza evento di navigazione.
 */
export function uetConsent(r: RequestRecord): { state: 'concesso' | 'negato' | null; consentOnly: boolean } | null {
  if (!/(^|\.)bat\.bing\.(com|net)$/.test(r.host)) return null;
  let q: URLSearchParams;
  try {
    q = new URL(r.url).searchParams;
  } catch {
    return null;
  }
  const asc = q.get('asc');
  const state = asc === 'G' ? 'concesso' : asc === 'D' ? 'negato' : null;
  if (!state && !q.get('evt')) return null;
  return { state, consentOnly: q.get('evt') === 'consent' };
}

/** Segnali di consenso Microsoft UET in un gruppo di richieste, per il dettaglio delle schede. */
export function uetConsentSummary(reqs: RequestRecord[]): { short: string | null; detail: string | null } {
  const xs = reqs.map(uetConsent).filter((x): x is NonNullable<ReturnType<typeof uetConsent>> => !!x);
  if (!xs.length) return { short: null, detail: null };
  const denied = xs.filter((x) => x.state === 'negato').length;
  const granted = xs.filter((x) => x.state === 'concesso').length;
  const unset = xs.length - denied - granted;
  const only = xs.filter((x) => x.consentOnly).length;
  const parts = [denied ? `asc=D, consenso negato (${nReq(denied)})` : '', granted ? `asc=G, consenso concesso (${nReq(granted)})` : '', unset ? `senza parametro asc (${nReq(unset)})` : ''].filter(Boolean);
  const detail = `Consent Mode di Microsoft UET nelle richieste: ${parts.join('; ')}${only ? `; ${only} sono il solo segnale di consenso (evt=consent), senza evento di navigazione` : ''}.`;
  const short = denied === xs.length ? 'con consenso negato dichiarato (asc=D)' : granted === xs.length ? 'con consenso dichiarato come concesso (asc=G)' : null;
  return { short, detail };
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
  // le lettere possono arrivare in maiuscolo (es. 13v3vPv2v5l1): il significato si legge sulla minuscola
  const gcd = /^1\d?([a-z])\d([a-z])\d([a-z])\d([a-z])/i.exec(params.gcd ?? '');
  if (gcd) {
    const names = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];
    parts.push(`gcd=${params.gcd}: ${names.map((n, i) => `${n} ${GCD[gcd[i + 1].toLowerCase()] ?? `codice "${gcd[i + 1]}"`}`).join(', ')}`);
  } else if (params.gcd) parts.push(`gcd=${params.gcd}: codice in un formato non documentato, da leggere nel file HAR`);
  if (params.npa === '1') parts.push('npa=1: annunci non personalizzati richiesti');
  return parts.length ? parts.join('; ') : null;
}

/**
 * Fornitori non tecnici attivi dopo il rifiuto, per sito: cookie scritti dopo la scelta e richieste a tracker
 * (esclusi i ping di Consent Mode con consenso negato). Serve ad accorpare i fatti degli altri scenari (revoca,
 * personalizza) che ripetono lo stesso comportamento del rifiuto.
 */
export function activeAfterReject(sessions: SessionResult[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of sessions.filter((x) => x.scenario === 'rifiuta' && x.interaction.outcome === 'eseguito')) {
    const set = out.get(s.site) ?? new Set<string>();
    for (const c of s.cookies) if (cookieActivity(c, 'scelta')) set.add(cookieVendor(c));
    for (const r of s.requests) if (r.phase === 'dopo' && r.tracker && NON_TECHNICAL.has(r.tracker.category) && !isConsentModeDeniedPing(r)) set.add(requestVendor(r));
    out.set(s.site, set);
  }
  return out;
}

/**
 * Rimando ai rilievi di un'altra regola sullo stesso fornitore, risolto dopo la numerazione (es. "vedi R-004").
 * Se non c'è un rilievo corrispondente diventa il titolo della regola.
 */
export const refTo = (ruleId: string, subject: string, category?: string) => `{{rilievi:${ruleId}:${subject}${category ? `:${category}` : ''}}}`;

/**
 * Cookie non tecnico attivo dopo la scelta (stage "scelta") o dopo la revoca (stage "revoca"): scritto per la prima
 * volta in quel momento ("nuovo") o già presente e riscritto, cioè con valore o scadenza cambiati ("rinnovato").
 */
export function cookieActivity(c: CookieRecord, stage: 'scelta' | 'revoca'): 'nuovo' | 'rinnovato' | null {
  if (!NON_TECHNICAL.has(c.classification.category)) return null;
  if (stage === 'scelta' ? c.phase === 'dopo' : c.stage === 'revoca') return 'nuovo';
  return c.renewals?.some((r) => r.stage === stage) ? 'rinnovato' : null;
}

/**
 * Pagine di un gruppo di richieste: quelle che ospitano il contenuto che le ha inviate e, a parte, quelle da cui
 * sono partite richieste all'uscita (es. evento inviato da un video incorporato mentre si passa alla pagina successiva).
 */
export function pagesOf(reqs: RequestRecord[]): { pages: string[]; exitLine: string | null } {
  const pages = [...new Set(reqs.map((r) => r.pageUrl))];
  const exits = groupBy(reqs.filter((r) => r.sentOnExit), (r) => r.pageUrl);
  const exitLine = exits.size
    ? `Invii all'uscita dalla pagina (inviati mentre si passava alla pagina successiva, attribuiti alla pagina che ospita il contenuto): ${[...exits].map(([p, l]) => `${p} (${nReq(l.length)})`).join(', ')}`
    : null;
  return { pages, exitLine };
}

/**
 * Fornitore canonico: lo stesso fornitore con nomi diversi nelle fonti conta una volta. I cookie del lettore YouTube
 * sono "Youtube" in Open Cookie Database, le sue richieste sono "Google" nell'elenco dei domini: è lo stesso
 * contenuto incorporato e lo stesso fornitore.
 */
const VENDOR_ALIASES: [RegExp, string][] = [[/^you ?tube$/i, 'Google']];
export function canonicalVendor(name: string): string {
  for (const [re, v] of VENDOR_ALIASES) if (re.test(name.trim())) return v;
  return name;
}
export const cookieVendor = (c: CookieRecord) => canonicalVendor(c.classification.platform ?? c.domain);
/**
 * Fornitore di una richiesta: quello del dominio, oppure il contenuto incorporato da cui parte se è dello stesso
 * fornitore (es. il log di Google inviato dal widget di Google Calendar → "Google Calendar (contenuti incorporati)").
 */
export const requestVendor = (r: Req) =>
  canonicalVendor(r.embed && r.embed !== r.tracker!.company && canonicalVendor(r.embed).startsWith(canonicalVendor(r.tracker!.company)) ? r.embed : r.tracker!.company);

/** Riga dei dettagli: da quale contenuto incorporato partono le richieste (documento dell'iframe). */
export function embedLine(rs: Req[]): string | null {
  const docs = [...new Set(rs.map((r) => r.frameUrl).filter((x): x is string => !!x).map((u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname;
    } catch {
      return u;
    }
  }))];
  if (!docs.length) return null;
  const all = rs.every((r) => r.frameUrl);
  return `Inviate ${all ? 'da' : 'in parte da'} contenuti incorporati nella pagina (iframe): ${docs.slice(0, 3).join(', ')}${docs.length > 3 ? ` e altri ${docs.length - 3}` : ''}`;
}

/**
 * Composizione di un gruppo di richieste: raccolte di dati e script o risorse si contano a parte, così il totale
 * ("partono 8 richieste") e la forza della prova ("4 richieste di raccolta") non sembrano in contraddizione.
 */
export function requestBreakdown(rs: Req[]): string {
  const col = rs.filter((r) => requestEvidenceLevel([r]) === 'raccolta').length;
  const res = rs.length - col;
  if (!rs.length) return '';
  if (col && res) return ` (${col} di raccolta dati, ${res} di script o risorse)`;
  if (col) return col === 1 ? ' (di raccolta dati)' : ' (tutte di raccolta dati)';
  return res === 1 ? ' (script o risorsa, nessuna raccolta di dati)' : ' (solo script o risorse, nessuna raccolta di dati)';
}

/** Richieste di raccolta in un gruppo, per la forza della prova ("inoltre dati inviati"). */
export const collectedCount = (rs: Req[]) => rs.filter((r) => requestEvidenceLevel([r]) === 'raccolta').length;
