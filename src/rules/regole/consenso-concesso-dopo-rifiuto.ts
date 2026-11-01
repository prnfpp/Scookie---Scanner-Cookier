import { choiceHow, describeGoogleConsent, groupBy, hostsSummary, nReq, requestExcerpt, sessionEvidence } from '../helpers.js';
import type { RequestRecord } from '../../types.js';
import type { RawFinding, Rule } from '../types.js';

/** Lettere di gcd che indicano un consenso concesso (predefinito o dopo l'aggiornamento). */
const GRANTED = new Set(['t', 'r', 'n', 'v']);

/**
 * Il segnale di consenso Google dichiara ad_storage concesso? Da gcs (G11x) o, in mancanza, dalla prima lettera di
 * gcd (ad_storage). Restituisce la spiegazione, o null.
 */
export function adStorageGranted(r: RequestRecord): string | null {
  const p = r.consentParams;
  if (!p) return null;
  if (/^G11[01-]$/.test(p.gcs ?? '')) return `gcs=${p.gcs} (ad_storage concesso)`;
  if (!p.gcs) {
    const m = /^1\d?([a-z])/i.exec(p.gcd ?? '');
    if (m && GRANTED.has(m[1].toLowerCase())) return `gcd=${p.gcd} (ad_storage concesso secondo la prima lettera del codice)`;
  }
  return null;
}

/**
 * Dopo un rifiuto eseguito e verificato, richieste a Google che dichiarano il consenso pubblicitario come concesso.
 * È il caso in cui il fornitore riceve un'informazione opposta alla scelta dell'utente: va in evidenza, non in una riga
 * dentro un'altra scheda.
 */
export const consensoConcessoDopoRifiuto: Rule = {
  id: 'consenso-concesso-dopo-rifiuto',
  title: 'Consenso dichiarato come concesso dopo il rifiuto',
  defaultSeverity: 'alta',
  defaultNorms: ['art122', 'eprivacy53', 'garante2021', 'gdpr4_11', 'gdpr7'],
  evaluate({ sessions }) {
    const items = sessions
      .filter((s) => s.scenario === 'rifiuta' && s.interaction.outcome === 'eseguito')
      .flatMap((s) => s.requests.filter((r) => r.phase === 'dopo').map((r) => ({ s, r, why: adStorageGranted(r) })))
      .filter((x) => x.why);
    const out: RawFinding[] = [];
    for (const [, group] of groupBy(items, (i) => i.s.site)) {
      const { s, r } = group[0];
      const reqs = group.map((g) => g.r);
      const sessionsIds = [...new Set(group.map((g) => `${g.s.id}${g.s.manual ? ' (navigazione manuale)' : g.s.replay ? ' (percorso registrato)' : ''}`))];
      const later = group.filter((g) => (g.r.msFromChoice ?? 0) > 2000);
      const sample = (later.length ? later : group).find((g) => g.r.method === 'POST') ?? (later.length ? later : group)[0];
      const verified = group.every((g) => g.s.interaction.verification === 'verificato');
      out.push({
        site: s.site,
        scenario: 'rifiuta',
        pageUrl: sample.r.pageUrl,
        description:
          `Dopo il rifiuto (eseguito ${choiceHow(s.interaction)}${verified ? ', con lo stato del consenso verificato come rifiutato' : ''}), ` +
          `${nReq(reqs.length)} a ${hostsSummary(reqs)} ${reqs.length === 1 ? 'dichiara' : 'dichiarano'} il consenso pubblicitario (ad_storage) come concesso. ` +
          'Il fornitore riceve quindi un segnale di consenso diverso dalla scelta fatta sul banner.',
        evidenceLevel: 'raccolta',
        subjects: ['Google'],
        groupKey: 'concesso',
        headline: 'Google riceve "consenso pubblicitario concesso" dopo il rifiuto',
        details: [
          `Sessioni: ${sessionsIds.join(', ')}`,
          `Segnali: ${[...new Set(group.map((g) => g.why))].join('; ')}`,
          ...[...new Set(reqs.map((x) => describeGoogleConsent(x.consentParams)).filter(Boolean))].slice(0, 3).map((d) => `Significato: ${d}`),
          `Pagine: ${[...new Set(reqs.map((x) => x.pageUrl))].slice(0, 6).join(', ')}`,
          `Prima richiesta ${reqs[0].msFromChoice ?? '?'} ms dopo la scelta; ${later.length} su ${reqs.length} oltre 2 secondi dopo la scelta.`,
        ],
        evidence: sessionEvidence(sample.s, ['2-dopo-scelta', '3-fine']),
        requestExcerpt: requestExcerpt(sample.r, sample.s),
      });
    }
    return out;
  },
};
