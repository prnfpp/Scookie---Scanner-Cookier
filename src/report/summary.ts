import type { Finding, Severity } from '../types.js';
import { repeatsShort } from './repeats.js';
import { labelled } from '../util/text.js';

const SEV: Record<Severity, number> = { alta: 3, media: 2, bassa: 1, informativa: 0 };
const STRENGTH: Record<string, number> = { identificativo: 2, raccolta: 1.5, risorsa: 0.5 };

/**
 * Peso di una scheda per l'ordine di verifica: gravità, poi forza della prova e ripetibilità.
 * Un fatto visto 3 volte su 3 con un identificativo scritto pesa più di uno visto in una sola sessione manuale.
 * I dati di prova dell'operatore ritrovati presso un terzo sono una prova diretta: contano come ripetuti.
 */
export function findingScore(f: Finding): number {
  const directProof = f.ruleId === 'dati-personali-a-terzi' && f.severity === 'alta';
  const rep = directProof ? 1 : !f.repeats ? 1 : f.repeats.manual ? 0.2 : f.repeats.seen / f.repeats.of;
  return SEV[f.severity] * 10 + (STRENGTH[f.evidenceLevel ?? ''] ?? 1) * 2 + rep * 4 + (directProof ? 5 : 0);
}

export interface SummaryItem {
  title: string;
  findings: Finding[];
  severity: Severity;
  score: number;
  /** Ripetibilità della scheda più forte del gruppo. */
  repeats?: string;
  hosts: string[];
}

const TRACKING = ['cookie-prima-del-consenso', 'richiesta-tracker-prima-del-consenso', 'consent-mode-senza-consenso', 'attivazione-dopo-rifiuto', 'attivazione-dopo-chiusura', 'attivazione-dopo-revoca', 'personalizzazione-non-rispettata', 'tecnico-solo-dopo-consenso'];
const DECLARED_TECH = ['categoria-incoerente', 'tecnico-solo-dopo-consenso'];
const BANNER = ['evidenza-asimmetrica', 'struttura-banner', 'rifiuto-non-al-primo-livello', 'categorie-preattivate', 'categorie-non-presentate', 'revoca-non-trovata'];
const PHASE: Record<string, string> = {
  'cookie-prima-del-consenso': 'prima della scelta',
  'richiesta-tracker-prima-del-consenso': 'prima della scelta',
  'consent-mode-senza-consenso': 'prima della scelta',
  'attivazione-dopo-rifiuto': 'dopo il rifiuto',
  'attivazione-dopo-chiusura': 'dopo la chiusura con la X',
  'attivazione-dopo-revoca': 'dopo la revoca',
  'personalizzazione-non-rispettata': 'con il consenso solo alle statistiche',
  'tecnico-solo-dopo-consenso': 'solo dopo il consenso',
};
const PHASE_ORDER = ['prima della scelta', 'dopo il rifiuto', 'dopo la chiusura con la X', 'dopo la revoca', 'con il consenso solo alle statistiche', 'solo dopo il consenso'];

const hostOf = (s: string) => {
  try {
    return new URL(s).hostname;
  } catch {
    return s;
  }
};
const listIt = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);

function item(title: string, fs: Finding[]): SummaryItem {
  const best = [...fs].sort((a, b) => findingScore(b) - findingScore(a))[0];
  return {
    title,
    findings: [...fs].sort((a, b) => a.id.localeCompare(b.id)),
    severity: best.severity,
    score: findingScore(best),
    repeats: best.repeats ? repeatsShort(best.repeats) : undefined,
    hosts: [...new Set(fs.flatMap((f) => (f.sites?.length ? f.sites : [f.site]).map(hostOf)))],
  };
}

const phasesOf = (fs: Finding[]) => PHASE_ORDER.filter((p) => fs.some((f) => PHASE[f.ruleId] === p));

/** Fornitore canonico: lo stesso fornitore con nomi diversi nelle fonti (es. "Bing / Microsoft" e "Microsoft") conta una volta. */
const ALIASES: [RegExp, string][] = [[/\bbing\b|\bmicrosoft\b/i, 'Microsoft'], [/^you ?tube$/i, 'Google']];
export function vendorKey(subject: string): string {
  for (const [re, name] of ALIASES) if (re.test(subject)) return name;
  return subject;
}

