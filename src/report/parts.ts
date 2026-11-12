import type { Finding } from '../types.js';

/**
 * Rilievi "per momento" contenuti nelle schede per fornitore (vedi consolidate.ts), ciascuno con il numero della
 * scheda che lo contiene; gli altri rilievi restano come sono. Serve a chi ragiona per regola (sintesi, rimandi,
 * confronto, test) senza dipendere da come le schede sono presentate.
 */
export function expandFindings(findings: Finding[]): Finding[] {
  return findings.flatMap((f) => (f.parts?.length ? f.parts.map((p) => ({ ...p, id: f.id, sites: p.sites?.length ? p.sites : f.sites })) : [f]));
}

/** Chiavi con cui una scheda si riconosce tra due esecuzioni: la sua e quelle dei rilievi che contiene. */
export function findingKeys(f: Finding, keyOf: (x: Finding) => string): string[] {
  return [keyOf(f), ...(f.parts ?? []).map(keyOf)];
}
