import { NON_TECHNICAL } from '../../types.js';
import { CATEGORY_LABEL, fmtDate, groupBy, sessionEvidence } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Cookie o storage non tecnici scritti prima di qualsiasi scelta sul banner. */
export const cookiePrimaDelConsenso: Rule = {
  id: 'cookie-prima-del-consenso',
  title: 'Cookie o storage non tecnici prima della scelta',
  defaultSeverity: 'alta',
  defaultNorms: ['art122', 'eprivacy53', 'garante2021', 'edpb2_2023'],
  evaluate({ sessions }) {
    const items = sessions.flatMap((s) => [
      ...s.cookies
        .filter((c) => c.phase === 'prima' && NON_TECHNICAL.has(c.classification.category))
        .map((c) => ({
          s,
          what: `cookie "${c.name}"`,
          name: c.name,
          where: c.domain,
          cls: c.classification,
          url: c.firstSeenUrl,
          extra: `scadenza ${fmtDate(c.expires)}, ${c.party} parte${c.httpOnly ? ', HttpOnly' : ''}`,
        })),
      ...s.storage
        .filter((st) => st.phase === 'prima' && NON_TECHNICAL.has(st.classification.category))
        .map((st) => ({
          s,
          what: `chiave ${st.kind} "${st.key}"`,
          name: st.key,
          where: st.origin,
          cls: st.classification,
          url: st.firstSeenUrl,
          extra: `${st.party} parte`,
        })),
    ]);
    const out: RawFinding[] = [];
    for (const [, group] of groupBy(items, (i) => `${i.s.site}|${i.cls.platform ?? i.where}`)) {
      const first = group[0];
      const names = [...new Set(group.map((g) => g.what))];
      const pages = [...new Set(group.map((g) => g.url))];
      const scen = [...new Set(group.map((g) => g.s.scenario))];
      out.push({
        site: first.s.site,
        scenario: first.s.scenario,
        pageUrl: first.url,
        description:
          `${names.length === 1 ? `Il ${names[0]} viene scritto` : `${names.length} elementi (${names.join(', ')}) vengono scritti`} ` +
          `prima di qualsiasi scelta sul banner. Categoria: ${CATEGORY_LABEL[first.cls.category]}` +
          `${first.cls.platform ? ` (${first.cls.platform})` : ''}, secondo ${first.cls.source}.`,
        details: [
          ...[...new Map(group.map((g) => [g.what, g])).values()].map((g) => `${g.what} — dominio/origine ${g.where}; ${g.extra}`),
          `Pagine: ${pages.join(', ')}`,
          `Osservato negli scenari: ${scen.join(', ')} (fase precedente alla scelta)`,
        ],
        evidence: sessionEvidence(first.s, ['1-banner']),
      });
    }
    return out;
  },
};
