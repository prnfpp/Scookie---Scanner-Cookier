import { NON_TECHNICAL } from '../../types.js';
import { describeGoogleConsent, requestEvidenceLevel, nReq, CATEGORY_LABEL, groupBy, hostsSummary, isConsentModeDeniedPing, requestExcerpt, sessionEvidence, stageWhen } from '../helpers.js';
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
      // Come estratto si mostra la richiesta più significativa: una raccolta di dati, se c'è.
      const level = requestEvidenceLevel(reqs);
      const atLoad = reqs.filter((x) => x.stage === 'caricamento');
      const pool = atLoad.length ? atLoad : reqs;
      const firstAtLoad = (level === 'raccolta' ? pool.find((x) => requestEvidenceLevel([x]) === 'raccolta') : undefined) ?? pool[0] ?? r;
      const consent = describeGoogleConsent(firstAtLoad.consentParams);
      out.push({
        site: s.site,
        scenario: s.scenario,
        pageUrl: r.pageUrl,
        description:
          `${when[0].toUpperCase()}${when.slice(1)}, il browser invia ${nReq(reqs.length)} a ${r.tracker!.company} ` +
          `(${CATEGORY_LABEL[r.tracker!.category]}): ${hostsSummary(reqs)}.` +
          (level === 'risorsa' ? ' Le richieste scaricano risorse del fornitore: non è stato osservato un invio di dati di raccolta.' : ''),
        // Solo script o contenuti scaricati: prova più debole di una raccolta di dati
        severity: level === 'risorsa' ? 'media' : undefined,
        evidenceLevel: level,
        groupKey: `${r.tracker!.company}|${r.tracker!.category}`,
        headline:
          level === 'raccolta'
            ? `${r.tracker!.company} (${CATEGORY_LABEL[r.tracker!.category]}) riceve dati di navigazione prima di qualsiasi scelta sul banner`
            : `Il sito scarica risorse di ${r.tracker!.company} (${CATEGORY_LABEL[r.tracker!.category]}) prima di qualsiasi scelta sul banner`,
        details: [
          `Richiesta di esempio: ${firstAtLoad.method} ${firstAtLoad.url.slice(0, 200)}`,
          ...(consent ? [`Consenso Google dichiarato nella richiesta: ${consent}`] : []),
          `Al caricamento: ${reqs.filter((x) => x.stage === 'caricamento').length}; solo dopo lo scroll: ${reqs.filter((x) => x.stage === 'scroll').length}`,
          `Pagine: ${pages.slice(0, 10).join(', ')}`,
          `Scenari: ${[...new Set(group.map((g) => g.s.scenario))].join(', ')}`,
        ],
        evidence: sessionEvidence(s, onlyAfterScroll ? ['1-banner', '3-fine'] : ['1-banner']),
        requestExcerpt: requestExcerpt(firstAtLoad, s),
      });
    }
    return out;
  },
};
