import type { Category, Evidence, RequestRecord, SessionResult } from '../types.js';

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
    metodo: r.method,
    url: r.url.length > 500 ? `${r.url.slice(0, 500)}…` : r.url,
    tipo: r.resourceType,
    stato: r.status,
    pagina: r.pageUrl,
    ...(r.consentParams ? { parametriConsenso: r.consentParams } : {}),
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
