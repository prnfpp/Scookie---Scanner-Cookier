import type { Finding, Repeats } from '../types.js';

const one = (r: Repeats) => (r.manual ? 'sessione manuale singola, non ripetuta' : r.of > 1 ? `osservato in ${r.seen} su ${r.of} esecuzioni` : 'sessione automatica');

/** Ripetibilità per esteso; per sito se i siti della scheda differiscono (es. ripetuto su uno, manuale su un altro). */
export function repeatsText(r: NonNullable<Finding['repeats']>): string {
  const sites = r.perSite ?? [];
  const labels = new Set(sites.map(one));
  if (sites.length > 1 && labels.size > 1) return `${sites.map((p) => `${p.host}: ${one(p)}`).join('; ')}.`;
  if (r.manual) return 'Sessione manuale singola, non ripetuta: il fatto non è stato osservato nelle sessioni automatiche.';
  return `Osservato in ${r.seen} su ${r.of} esecuzioni di ciascuno scenario.`;
}

/** Versione breve, per la sintesi e i CSV. */
export function repeatsShort(r: NonNullable<Finding['repeats']>): string {
  const sites = r.perSite ?? [];
  const short = (p: Repeats) => (p.manual ? 'manuale singola' : p.of > 1 ? `${p.seen} su ${p.of}` : 'automatica');
  if (sites.length > 1 && new Set(sites.map(short)).size > 1) return sites.map((p) => `${p.host.split('.')[0]}: ${short(p)}`).join(', ');
  return short(r);
}
