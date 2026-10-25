import type { BannerAnalysis, CommandLook, SessionResult } from '../../types.js';
import { sessionEvidence } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

const analyses = (sessions: SessionResult[]) =>
  sessions.filter((s) => s.bannerAnalysis?.bannerVisible).map((s) => ({ s, a: s.bannerAnalysis as BannerAnalysis }));
const list = (xs: string[]) => (xs.length ? xs.map((x) => `"${x}"`).join(', ') : 'nessuno');

const fmtNum = (n: number) => n.toLocaleString('it-IT', { maximumFractionDigits: 1 });
const lookText = (l: CommandLook) =>
  `${l.kind} di ${l.width}×${l.height} px, testo ${l.fontSize} px${l.fontWeight >= 600 ? ' in grassetto' : ''} (${l.color})` +
  `${l.background ? `, sfondo ${l.background}` : ', senza sfondo proprio'}${where(l) ? `, ${where(l)}` : ''}`;

/** Posizione del comando nel banner, in parole: "in alto a destra del banner". */
function where(l: CommandLook): string {
  if (!l.box || !l.container || l.container.w < 2 || l.container.h < 2) return '';
  const cx = (l.box.x + l.box.w / 2 - l.container.x) / l.container.w;
  const cy = (l.box.y + l.box.h / 2 - l.container.y) / l.container.h;
  const v = cy < 0.34 ? 'in alto' : cy > 0.66 ? 'in basso' : 'a metà altezza';
  const h = cx < 0.34 ? 'a sinistra' : cx > 0.66 ? 'a destra' : 'al centro';
  return `${v} ${h} del banner`;
}

/** Distanza in pixel tra i bordi di due comandi (0 se si toccano). */
function gap(a: CommandLook, b: CommandLook): number | null {
  if (!a.box || !b.box) return null;
  const dx = Math.max(0, Math.max(a.box.x, b.box.x) - Math.min(a.box.x + a.box.w, b.box.x + b.box.w));
  const dy = Math.max(0, Math.max(a.box.y, b.box.y) - Math.min(a.box.y + a.box.h, b.box.y + b.box.h));
  return Math.round(Math.hypot(dx, dy));
}

type Prom = { accept: CommandLook | null; reject: CommandLook | null } | undefined;

/**
 * Confronto oggettivo tra il comando di accettazione e quello di rifiuto: tipo (pulsante pieno o link), superficie,
 * testo, posizione e distanza. Il contrasto misura la leggibilità del testo sul proprio sfondo e non l'evidenza
 * del comando: è riportato solo nei dettagli, con questa avvertenza.
 */
function prominenceText(p: Prom): { lines: string[]; sentence: string; asymmetric: boolean; ratio: number } {
  if (!p?.accept || !p.reject) return { lines: [], sentence: '', asymmetric: false, ratio: 1 };
  const ratio = (p.accept.width * p.accept.height) / Math.max(1, p.reject.width * p.reject.height);
  const d = gap(p.accept, p.reject);
  const contrast = (l: CommandLook) => (l.contrast ? `${fmtNum(l.contrast)}:1` : 'n.d.');
  const lines = [
    `Accettazione "${p.accept.text}": ${lookText(p.accept)}`,
    `Rifiuto "${p.reject.text}": ${lookText(p.reject)}`,
    ...(d !== null ? [`Distanza tra i due comandi: ${d} px`] : []),
    `Contrasto del testo sul proprio sfondo (leggibilità, non evidenza del comando): accettazione ${contrast(p.accept)}, rifiuto ${contrast(p.reject)}`,
  ];
  const asymmetric = p.accept.kind !== p.reject.kind || ratio >= 1.5;
  const pos = (l: CommandLook) => (where(l) ? ` ${where(l)}` : '');
  const sentence = asymmetric
    ? `"${p.accept.text}" è un ${p.accept.kind}${p.accept.background ? ` con sfondo pieno ${p.accept.background}` : ''}${pos(p.accept)}; ` +
      `"${p.reject.text}" è un ${p.reject.kind}${p.reject.background ? ` con sfondo ${p.reject.background}` : ' senza sfondo'}${pos(p.reject)}` +
      `${d !== null && d > 40 ? `, a ${d} px dal comando di accettazione` : ''}. ` +
      `La superficie del comando di accettazione è ${fmtNum(ratio)} volte quella del comando di rifiuto (testo ${p.accept.fontSize} px contro ${p.reject.fontSize} px).`
    : 'I comandi di accettazione e di rifiuto hanno aspetto e dimensioni simili.';
  return { lines, sentence, asymmetric, ratio };
}

