import { NON_TECHNICAL, type SessionResult } from '../../types.js';
import { cookieActivity, groupBy, sessionEvidence } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Fornitori non tecnici attivi dopo la scelta (cookie o richieste) in un gruppo di sessioni. */
function activeAfter(list: SessionResult[]): Set<string> {
  const out = new Set<string>();
  for (const s of list) {
    for (const c of s.cookies) if (cookieActivity(c, 'scelta')) out.add(c.classification.platform ?? c.domain);
    for (const r of s.requests) if (r.phase === 'dopo' && r.tracker && NON_TECHNICAL.has(r.tracker.category)) out.add(r.tracker.company);
  }
  return out;
}

const listIt = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);

/**
 * Chiusura del banner con la X: cosa registra il gestore, se il banner ricompare alla pagina successiva e se dopo la
 * chiusura il sito si comporta come dopo il rifiuto o come dopo l'accettazione.
 */
export const esitoChiusuraX: Rule = {
  id: 'esito-chiusura-x',
  title: 'Chiusura del banner con la X',
  defaultSeverity: 'informativa',
  defaultNorms: ['garante2021'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    for (const [site, list] of groupBy(sessions.filter((s) => s.scenario === 'chiudi' && !s.manual && !s.attributedFrom), (s) => s.site)) {
      const done = list.filter((s) => s.interaction.outcome === 'eseguito');
      if (!done.length) continue;
      const s = done[0];
      const effects = [...new Set(done.map((x) => x.interaction.closeEffect ?? 'non-verificabile'))];
      const again = done.filter((x) => x.interaction.bannerOnNextPage).length;
      const siteSessions = sessions.filter((x) => x.site === site && !x.manual && !x.attributedFrom);
      const afterX = activeAfter(done);
      const afterReject = activeAfter(siteSessions.filter((x) => x.scenario === 'rifiuta' && x.interaction.outcome === 'eseguito'));
      const afterAccept = activeAfter(siteSessions.filter((x) => x.scenario === 'accetta' && x.interaction.outcome === 'eseguito'));
      const beyondReject = [...afterX].filter((x) => !afterReject.has(x));
      const missingFromAccept = [...afterAccept].filter((x) => !afterX.has(x));
      const effectText: Record<string, string> = {
        rifiuto: 'il gestore del consenso registra un rifiuto',
        consenso: 'il gestore del consenso registra un consenso',
        'nessuna-scelta': 'il gestore del consenso non registra alcuna scelta',
        'non-verificabile': 'lo stato del consenso registrato non è leggibile',
      };
      const like =
        effects.includes('consenso') || (afterAccept.size && !missingFromAccept.length && beyondReject.length)
          ? "come dopo l'accettazione"
          : !beyondReject.length
            ? 'come dopo il rifiuto'
            : 'in modo intermedio: alcuni strumenti attivi dopo la X non lo sono dopo il rifiuto';
      out.push({
        site,
        scenario: 'chiudi',
        pageUrl: s.pages[0] ?? null,
        severity: effects.includes('consenso') || beyondReject.length ? 'media' : undefined,
        evidenceLevel: undefined,
        groupKey: `${effects.join(',')}|${like}|${again ? 'ricompare' : 'no'}`,
        headline: `Chiudendo il banner con la X ${effects.length === 1 ? effectText[effects[0]] : 'lo stato registrato varia'}; il sito si comporta ${like}`,
        description:
          `Chiudendo il banner con la X (${s.interaction.clicked?.[0] ?? s.interaction.detail}) ${effects.map((e) => effectText[e]).join(' oppure ')}. ` +
          `${again ? `Alla pagina successiva il banner ricompare (${again} su ${done.length} sessioni): la chiusura non viene ricordata come una scelta.` : 'Alla pagina successiva il banner non ricompare.'} ` +
          `Dopo la chiusura il sito si comporta ${like}.`,
        details: [
          `Strumenti non tecnici attivi dopo la X: ${afterX.size ? listIt([...afterX]) : 'nessuno'}`,
          `Attivi dopo la X ma non dopo il rifiuto: ${beyondReject.length ? listIt(beyondReject) : 'nessuno'}`,
          ...(afterAccept.size ? [`Attivi dopo l'accettazione ma non dopo la X: ${missingFromAccept.length ? listIt(missingFromAccept) : 'nessuno'}`] : []),
          `Verifica dello stato: ${s.interaction.verificationDetail}`,
          `Sessioni: ${done.map((x) => x.id).join(', ')}`,
        ],
        evidence: sessionEvidence(s, ['1-banner', '2-dopo-scelta', '3-fine']),
      });
    }
    return out;
  },
};
