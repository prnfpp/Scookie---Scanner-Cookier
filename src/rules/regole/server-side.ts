import { groupBy } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Endpoint di raccolta su domini propri: indicano probabile tagging lato server (destinatari finali non visibili). */
export const endpointServerSide: Rule = {
  id: 'endpoint-server-side',
  title: 'Endpoint di raccolta su dominio proprio (server-side tagging)',
  defaultSeverity: 'informativa',
  defaultNorms: ['gdpr13'],
  evaluate({ sessions }) {
    const items = sessions.flatMap((s) => s.requests.filter((r) => r.serverSide).map((r) => ({ s, r })));
    const out: RawFinding[] = [];
    for (const [site, group] of groupBy(items, (i) => i.s.site)) {
      const endpoints = [...new Map(group.map((g) => [`${g.r.host}${new URL(g.r.url).pathname}`, g])).values()];
      const prima = group.filter((g) => g.r.phase === 'prima').length;
      const dopoRifiuto = group.filter((g) => g.s.scenario === 'rifiuta' && g.r.phase === 'dopo').length;
      out.push({
        site,
        scenario: null,
        pageUrl: group[0].r.pageUrl,
        description:
          `Il sito invia dati a endpoint di raccolta ospitati su un dominio proprio (${endpoints.length} endpoint). ` +
          `Ciò che il server inoltra a terzi non è osservabile dal browser. Richieste prima della scelta: ${prima}; dopo il rifiuto: ${dopoRifiuto}.`,
        details: endpoints.map((g) => `${g.r.host}${new URL(g.r.url).pathname} — ${g.r.serverSide}`),
        evidence: [],
      });
    }
    return out;
  },
};
