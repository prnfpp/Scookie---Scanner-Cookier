import type { Finding, Severity } from '../types.js';
import { repeatsShort } from './repeats.js';

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

const TRACKING = ['cookie-prima-del-consenso', 'richiesta-tracker-prima-del-consenso', 'consent-mode-senza-consenso', 'attivazione-dopo-rifiuto', 'attivazione-dopo-revoca', 'personalizzazione-non-rispettata', 'tecnico-solo-dopo-consenso'];
const DECLARED_TECH = ['categoria-incoerente', 'tecnico-solo-dopo-consenso'];
const BANNER = ['evidenza-asimmetrica', 'struttura-banner', 'rifiuto-non-al-primo-livello', 'categorie-preattivate', 'categorie-non-presentate', 'revoca-non-trovata'];
const PHASE: Record<string, string> = {
  'cookie-prima-del-consenso': 'prima della scelta',
  'richiesta-tracker-prima-del-consenso': 'prima della scelta',
  'consent-mode-senza-consenso': 'prima della scelta',
  'attivazione-dopo-rifiuto': 'dopo il rifiuto',
  'attivazione-dopo-revoca': 'dopo la revoca',
  'personalizzazione-non-rispettata': 'con il consenso solo alle statistiche',
  'tecnico-solo-dopo-consenso': 'solo dopo il consenso',
};
const PHASE_ORDER = ['prima della scelta', 'dopo il rifiuto', 'dopo la revoca', 'con il consenso solo alle statistiche', 'solo dopo il consenso'];

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

/**
 * Sintesi per causa: le schede che derivano dallo stesso fatto diventano un punto solo.
 * - dati personali verso terzi;
 * - strumenti dichiarati tecnici "sempre attivi" (insieme a tutto ciò che fanno prima della scelta, dopo il rifiuto…);
 * - per ogni altro fornitore, le fasi in cui è attivo;
 * - il banner;
 * - le altre schede di priorità alta o media, una per punto.
 */
export function summaryItems(findings: Finding[]): SummaryItem[] {
  const items: SummaryItem[] = [];
  const used = new Set<Finding>();
  const take = (fs: Finding[]) => fs.forEach((f) => used.add(f));

  const pii = findings.filter((f) => f.ruleId === 'dati-personali-a-terzi' && f.severity !== 'informativa');
  if (pii.length) {
    const certain = pii.filter((f) => f.severity === 'alta');
    const who = listIt([...new Set((certain.length ? certain : pii).flatMap((f) => f.subjects ?? []))]);
    const afterReject = (certain.length ? certain : pii).some((f) => /dopo il rifiuto/.test(f.headline ?? ''));
    items.push(
      item(
        certain.length ? `Dati inseriti nei moduli arrivano a ${who}${afterReject ? ', anche dopo il rifiuto' : ''}` : `Valori che possono essere dati personali inviati a ${who}: da verificare`,
        pii,
      ),
    );
    take(pii);
  }

  const declaredTech = new Set(findings.filter((f) => DECLARED_TECH.includes(f.ruleId)).flatMap((f) => f.subjects ?? []));
  if (declaredTech.size) {
    const fs = findings.filter((f) => !used.has(f) && (DECLARED_TECH.includes(f.ruleId) || (TRACKING.includes(f.ruleId) && (f.subjects ?? []).some((s) => declaredTech.has(s)))));
    const phases = phasesOf(fs.filter((f) => f.ruleId !== 'categoria-incoerente'));
    items.push(item(`Strumenti dichiarati tecnici e "sempre attivi" ma di statistica o registrazione (${listIt([...declaredTech])})${phases.length ? `: attivi ${listIt(phases)}` : ''}`, fs));
    take(fs);
  }

  const bySubject = new Map<string, Finding[]>();
  for (const f of findings) {
    if (used.has(f) || !TRACKING.includes(f.ruleId) || !f.subjects?.length) continue;
    bySubject.set(f.subjects[0], [...(bySubject.get(f.subjects[0]) ?? []), f]);
  }
  for (const [subject, fs] of bySubject) {
    items.push(item(`${subject}: attivo ${listIt(phasesOf(fs))}`, fs));
    take(fs);
  }

  const banner = findings.filter((f) => !used.has(f) && BANNER.includes(f.ruleId) && (f.severity === 'alta' || f.severity === 'media'));
  if (banner.length) {
    items.push(item(`Banner: ${banner.map((f) => f.headline ?? f.ruleTitle).filter((t, i, a) => a.indexOf(t) === i).slice(0, 3).join('; ')}`, banner));
    take(banner);
  }

  for (const f of findings) if (!used.has(f) && f.headline && (f.severity === 'alta' || f.severity === 'media')) items.push(item(f.headline, [f]));

  return items.filter((i) => i.severity === 'alta' || i.severity === 'media').sort((a, b) => b.score - a.score);
}
