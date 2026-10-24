import type { BannerAnalysis, SessionResult } from '../../types.js';
import { sessionEvidence } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

const analyses = (sessions: SessionResult[]) =>
  sessions.filter((s) => s.bannerAnalysis?.bannerVisible).map((s) => ({ s, a: s.bannerAnalysis as BannerAnalysis }));
const list = (xs: string[]) => (xs.length ? xs.map((x) => `"${x}"`).join(', ') : 'nessuno');

/** Struttura del banner al primo livello: quali comandi offre, link all'informativa, modo per rivedere la scelta. */
export const strutturaBanner: Rule = {
  id: 'struttura-banner',
  title: 'Struttura del banner',
  defaultSeverity: 'informativa',
  defaultNorms: ['garante2021'],
  evaluate({ sessions }) {
    return analyses(sessions).map(({ s, a }): RawFinding => {
      const f = a.firstLayer;
      return {
        site: s.site,
        scenario: s.scenario,
        pageUrl: s.pages[0],
        groupKey: [f.all.join('|'), !!a.policyLink, !!a.revokeLink].join('#'),
        description:
          `Al primo livello il banner${a.cmp.length ? ` (${a.cmp.join(', ')})` : ''} offre: accettazione ${list(f.accept)}; ` +
          `rifiuto ${list(f.reject)}; preferenze ${list(f.preferences)}; chiusura ${list(f.close)}. ` +
          `Link all'informativa nel banner: ${a.policyLink ? `"${a.policyLink.text}"` : 'non trovato'}. ` +
          `Modo per rivedere la scelta nella pagina: ${a.revokeLink ? `"${a.revokeLink.text}"` : 'non trovato'}.`,
        details: [
          `Tutti i comandi rilevati nel banner: ${list(f.all)}`,
          ...(a.policyLink ? [`Informativa: ${a.policyLink.href}`] : []),
          ...(a.preferences?.opened
            ? [`Secondo livello aperto con ${a.preferences.via}: ${a.preferences.toggles.map((t) => `${t.label} ${t.checked ? 'attiva' : 'non attiva'}${t.disabled ? ' (non modificabile)' : ''}`).join('; ') || 'nessuna categoria leggibile'}`]
            : []),
        ],
        evidence: sessionEvidence(s, ['1-banner', '4-preferenze']).filter((e) => !e.file.endsWith('.har')),
      };
    });
  },
};

/** Categorie non necessarie già attive nel secondo livello, prima di qualsiasi scelta. */
export const categoriePreattivate: Rule = {
  id: 'categorie-preattivate',
  title: 'Categorie già attive nelle preferenze',
  defaultSeverity: 'media',
  defaultNorms: ['garante2021', 'gdpr4_11', 'gdpr7'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    for (const { s, a } of analyses(sessions)) {
      // Attive e modificabili: quelle bloccate attive sono di norma i cookie necessari.
      const on = (a.preferences?.toggles ?? []).filter((t) => t.checked && !t.disabled);
      if (!on.length) continue;
      out.push({
        site: s.site,
        scenario: s.scenario,
        pageUrl: s.pages[0],
        groupKey: on.map((t) => t.label).join('|'),
        headline: `Nel secondo livello del banner ${on.length === 1 ? '1 categoria risulta' : `${on.length} categorie risultano`} già attive prima di qualsiasi scelta`,
        description: `Aprendo le preferenze (${a.preferences!.via}) prima di qualsiasi scelta, ${on.length === 1 ? 'la categoria' : 'le categorie'} ${on.map((t) => `"${t.label}"`).join(', ')} ${on.length === 1 ? 'risulta già attiva' : 'risultano già attive'} e modificabili.`,
        details: a.preferences!.toggles.map((t) => `${t.label}: ${t.checked ? 'attiva' : 'non attiva'}${t.disabled ? ' (non modificabile)' : ''}`),
        evidence: sessionEvidence(s, ['4-preferenze']).filter((e) => !e.file.endsWith('.har')),
      });
    }
    return out;
  },
};

/** Nessun modo trovato, nella pagina, per riaprire le preferenze e revocare il consenso. */
export const revocaNonTrovata: Rule = {
  id: 'revoca-non-trovata',
  title: 'Modo per revocare il consenso non trovato',
  defaultSeverity: 'bassa',
  defaultNorms: ['gdpr7', 'garante2021'],
  evaluate({ sessions }) {
    return analyses(sessions)
      .filter(({ a }) => !a.revokeLink)
      .map(({ s }): RawFinding => ({
        site: s.site,
        scenario: s.scenario,
        pageUrl: s.pages[0],
        groupKey: 'revoca',
        description:
          'Nella pagina non è stato trovato un link o pulsante per riaprire le preferenze dei cookie e modificare la scelta (ricerca per testo, es. "Preferenze cookie", e per gli elementi dei gestori noti). Il risultato va confermato a vista: il comando può avere un testo non riconosciuto o comparire solo dopo la scelta.',
        details: [],
        evidence: sessionEvidence(s, ['3-fine']).filter((e) => !e.file.endsWith('.har')),
      }));
  },
};

/** Banner senza link all'informativa estesa (cookie policy). */
export const linkInformativaAssente: Rule = {
  id: 'link-informativa-assente',
  title: 'Link all\'informativa assente nel banner',
  defaultSeverity: 'bassa',
  defaultNorms: ['gdpr13', 'garante2021'],
  evaluate({ sessions }) {
    return analyses(sessions)
      .filter(({ a }) => !a.policyLink)
      .map(({ s }): RawFinding => ({
        site: s.site,
        scenario: s.scenario,
        pageUrl: s.pages[0],
        groupKey: 'informativa',
        description: 'Nel banner non è stato trovato un link all\'informativa (testo con "cookie", "privacy", "informativa" o "policy").',
        details: [],
        evidence: sessionEvidence(s, ['1-banner']).filter((e) => !e.file.endsWith('.har')),
      }));
  },
};
