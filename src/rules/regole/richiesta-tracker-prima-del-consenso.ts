import { NON_TECHNICAL } from '../../types.js';
import { CATEGORY_LABEL, groupBy, hostsSummary, isConsentModeDeniedPing, requestExcerpt, sessionEvidence } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Richieste verso tracker (pubblicità, statistica, registrazione sessioni, social) prima della scelta. */
export const richiestaTrackerPrimaDelConsenso: Rule = {
  id: 'richiesta-tracker-prima-del-consenso',
  title: 'Richieste a terze parti di tracciamento prima della scelta',
  defaultSeverity: 'alta',
  defaultNorms: ['art122', 'eprivacy53', 'garante2021', 'edpb2_2023'],
  evaluate({ sessions }) {
    const items = sessions.flatMap((s) =>
      s.requests
        .filter((r) => r.phase === 'prima' && r.tracker && NON_TECHNICAL.has(r.tracker.category) && !isConsentModeDeniedPing(r))
        .map((r) => ({ s, r })),
    );
    const out: RawFinding[] = [];
    for (const [, group] of groupBy(items, (i) => `${i.s.site}|${i.r.tracker!.company}|${i.r.tracker!.category}`)) {
      const { s, r } = group[0];
      const reqs = group.map((g) => g.r);
      const pages = [...new Set(reqs.map((x) => x.pageUrl))];
      out.push({
        site: s.site,
        scenario: s.scenario,
        pageUrl: r.pageUrl,
        description:
          `Con il banner ancora senza risposta, il browser invia ${reqs.length} richieste a ${r.tracker!.company} ` +
          `(${CATEGORY_LABEL[r.tracker!.category]}): ${hostsSummary(reqs)}.`,
        details: [
          `Prima richiesta: ${r.method} ${r.url.slice(0, 200)}`,
          `Pagine: ${pages.slice(0, 10).join(', ')}`,
          `Scenari: ${[...new Set(group.map((g) => g.s.scenario))].join(', ')}`,
          ...(r.consentParams ? [`Parametri di consenso: ${JSON.stringify(r.consentParams)}`] : []),
        ],
        evidence: sessionEvidence(s, ['1-banner']),
        requestExcerpt: requestExcerpt(r, s),
      });
    }
    return out;
  },
};
