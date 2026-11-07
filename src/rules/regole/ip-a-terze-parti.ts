import { groupBy, nReq, perSession, sessionEvidence } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';
import type { RequestRecord } from '../../types.js';

/**
 * Servizi di terza parte che la pagina carica direttamente (non un contenuto incorporato) e che ricevono l'indirizzo IP
 * del visitatore e la pagina visitata a ogni caricamento, senza cookie: caratteri tipografici di Google Fonts, avatar
 * di Gravatar. Non è un tema di consenso ai cookie (art. 122) ma di trattamento di dati personali verso un terzo:
 * contesto per l'informativa e per la valutazione del legale, non una violazione accertata.
 */
const SERVICES: { re: RegExp; name: string; what: string }[] = [
  { re: /^fonts\.(googleapis|gstatic)\.com$/, name: 'Google Fonts', what: 'caratteri tipografici scaricati dai server di Google' },
  { re: /(^|\.)gravatar\.com$/, name: 'Gravatar (Automattic)', what: "avatar scaricati dai server di Automattic (l'indirizzo contiene l'hash dell'email dell'autore o del commentatore)" },
];

const serviceOf = (r: RequestRecord) => SERVICES.find((x) => x.re.test(r.host));

export const ipATerzeParti: Rule = {
  id: 'ip-a-terze-parti',
  title: "Risorse di terze parti che ricevono l'indirizzo IP del visitatore",
  defaultSeverity: 'informativa',
  defaultNorms: ['gdpr6', 'gdpr13'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    for (const [site, list] of groupBy(sessions, (s) => s.site)) {
      // solo le risorse richieste dalle pagine del sito: quelle di un contenuto incorporato appartengono a quel contenuto
      const reqs = list.flatMap((s) => s.requests.filter((r) => r.party === 'terza' && !r.frameUrl && serviceOf(r)));
      if (!reqs.length) continue;
      const by = groupBy(reqs, (r) => serviceOf(r)!.name);
      const home = list.find((s) => s.scenario === 'nessuna-azione') ?? list[0];
      out.push({
        site,
        scenario: null,
        pageUrl: home.pages[0] ?? null,
        description:
          `Le pagine del sito caricano direttamente risorse da ${[...by.keys()].join(' e ')}: a ogni caricamento il browser invia al fornitore l'indirizzo IP del visitatore e la pagina di provenienza, a prescindere da qualsiasi scelta. ` +
          'Non sono cookie né raccolte di statistica; il fatto è riportato come contesto, per l\'informativa e la valutazione del trattamento.',
        details: [...by].map(([name, rs]) => {
          const svc = SERVICES.find((x) => x.name === name)!;
          return `${name}: ${svc.what} — ${nReq(rs.length)}${perSession(rs, list)} a ${[...new Set(rs.map((r) => r.host))].join(', ')}; pagine: ${[...new Set(rs.map((r) => r.pageUrl))].slice(0, 5).join(', ')}`;
        }),
        evidenceLevel: 'risorsa',
        subjects: [...by.keys()],
        evidence: sessionEvidence(home, ['1-banner']),
      });
    }
    return out;
  },
};
