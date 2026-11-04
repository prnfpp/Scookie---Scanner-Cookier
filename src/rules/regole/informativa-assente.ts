import { noBannerSites } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/**
 * Nessuna pagina di privacy o cookie policy raggiungibile e nessun banner: il sito non dà al visitatore alcuna
 * informativa su cookie e trattamenti. Le prove sono i percorsi provati con il loro stato HTTP e il piè di pagina.
 * Il caso "banner senza link all'informativa" è della regola link-informativa-assente.
 */
export const informativaAssente: Rule = {
  id: 'informativa-assente',
  title: 'Informativa privacy e cookie non trovata',
  defaultSeverity: 'media',
  defaultNorms: ['gdpr13', 'garante2021'],
  evaluate({ sessions, declared }) {
    const noBanner = noBannerSites(sessions);
    const out: RawFinding[] = [];
    for (const d of declared) {
      // solo con la ricerca fatta (rilevazioni dalla 0.1.2) e senza alcuna pagina raggiungibile
      if (!d.policy || d.policy.url !== null || !noBanner.has(d.site)) continue;
      const tried = d.policy.tried;
      const links = tried.filter((t) => /link/.test(t.how));
      const st = (t: (typeof tried)[number]) => (t.status === null ? (t.note ?? 'nessuna risposta') : `${t.status}${t.note ? `, ${t.note}` : ''}`);
      out.push({
        site: d.site,
        scenario: null,
        pageUrl: null,
        noBanner: true,
        headline: 'Nessuna informativa privacy o cookie raggiungibile e nessun banner',
        description:
          `Sul sito non è stata trovata una pagina di informativa privacy o cookie raggiungibile: ${links.length ? `i collegamenti trovati (${links.length}) non portano a una pagina valida` : 'nessun collegamento con "cookie", "privacy", "informativa" o "note legali" nella pagina iniziale, nel piè di pagina o nel menu'}, ` +
          `e i percorsi comuni provati non rispondono con una pagina (${tried.filter((t) => t.how === 'percorso comune').map((t) => `${new URL(t.url).pathname} ${st(t)}`).join(', ') || 'nessuno'}). ` +
          'Non c\'è nemmeno un banner o un gestore del consenso. Lo stato si legge dalla risposta reale: una pagina d\'errore con il piè di pagina del sito non vale come informativa.',
        details: [`Indirizzi provati (${tried.length}):`, ...tried.map((t) => `${t.url} — ${t.how}: ${st(t)}`)],
        evidence: [
          ...(d.policy.footerShot ? [{ label: 'piè di pagina della pagina iniziale', file: d.policy.footerShot }] : []),
          ...sessions.filter((s) => s.site === d.site).slice(0, 1).flatMap((s) => s.screenshots.filter((e) => e.label.includes('3-fine'))),
        ],
      });
    }
    return out;
  },
};
