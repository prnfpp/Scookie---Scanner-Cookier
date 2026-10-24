import { NON_TECHNICAL } from '../../types.js';
import { groupBy, sessionEvidence } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Nessun banner rilevato sulla home di un sito. */
export const bannerAssente: Rule = {
  id: 'banner-assente',
  title: 'Nessun banner di consenso rilevato',
  defaultSeverity: 'informativa',
  defaultNorms: ['garante2021', 'gdpr13'],
  evaluate({ sessions, exit }) {
    const out: RawFinding[] = [];
    // Fuori da UE/SEE, o senza verifica, l'assenza del banner può dipendere dalla geolocalizzazione del CMP.
    const geoCaveat = !exit.verified || exit.inEu === false;
    for (const [site, list] of groupBy(sessions, (s) => s.site)) {
      if (list.some((s) => s.interaction.bannerVisibleBefore || s.interaction.detectedCmps.length)) continue;
      const home = list.find((s) => s.scenario === 'nessuna-azione') ?? list[0];
      const nonTech =
        list.some((s) => s.cookies.some((c) => NON_TECHNICAL.has(c.classification.category))) ||
        list.some((s) => s.requests.some((r) => r.tracker && NON_TECHNICAL.has(r.tracker.category)));
      out.push({
        site,
        scenario: null,
        pageUrl: home.pages[0],
        severity: nonTech && !geoCaveat ? 'media' : 'informativa',
        headline: nonTech ? 'Nessun banner di consenso, pur in presenza di tracciamenti' : undefined,
        description: `In nessuna delle pagine visitate è stato rilevato un banner o un gestore del consenso.${nonTech ? ' Sono però presenti cookie o richieste di categoria non tecnica (vedi inventario).' : ''}`,
        details: [
          `Pagine visitate: ${[...new Set(list.flatMap((s) => s.pages))].length}`,
          ...(geoCaveat ? [`Attenzione: ${exit.note} Molti CMP mostrano il banner solo a visitatori da UE/SEE.`] : []),
        ],
        evidence: sessionEvidence(home, ['1-banner']),
      });
    }
    return out;
  },
};

/** Sottodomini dello stesso dominio con CMP diversi, banner presenti solo in parte, policy su altri domini. */
export const sottodominiDisomogenei: Rule = {
  id: 'sottodomini-disomogenei',
  title: 'Gestione del consenso disomogenea tra sottodomini',
  defaultSeverity: 'bassa',
  defaultNorms: ['garante2021', 'gdpr13'],
  evaluate({ sessions, config }) {
    const out: RawFinding[] = [];
    for (const [domain, list] of groupBy(sessions, (s) => s.registrableDomain)) {
      const bySite = groupBy(list, (s) => s.site);
      if (bySite.size < 2) continue;
      const profile = [...bySite].map(([site, ss]) => ({
        site,
        cmps: [...new Set(ss.flatMap((s) => s.interaction.detectedCmps).filter((c) => c !== 'IAB TCF v2'))].sort(),
        banner: ss.some((s) => s.interaction.bannerVisibleBefore),
      }));
      const signatures = new Set(profile.map((p) => `${p.banner}|${p.cmps.join(',')}`));
      if (signatures.size < 2) continue;
      out.push({
        site: domain,
        scenario: null,
        pageUrl: null,
        headline: `I siti del dominio ${domain} non gestiscono il consenso nello stesso modo`,
        description: `I siti del dominio ${domain} non gestiscono il consenso nello stesso modo.`,
        details: profile.map((p) => `${p.site}: banner ${p.banner ? 'visibile' : 'non rilevato'}; CMP: ${p.cmps.join(', ') || 'nessuno'}`),
        evidence: [],
      });
    }
    for (const site of config.siti) {
      if (!site.cookiePolicy) continue;
      const policyHost = new URL(site.cookiePolicy, site.url).hostname;
      const siteHost = new URL(site.url).hostname;
      if (policyHost !== siteHost) {
        out.push({
          site: new URL(site.url).origin,
          scenario: null,
          pageUrl: site.cookiePolicy,
          severity: 'informativa',
          description: `La cookie policy indicata per ${siteHost} è pubblicata su un altro host (${policyHost}).`,
          details: [`Cookie policy: ${site.cookiePolicy}`],
          evidence: [],
        });
      }
    }
    return out;
  },
};

/**
 * Banner comparso in alcune sessioni e non in altre dello stesso sito, anche dopo la ripetizione automatica.
 * Spesso dipende da script del CMP che non si caricano: per l'utente significa nessun banner in quella visita.
 */
export const bannerIntermittente: Rule = {
  id: 'banner-intermittente',
  title: 'Banner non sempre presente',
  defaultSeverity: 'bassa',
  defaultNorms: ['garante2021', 'gdpr13'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    for (const [site, list] of groupBy(sessions, (s) => s.site)) {
      const without = list.filter((s) => !s.interaction.bannerVisibleBefore);
      if (!without.length || without.length === list.length) continue;
      out.push({
        site,
        scenario: null,
        pageUrl: without[0].pages[0],
        description:
          `Il banner non è comparso in ${without.length} sessioni su ${list.length}` +
          `${without.some((s) => s.retryOf) ? ', anche dopo una ripetizione automatica' : ''}. Nelle altre sessioni lo stesso sito lo mostra.`,
        details: without.map((s) => {
          const failed = [...new Set(s.requests.filter((r) => r.failure).map((r) => `${r.host} (${r.failure})`))];
          return `${s.id} (${s.scenario}, ${s.pages[0]})${failed.length ? ` — richieste senza risposta: ${failed.slice(0, 5).join(', ')}` : ''}`;
        }),
        evidence: sessionEvidence(without[0], ['1-banner']),
      });
    }
    return out;
  },
};

/** Navigazione intercettata da un sistema anti-bot: le sessioni non sono valide e i dati non descrivono il sito. */
export const accessoBloccato: Rule = {
  id: 'accesso-bloccato',
  title: 'Accesso bloccato da un sistema anti-bot',
  defaultSeverity: 'informativa',
  defaultNorms: [],
  evaluate({ sessions, blocked }) {
    const out: RawFinding[] = [];
    for (const [site, list] of groupBy(blocked, (s) => s.site)) {
      const total = list.length + sessions.filter((s) => s.site === site).length;
      const providers = [...new Set(list.map((s) => s.blocked!.provider))];
      const all = list.length === total;
      out.push({
        site,
        scenario: null,
        pageUrl: list[0].blocked!.url,
        headline: `${list.length === total ? 'Sito non analizzabile' : `${list.length} sessioni su ${total} non valide`}: accesso bloccato da ${providers.join(', ')}`,
        description:
          `${list.length} sessioni su ${total} sono state intercettate da ${providers.join(', ')} con una pagina di verifica anti-bot. ` +
          (all
            ? 'Il sito non è stato analizzabile: nessuna criticità è stata ricavata da queste sessioni.'
            : 'Queste sessioni sono escluse dalle regole: le criticità del sito derivano solo dalle sessioni valide.') +
          ' Il tool non tenta di aggirare questi sistemi; si può ripetere l\'audit con il browser visibile o in un altro momento.',
        details: list.map((s) => `${s.id} (${s.scenario}) — ${s.blocked!.signal} su ${s.blocked!.url}`),
        evidence: sessionEvidence(list[0], ['1-banner']),
      });
    }
    return out;
  },
};
