import { CATEGORY_LABEL, groupBy, nReq, requestExcerpt, sessionEvidence } from '../helpers.js';
import type { PiiHit } from '../../util/pii.js';
import { registrableDomain } from '../../util/domains.js';
import type { RawFinding, Rule } from '../types.js';

/** Caselle PEC: indirizzi pubblicati dalle aziende, non dati dell'utente. */
const PEC = /(^|\.)(pec|legalmail|arubapec|postecert|postacert|cert)\.|\.pec\.it$/i;

/**
 * Indirizzi email pubblicati dal sito stesso (es. assistenza@dominio-del-sito, caselle PEC): alcuni pixel, come
 * quello di TikTok, leggono le email presenti nella pagina. Non sono dati dell'utente e non si contano.
 */
function userPii(pii: PiiHit[], site: string): PiiHit[] {
  const own = registrableDomain(new URL(site).hostname);
  return pii.filter((p) => {
    if (p.kind !== 'email') return true;
    const dom = (p.masked.split('@')[1] ?? '').toLowerCase();
    return !(dom === own || dom.endsWith(`.${own}`) || PEC.test(dom));
  });
}

/**
 * Dati personali (targa, data di nascita, email, codice fiscale, telefono) inviati a terze parti nell'indirizzo
 * o nel corpo delle richieste, per esempio come parametri dell'indirizzo della pagina visitata.
 * I valori sono riportati solo mascherati.
 */
export const datiPersonaliATerzi: Rule = {
  id: 'dati-personali-a-terzi',
  title: 'Dati personali inviati a terze parti',
  defaultSeverity: 'alta',
  defaultNorms: ['gdpr5', 'gdpr6', 'garante2021'],
  evaluate({ sessions }) {
    const items = sessions.flatMap((s) =>
      s.requests
        .filter((r) => r.party === 'terza' && r.pii?.length)
        .map((r) => ({ s, r: { ...r, pii: userPii(r.pii!, s.site) } }))
        .filter(({ r }) => r.pii.length),
    );
    const out: RawFinding[] = [];
    for (const [, group] of groupBy(items, (i) => `${i.s.site}|${i.r.tracker?.company ?? i.r.host}`)) {
      const { s, r } = group[0];
      const who = r.tracker ? `${r.tracker.company} (${CATEGORY_LABEL[r.tracker.category]})` : r.host;
      const kinds = [...new Set(group.flatMap((g) => g.r.pii!.map((p) => p.kind)))];
      const hits = [...new Map(group.flatMap((g) => g.r.pii!.map((p) => [`${p.kind}|${p.param}|${p.masked}`, p]))).values()];
      const pages = [...new Set(group.map((g) => g.r.pageUrl))];
      const scen = [...new Set(group.map((g) => g.s.scenario))];
      out.push({
        site: s.site,
        scenario: s.scenario,
        pageUrl: r.pageUrl,
        groupKey: `${r.tracker?.company ?? r.host}|${kinds.sort().join(',')}`,
        evidenceLevel: 'raccolta',
        headline: `${r.tracker?.company ?? r.host} riceve dati personali (${kinds.join(', ')}) nelle richieste`,
        description:
          `${nReq(group.length)} a ${who} contengono dati personali (${kinds.join(', ')}), nell'indirizzo o nel corpo della richiesta, ` +
          `per esempio come parametri dell'indirizzo della pagina visitata. I valori sono riportati mascherati; quelli completi sono nei file HAR.`,
        details: [
          ...hits.slice(0, 10).map((h) => `${h.kind}: ${h.masked}${h.param ? ` (parametro "${h.param}")` : ''}`),
          `Pagine: ${pages.slice(0, 8).join(', ')}`,
          `Scenari: ${scen.join(', ')}`,
          'Se i valori sono dati di prova inseriti durante l\'audit, il fatto osservato è il percorso dei dati verso il fornitore, non l\'identità di una persona.',
        ],
        evidence: sessionEvidence(s, ['3-fine']),
        requestExcerpt: requestExcerpt(r, s),
      });
    }
    return out;
  },
};
