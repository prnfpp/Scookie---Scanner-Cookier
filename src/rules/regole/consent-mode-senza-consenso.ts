import { choiceHow, describeGoogleConsent, nReq, groupBy, hostsSummary, isConsentModeDeniedPing, requestExcerpt, sessionEvidence, stageWhen } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/**
 * Ping Google in Consent Mode con consenso negato o non impostato (gcs=G100, G1--…), prima della scelta
 * o dopo il rifiuto. Separati dalle altre richieste perché la loro valutazione giuridica è discussa:
 * il report si limita a documentarli.
 */
export const consentModeSenzaConsenso: Rule = {
  id: 'consent-mode-senza-consenso',
  title: 'Ping Google Consent Mode senza consenso',
  defaultSeverity: 'media',
  defaultNorms: ['art122', 'eprivacy53', 'edpb2_2023'],
  evaluate({ sessions }) {
    const items = sessions.flatMap((s) =>
      s.requests
        .filter((r) => isConsentModeDeniedPing(r) && (r.phase === 'prima' || s.scenario === 'rifiuta'))
        .map((r) => ({ s, r })),
    );
    const out: RawFinding[] = [];
    for (const [, group] of groupBy(items, (i) => `${i.s.site}|${i.r.phase}`)) {
      const { s, r } = group[0];
      const reqs = group.map((g) => g.r);
      const gcs = [...new Set(reqs.map((x) => x.consentParams!.gcs))];
      const when = r.phase === 'prima' ? stageWhen(reqs.map((x) => x.stage)).when : `dopo il rifiuto (eseguito ${choiceHow(s.interaction)})`;
      out.push({
        site: s.site,
        scenario: s.scenario,
        pageUrl: r.pageUrl,
        description:
          `${when[0].toUpperCase()}${when.slice(1)}, il browser invia ${nReq(reqs.length)} con parametro Google Consent Mode ` +
          `gcs=${gcs.join('/')} (consenso negato o non impostato) a ${hostsSummary(reqs)}. ` +
          `Le richieste partono comunque e trasmettono dati della navigazione.`,
        evidenceLevel: 'raccolta',
        groupKey: r.phase,
        headline: `Google riceve segnali di Consent Mode con consenso negato o non impostato ${r.phase === 'prima' ? 'prima della scelta' : 'dopo il rifiuto'}`,
        details: [`Esempio: ${r.url.slice(0, 250)}`, ...[...new Set(reqs.map((x) => describeGoogleConsent(x.consentParams)).filter(Boolean))].map((d) => `Significato: ${d}`), `Scenari: ${[...new Set(group.map((g) => g.s.scenario))].join(', ')}`],
        evidence: sessionEvidence(s, r.phase === 'prima' ? ['1-banner'] : ['2-dopo-scelta', '3-fine']),
        requestExcerpt: requestExcerpt(r, s),
      });
    }
    return out;
  },
};
