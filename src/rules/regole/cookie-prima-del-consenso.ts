import { NON_TECHNICAL } from '../../types.js';
import { CATEGORY_LABEL, fmtDate, groupBy, hostsSummary, nReq, requestEvidenceLevel, requestExcerpt, sessionEvidence, stageLabel, stageWhen, strongestRequest, requestVendor, noBannerSites, beforeChoice, scenariosLine } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Cookie o storage non tecnici scritti prima di qualsiasi scelta sul banner. */
export const cookiePrimaDelConsenso: Rule = {
  id: 'cookie-prima-del-consenso',
  title: 'Cookie o storage non tecnici prima della scelta',
  defaultSeverity: 'alta',
  defaultNorms: ['art122', 'eprivacy53', 'garante2021', 'edpb2_2023'],
  evaluate({ sessions, comparison }) {
    const noBanner = noBannerSites(sessions);
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
      const nb = noBanner.has(first.s.site);
      const { when, onlyAfterScroll } = stageWhen(group.map((g) => g.stage), nb);
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
      // Dati inviati allo stesso fornitore prima della scelta (es. hit di Matomo ospitato sul sito): la prova comprende
      // anche la raccolta, non solo l'identificativo memorizzato
      const vendor = first.cls.platform;
      const sent = vendor
        ? sessions.filter((x) => x.site === first.s.site).flatMap((x) => x.requests.filter((r) => r.phase === 'prima' && !!r.tracker && requestVendor(r) === vendor && NON_TECHNICAL.has(r.tracker.category) && requestEvidenceLevel([r]) === 'raccolta'))
        : [];
      const sentSample = sent.length ? strongestRequest(sent) : null;
      out.push({
        site: first.s.site,
        scenario: first.s.scenario,
        pageUrl: first.url,
        ...(nb ? { title: 'Cookie o storage non tecnici in assenza di banner', noBanner: true } : {}),
        description:
          `${names.length === 1 ? (names[0].startsWith('chiave') ? `La ${names[0]} viene scritta` : `Il ${names[0]} viene scritto`) : `${names.length} elementi (${names.join(', ')}) vengono scritti`} ` +
          `${when}. Categoria: ${CATEGORY_LABEL[first.cls.category]}` +
          `${first.cls.platform ? ` (${first.cls.platform})` : ''}, secondo ${first.cls.source}.` +
          (sent.length ? ` ${nb ? 'Nelle stesse pagine' : 'Prima della scelta'} il browser invia anche dati di navigazione a ${vendor}: ${nReq(sent.length)} di raccolta a ${hostsSummary(sent)}${sent.every((r) => r.party === 'prima') ? ' (endpoint sul dominio del sito)' : ''}.` : ''),
        details: [
          ...[...new Map(group.map((g) => [g.what, g])).values()].map((g) => {
            const decl = declaredAs(g.s.site, g.name);
            return `${g.what} — dominio/origine ${g.where}; ${g.extra}; ${stageLabel(g.stage, nb)}${decl ? `; ${decl}` : ''}${g.cls.note ? ` — nota: ${g.cls.note}` : ''}`;
          }),
          `Pagine: ${pages.join(', ')}`,
          ...(sentSample ? [`Dati inviati ${nb ? 'in assenza di banner' : 'prima della scelta'}: ${nReq(sent.length)} di raccolta; richiesta di esempio: ${sentSample.method} ${sentSample.url.slice(0, 200)}`] : []),
          `${scenariosLine([...new Set(group.map((g) => g.s))], nb)}${nb ? '' : ' (fase precedente alla scelta)'}`,
        ],
        evidenceLevel: 'identificativo',
        ...(sent.length ? { evidenceExtra: `dati di navigazione inviati al fornitore (${nReq(sent.length)} di raccolta)` } : {}),
        ...(sentSample ? { requestExcerpt: requestExcerpt(sentSample, sessions.find((x) => x.requests.includes(sentSample))!) } : {}),
        subjects: [first.cls.platform ?? first.where],
        groupKey: `${first.cls.platform ?? first.where}|${first.cls.category}`,
        headline: `${first.cls.platform ?? `Un fornitore (${first.where})`} scrive ${names.length === 1 ? 'un identificativo' : 'identificativi'} nel browser ${onlyAfterScroll ? 'dopo lo scroll, ' : ''}${beforeChoice(nb)}${declNote}`,
        evidence: sessionEvidence(first.s, onlyAfterScroll ? ['1-banner', '3-fine'] : ['1-banner']),
      });
    }
    return out;
  },
};
