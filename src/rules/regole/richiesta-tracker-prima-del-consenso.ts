import { NON_TECHNICAL } from '../../types.js';
import { CATEGORY_LABEL, groupBy, hostsSummary, isConsentModeDeniedPing, requestExcerpt, sessionEvidence, stageWhen } from '../helpers.js';
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
      const { when, onlyAfterScroll } = stageWhen(reqs.map((x) => x.stage));
      const firstAtLoad = reqs.find((x) => x.stage === 'caricamento') ?? r;
      out.push({
        site: s.site,
        scenario: s.scenario,
        pageUrl: r.pageUrl,
        description:
          `${when[0].toUpperCase()}${when.slice(1)}, il browser invia ${reqs.length} richieste a ${r.tracker!.company} ` +
          `(${CATEGORY_LABEL[r.tracker!.category]}): ${hostsSummary(reqs)}.`,
        details: [
          `Prima richiesta: ${firstAtLoad.method} ${firstAtLoad.url.slice(0, 200)}`,
          `Al caricamento: ${reqs.filter((x) => x.stage === 'caricamento').length}; solo dopo lo scroll: ${reqs.filter((x) => x.stage === 'scroll').length}`,
          `Pagine: ${pages.slice(0, 10).join(', ')}`,
          `Scenari: ${[...new Set(group.map((g) => g.s.scenario))].join(', ')}`,
          ...(r.consentParams ? [`Parametri di consenso: ${JSON.stringify(r.consentParams)}`] : []),
        ],
        evidence: sessionEvidence(s, onlyAfterScroll ? ['1-banner', '3-fine'] : ['1-banner']),
        requestExcerpt: requestExcerpt(firstAtLoad, s),
      });
    }
    return out;
  },
};
