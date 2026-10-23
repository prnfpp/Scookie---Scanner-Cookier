import { sessionEvidence } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Rifiuto non disponibile al primo livello o non trovato. */
export const rifiutoNonAlPrimoLivello: Rule = {
  id: 'rifiuto-non-al-primo-livello',
  title: 'Rifiuto non disponibile al primo livello del banner',
  defaultSeverity: 'media',
  defaultNorms: ['garante2021', 'gdpr4_11', 'gdpr7'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    for (const s of sessions.filter((x) => x.scenario === 'rifiuta')) {
      const i = s.interaction;
      let description: string | null = null;
      if (i.outcome === 'eseguito' && i.layer === 'secondo-livello') {
        description = `Il banner non offre un comando di rifiuto al primo livello: il rifiuto è stato possibile solo aprendo le preferenze (${i.detail}).`;
      } else if (i.outcome === 'eseguito' && i.via === 'api') {
        description = `Nessun pulsante di rifiuto trovato nel banner; la scelta è stata registrata solo tramite l'API del CMP (${i.detail}).`;
      } else if (i.outcome === 'non-trovato') {
        description = `Banner visibile ma pulsante di rifiuto non trovato con nessun metodo (${i.detail}).`;
      }
      if (!description) continue;
      out.push({
        site: s.site,
        scenario: s.scenario,
        pageUrl: s.pages[0],
        description,
        details: [`CMP rilevati: ${i.detectedCmps.join(', ') || 'nessuno'}`, `Metodo: ${i.method}`],
        evidence: sessionEvidence(s, ['1-banner', '2-dopo-scelta']),
      });
    }
    return out;
  },
};

/**
 * Stato del consenso dopo la scelta non coerente con la scelta, o accettazione impossibile.
 * Le scelte non verificabili (stato non leggibile) restano nella tabella dell'interazione, senza scheda.
 */
export const sceltaNonVerificata: Rule = {
  id: 'scelta-non-verificata',
  title: 'Stato del consenso non coerente con la scelta',
  defaultSeverity: 'media',
  defaultNorms: ['gdpr4_11', 'gdpr7'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    for (const s of sessions.filter((x) => x.scenario !== 'nessuna-azione')) {
      const i = s.interaction;
      const label = s.scenario === 'rifiuta' ? 'Rifiuta' : 'Accetta';
      if (i.outcome === 'eseguito' && i.verification === 'incoerente') {
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: s.pages[0],
          description: `Dopo "${label}" lo stato del consenso registrato dal CMP non corrisponde alla scelta: ${i.verificationDetail}.`,
          details: [`Interazione: ${i.detail}`, `Stato dopo la scelta: ${JSON.stringify(i.consentStateAfter).slice(0, 600)}`],
          evidence: sessionEvidence(s, ['2-dopo-scelta']),
        });
      } else if (s.scenario === 'accetta' && i.outcome === 'non-trovato') {
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: s.pages[0],
          severity: 'informativa',
          description: `Pulsante di accettazione non trovato: ${i.detail}. I dati dello scenario "accetta" non riflettono un consenso dato.`,
          details: [],
          evidence: sessionEvidence(s, ['1-banner']),
        });
      }
    }
    return out;
  },
};