/** Struttura del banner al primo livello: quali comandi offre, link all'informativa, modo per rivedere la scelta. */
export const strutturaBanner: Rule = {
  id: 'struttura-banner',
  title: 'Struttura del banner',
  defaultSeverity: 'informativa',
  defaultNorms: ['garante2021'],
  evaluate({ sessions }) {
    return analyses(sessions).map(({ s, a }): RawFinding => {
      const f = a.firstLayer;
      const prom = prominenceText(a.prominence);
      return {
        site: s.site,
        scenario: s.scenario,
        pageUrl: s.pages[0],
        groupKey: [f.all.join('|'), !!a.policyLink, !!a.revokeLink].join('#'),
        description:
          `Al primo livello il banner${a.cmp.length ? ` (${a.cmp.join(', ')})` : ''} offre: accettazione ${list(f.accept)}; ` +
          `rifiuto ${list(f.reject)}; preferenze ${list(f.preferences)}; chiusura (X) ${f.close.length ? list(f.close) : 'assente'}. ` +
          `Link all'informativa nel banner: ${a.policyLink ? `"${a.policyLink.text}"` : 'non trovato'}. ` +
          `Modo per rivedere la scelta nella pagina: ${a.revokeLink ? `"${a.revokeLink.text}"` : 'non trovato'}.` +
          (prom.sentence ? ` ${prom.asymmetric ? 'Evidenza dei comandi: vedi la scheda dedicata.' : prom.sentence}` : ''),
        details: [
          `Tutti i comandi rilevati nel banner: ${list(f.all)}`,
          ...prom.lines,
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
  evaluate({ sessions, discovery }) {
    return analyses(sessions)
      .filter(({ a }) => !a.revokeLink)
      .map(({ s }): RawFinding => {
        // Una pagina dedicata (es. /preferenze-cookies) trovata tra le URL del sito è probabilmente il meccanismo di revoca.
        const page = discovery?.find((d) => d.site === s.site)?.revokePages?.[0];
        return {
          site: s.site,
          scenario: s.scenario,
          pageUrl: s.pages[0],
          severity: page ? 'informativa' : undefined,
          groupKey: page ? 'revoca-pagina' : 'revoca',
          headline: page ? undefined : 'Nella pagina non è stato trovato un comando per rivedere la scelta sui cookie (da confermare a vista)',
          description:
            'Nella pagina non è stato trovato un link o pulsante per riaprire le preferenze dei cookie e modificare la scelta (ricerca nell\'intera pagina, footer compreso: per testo, es. "Preferenze cookie", per indirizzo, es. /preferenze-cookies, e per gli elementi dei gestori noti). ' +
            (page
              ? `Tra le pagine del sito c'è però una pagina dedicata, probabilmente il meccanismo di revoca: ${page}.`
              : 'Il risultato va confermato a vista: il comando può avere un testo non riconosciuto o comparire solo dopo la scelta.'),
          details: page ? [`Pagina di gestione dei cookie: ${page}`] : [],
          // la prova è il fondo della pagina (footer), dove di solito si trova il comando
          evidence: sessionEvidence(s, ['3-footer']).filter((e) => !e.file.endsWith('.har')),
        };
      });
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

interface OtGroupState {
  id: string;
  nome: string;
  statoPredefinito?: string;
  stato?: string;
  elementi: number;
  inPc?: boolean | null;
}

/**
 * OneTrust: categorie presenti nella configurazione, con cookie associati, che non compaiono nel pannello
 * delle preferenze mostrato all'utente. È un fatto documentale: l'utente non le vede e non può sceglierle.
 */
export const categorieNonPresentate: Rule = {
  id: 'categorie-non-presentate',
  title: 'Categorie configurate ma non presentate all\'utente',
  defaultSeverity: 'bassa',
  defaultNorms: ['gdpr13', 'garante2021'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    const seen = new Set<string>();
    for (const s of sessions) {
      if (seen.has(s.site)) continue;
      // lo stato in cui il centro preferenze era leggibile (dopo la scelta o, se no, prima)
      const groups = [s.interaction.consentStateAfter, s.interaction.consentStateBefore]
        .map((st) => (st as { onetrust?: { gruppi?: OtGroupState[] | null } } | undefined)?.onetrust?.gruppi)
        .find((g) => g?.some((x) => x.inPc !== null && x.inPc !== undefined));
      if (!groups) continue;
      seen.add(s.site);
      const always = (g: OtGroupState) => (g.statoPredefinito ?? g.stato ?? '').includes('always');
      const hidden = groups.filter((g) => g.inPc === false && g.elementi > 0 && !always(g));
      if (!hidden.length) continue;
      const shown = groups.filter((g) => g.inPc || always(g));
      out.push({
        site: s.site,
        scenario: s.scenario,
        pageUrl: s.pages[0],
        groupKey: hidden.map((g) => g.id).join('|'),
        description:
          `La configurazione del gestore del consenso (OneTrust) contiene ${hidden.length === 1 ? '1 categoria' : `${hidden.length} categorie`} con cookie o fornitori associati ` +
          `che non ${hidden.length === 1 ? 'compare' : 'compaiono'} nel pannello delle preferenze mostrato all'utente: ${hidden.map((g) => `"${g.nome}" (${g.elementi} ${g.elementi === 1 ? 'elemento' : 'elementi'})`).join(', ')}. ` +
          `L'utente non le vede e non può sceglierle. Il fatto riguarda la documentazione del gestore e l'informativa; le categorie presentate sono: ${shown.map((g) => `"${g.nome}"${always(g) ? ' (sempre attiva)' : ''}`).join(', ') || 'nessuna leggibile'}.`,
        details: groups.map(
          (g) => `${g.id} "${g.nome}": ${g.elementi} elementi; stato predefinito ${g.statoPredefinito ?? g.stato ?? '—'}; ${g.inPc ? 'presente nel pannello' : always(g) ? 'sempre attiva' : 'non presente nel pannello'}`,
        ),
        evidence: sessionEvidence(s, ['1-banner']).filter((e) => !e.file.endsWith('.har')),
      });
    }
    return out;
  },
};

/**
 * Accettazione più evidente del rifiuto (pulsante pieno contro link, superficie, posizione), al primo livello
 * o nel pannello delle preferenze: un aspetto del banner che può incidere sulla validità del consenso.
 */
export const evidenzaAsimmetrica: Rule = {
  id: 'evidenza-asimmetrica',
  title: 'Comandi di accettazione e rifiuto con evidenza diversa',
  defaultSeverity: 'media',
  defaultNorms: ['garante2021', 'gdpr4_11', 'gdpr7'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    for (const { s, a } of analyses(sessions)) {
      for (const [where, p, shot] of [
        ['al primo livello del banner', a.prominence, '1-banner'],
        ['nel pannello delle preferenze', a.preferences?.prominence, '4-preferenze'],
      ] as const) {
        const prom = prominenceText(p);
        if (!prom.asymmetric) continue;
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: s.pages[0],
          groupKey: `${where}|${p!.accept!.text}|${p!.reject!.text}`,
          headline: `${where[0].toUpperCase()}${where.slice(1)} "${p!.accept!.text}" è un ${p!.accept!.kind} ${fmtNum(prom.ratio)} volte più grande di "${p!.reject!.text}" (${p!.reject!.kind})`,
          description: `Misure dei comandi ${where}. ${prom.sentence}`,
          details: prom.lines,
          evidence: sessionEvidence(s, [shot]).filter((e) => !e.file.endsWith('.har')),
        });
      }
    }
    return out;
  },
};
