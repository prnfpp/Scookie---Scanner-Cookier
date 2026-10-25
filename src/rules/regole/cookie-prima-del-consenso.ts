import { NON_TECHNICAL } from '../../types.js';
import { CATEGORY_LABEL, fmtDate, groupBy, sessionEvidence, stageLabel, stageWhen } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Cookie o storage non tecnici scritti prima di qualsiasi scelta sul banner. */
export const cookiePrimaDelConsenso: Rule = {
  id: 'cookie-prima-del-consenso',
  title: 'Cookie o storage non tecnici prima della scelta',
  defaultSeverity: 'alta',
  defaultNorms: ['art122', 'eprivacy53', 'garante2021', 'edpb2_2023'],
  evaluate({ sessions, comparison }) {
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
          stage: c.stage,
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
          stage: st.stage,
          extra: `${st.party} parte`,
        })),
    ]);
    // Come il sito lo dichiara (es. "Cookie tecnici e analitici", sempre attivo): contesto utile per la valutazione.
    const declRow = (site: string, name: string) => comparison.find((c) => c.site === site && c.name === name && c.status === 'dichiarato');
    const declaredAs = (site: string, name: string) => {
      const r = declRow(site, name);
      return r?.declaredCategories.length ? `dichiarato dal sito come "${r.declaredCategories.join('", "')}"${r.declaredAlwaysActive ? ' (sempre attivo)' : ''}` : null;
    };
    const out: RawFinding[] = [];
    for (const [, group] of groupBy(items, (i) => `${i.s.site}|${i.cls.platform ?? i.where}`)) {
      const first = group[0];
      const names = [...new Set(group.map((g) => g.what))];
      const pages = [...new Set(group.map((g) => g.url))];
      const scen = [...new Set(group.map((g) => g.s.scenario))];
      const { when, onlyAfterScroll } = stageWhen(group.map((g) => g.stage));
      // Per la sintesi: cookie nascosti o classificati dal sito come tecnici sono due valutazioni diverse
      const rows = [...new Set(group.map((g) => g.name))].map((n) => declRow(first.s.site, n));
      const hasDeclared = comparison.some((c) => c.site === first.s.site);
      const declNote = !hasDeclared
        ? ''
        : rows.every((r) => r?.declaredAlwaysActive)
          ? ` (dichiarat${names.length === 1 ? 'o' : 'i'} dal sito come "${[...new Set(rows.flatMap((r) => r!.declaredCategories))].join('", "')}", sempre attiv${names.length === 1 ? 'o' : 'i'})`
          : rows.every((r) => !r)
            ? ` (non dichiarat${names.length === 1 ? 'o' : 'i'} dal sito)`
            : '';
      out.push({
        site: first.s.site,
        scenario: first.s.scenario,
        pageUrl: first.url,
        description:
          `${names.length === 1 ? (names[0].startsWith('chiave') ? `La ${names[0]} viene scritta` : `Il ${names[0]} viene scritto`) : `${names.length} elementi (${names.join(', ')}) vengono scritti`} ` +
          `${when}. Categoria: ${CATEGORY_LABEL[first.cls.category]}` +
          `${first.cls.platform ? ` (${first.cls.platform})` : ''}, secondo ${first.cls.source}.`,
        details: [
          ...[...new Map(group.map((g) => [g.what, g])).values()].map((g) => {
            const decl = declaredAs(g.s.site, g.name);
            return `${g.what} — dominio/origine ${g.where}; ${g.extra}; ${stageLabel(g.stage)}${decl ? `; ${decl}` : ''}${g.cls.note ? ` — nota: ${g.cls.note}` : ''}`;
          }),
          `Pagine: ${pages.join(', ')}`,
          `Osservato negli scenari: ${scen.join(', ')} (fase precedente alla scelta)`,
        ],
        evidenceLevel: 'identificativo',
        groupKey: `${first.cls.platform ?? first.where}|${first.cls.category}`,
        headline: `${first.cls.platform ?? `Un fornitore (${first.where})`} scrive ${names.length === 1 ? 'un identificativo' : 'identificativi'} nel browser ${onlyAfterScroll ? 'dopo lo scroll, ' : ''}prima di qualsiasi scelta sul banner${declNote}`,
        evidence: sessionEvidence(first.s, onlyAfterScroll ? ['1-banner', '3-fine'] : ['1-banner']),
      });
    }
    return out;
  },
};