/** Prova debole: solo risorse scaricate (script, contenuti), nessuna raccolta osservata. */
const weak = (f: Finding) => f.evidenceLevel === 'risorsa';
/** Fatto osservato in meno della metà delle ripetizioni automatiche. */
const rare = (f: Finding) => !!f.repeats && !f.repeats.manual && f.repeats.of > 1 && f.repeats.seen / f.repeats.of < 0.5;

/** Segnale di consenso riportato nel titolo della scheda (es. "con ad_storage negato…"), se c'è. */
const consentNote = (f: Finding) => /, (con (?:ad_storage|consenso|segnali)[^,]*(?:, cioè [^,]*)?)$/.exec(f.headline ?? '')?.[1];

/** Elenco dei fornitori di un gruppo di schede, con il segnale di consenso quando è lo stesso in tutte le schede del fornitore. */
function vendors(fs: Finding[]): string {
  const by = new Map<string, Finding[]>();
  for (const f of fs) for (const s of (f.subjects ?? []).slice(0, 1)) by.set(vendorKey(s), [...(by.get(vendorKey(s)) ?? []), f]);
  return listIt(
    [...by].map(([v, list]) => {
      const notes = [...new Set(list.map(consentNote))];
      return notes.length === 1 && notes[0] ? `${v} (${notes[0]})` : v;
    }),
  );
}

const MARKETING = /marketing|pubblicit|social/i;

/**
 * Sintesi per causa: le schede che derivano dallo stesso fatto diventano un punto solo, con i fornitori coinvolti.
 * - dati personali verso terzi (sempre per primi: sono la prova più diretta);
 * - segnali di consenso concesso dopo il rifiuto;
 * - strumenti dichiarati tecnici "sempre attivi" ma di statistica o registrazione;
 * - identificativi e raccolte pubblicitarie prima della scelta; statistica e registrazione prima della scelta;
 * - tracciamenti dopo il rifiuto, dopo la chiusura con la X, dopo la revoca;
 * - il banner;
 * - le altre schede di priorità alta o media, una per punto.
 * Non si mescolano forze di prova diverse: le schede con sole risorse scaricate e quelle osservate in meno della metà
 * delle ripetizioni restano fuori dai punti principali e vanno in coda.
 */
export function summaryItems(findings: Finding[]): SummaryItem[] {
  const items: SummaryItem[] = [];
  const used = new Set<Finding>();
  const take = (fs: Finding[]) => fs.forEach((f) => used.add(f));
  const free = (f: Finding) => !used.has(f);
  const boost = (it: SummaryItem, n: number) => ({ ...it, score: it.score + n });

  const pii = findings.filter((f) => f.ruleId === 'dati-personali-a-terzi' && f.severity !== 'informativa');
  if (pii.length) {
    const certain = pii.filter((f) => f.severity === 'alta');
    const base = certain.length ? certain : pii;
    const who = vendors(base) || 'terze parti';
    const afterReject = base.some((f) => /dopo il rifiuto/.test(f.headline ?? ''));
    const replay = base.some((f) => /Session Replay/.test(f.headline ?? ''));
    items.push(
      boost(
        item(
          certain.length
            ? `Dati inseriti nei moduli arrivano a ${who}${afterReject ? ', anche dopo il rifiuto' : ''}${replay ? ' (anche nella registrazione della sessione)' : ''}`
            : `Valori che possono essere dati personali (dai moduli) inviati a ${who}${afterReject ? ', anche dopo il rifiuto' : ''}: da verificare`,
          pii,
        ),
        100,
      ),
    );
    take(pii);
  }

  const granted = findings.filter((f) => f.ruleId === 'consenso-concesso-dopo-rifiuto');
  if (granted.length) {
    items.push(boost(item('Dopo il rifiuto, Google riceve "consenso pubblicitario concesso"', granted), 50));
    take(granted);
  }

  const declaredTech = new Set(findings.filter((f) => DECLARED_TECH.includes(f.ruleId)).flatMap((f) => (f.subjects ?? []).map(vendorKey)));
  if (declaredTech.size) {
    const fs = findings.filter(
      (f) => free(f) && (DECLARED_TECH.includes(f.ruleId) || (TRACKING.includes(f.ruleId) && !weak(f) && !rare(f) && (f.subjects ?? []).some((s) => declaredTech.has(vendorKey(s))))),
    );
    const phases = phasesOf(fs.filter((f) => f.ruleId !== 'categoria-incoerente'));
    items.push(item(`Strumenti dichiarati tecnici e "sempre attivi" ma di statistica, pubblicità o registrazione (${listIt([...declaredTech])})${phases.length ? `: attivi ${listIt(phases)}` : ''}`, fs));
    take(fs);
  }

  const before = findings.filter((f) => free(f) && ['cookie-prima-del-consenso', 'richiesta-tracker-prima-del-consenso'].includes(f.ruleId) && !weak(f) && !rare(f));
  const isMkt = (f: Finding) => MARKETING.test(f.description) && !/\((statistica|registrazione sessioni)/.test(f.description);
  const mkt = before.filter(isMkt);
  if (mkt.length) {
    const ids = mkt.some((f) => f.evidenceLevel === 'identificativo');
    items.push(item(labelled(`${ids ? 'Identificativi e raccolte pubblicitarie' : 'Raccolte pubblicitarie'} prima di qualsiasi scelta sul banner`, vendors(mkt)), mkt));
    take(mkt);
  }
  const stats = before.filter((f) => !isMkt(f));
  if (stats.length) {
    items.push(item(labelled('Statistica e registrazione delle sessioni prima di qualsiasi scelta sul banner', vendors(stats)), stats));
    take(stats);
  }

  // Senza fornitori identificati il punto non lascia un elenco vuoto dopo i due punti: usa il testo alternativo
  for (const [rule, label, empty] of [
    ['attivazione-dopo-rifiuto', 'Dopo il rifiuto restano attivi', 'Dopo il rifiuto restano attivi strumenti non tecnici'],
    ['attivazione-dopo-chiusura', 'Dopo la chiusura del banner con la X sono attivi', 'Dopo la chiusura del banner con la X sono attivi strumenti non tecnici'],
    ['attivazione-dopo-revoca', 'Dopo la revoca del consenso restano attivi', 'Dopo la revoca del consenso restano attivi strumenti non tecnici'],
    ['personalizzazione-non-rispettata', 'Con il consenso alle sole statistiche sono attivi anche', 'Con il consenso alle sole statistiche sono attivi anche strumenti di altre categorie'],
  ] as const) {
    const fs = findings.filter((f) => free(f) && f.ruleId === rule && !weak(f) && !rare(f));
    if (!fs.length) continue;
    items.push(item(labelled(label, vendors(fs), empty), fs));
    take(fs);
  }

  const banner = findings.filter((f) => free(f) && BANNER.includes(f.ruleId) && (f.severity === 'alta' || f.severity === 'media'));
  if (banner.length) {
    items.push(item(`Banner: ${banner.map((f) => f.headline ?? f.ruleTitle).filter((t, i, a) => a.indexOf(t) === i).slice(0, 3).join('; ')}`, banner));
    take(banner);
  }

  // Prove più deboli o fatti poco ripetuti: restano in sintesi ma in coda, separati dagli altri
  const weakOnes = findings.filter((f) => free(f) && TRACKING.includes(f.ruleId) && weak(f));
  if (weakOnes.length) {
    const who = vendors(weakOnes);
    items.push(boost(item(`Script e contenuti scaricati ${who ? `da ${who} ` : ''}prima della scelta o dopo il rifiuto, senza raccolta di dati osservata`, weakOnes), -15));
    take(weakOnes);
  }
  const rareOnes = findings.filter((f) => free(f) && TRACKING.includes(f.ruleId) && rare(f));
  for (const f of rareOnes) {
    items.push(boost(item(`${f.headline ?? f.ruleTitle} (osservato in ${f.repeats!.seen} su ${f.repeats!.of} esecuzioni)`, [f]), -20));
    take([f]);
  }

  for (const f of findings) if (free(f) && f.headline && (f.severity === 'alta' || f.severity === 'media')) items.push(item(f.headline, [f]));

  return items.filter((i) => i.severity === 'alta' || i.severity === 'media').sort((a, b) => b.score - a.score);
}
