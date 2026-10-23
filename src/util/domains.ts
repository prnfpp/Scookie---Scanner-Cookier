import { getDomain, getHostname } from 'tldts';
import type { Party } from '../types.js';

/** Dominio registrabile (eTLD+1) di un host o URL; per host sconosciuti ritorna l'host stesso. */
export function registrableDomain(hostOrUrl: string): string {
  const host = hostOrUrl.includes('://') ? (getHostname(hostOrUrl) ?? hostOrUrl) : hostOrUrl;
  const clean = host.replace(/^\./, '').toLowerCase();
  return getDomain(clean, { allowPrivateDomains: true }) ?? clean;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Determina prima/terza parte rispetto al dominio del sito e ai domini dichiarati propri. */
export class PartyResolver {
  private readonly own: Set<string>;

  constructor(siteDomain: string, extraOwn: string[] = []) {
    this.own = new Set([siteDomain, ...extraOwn].map((d) => registrableDomain(d)));
  }

  party(hostOrDomain: string): Party {
    return this.own.has(registrableDomain(hostOrDomain)) ? 'prima' : 'terza';
  }
}

/** True se `host` coincide con `domain` o ne è un sottodominio. */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.replace(/^\./, '').toLowerCase();
  const d = domain.replace(/^\./, '').toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}
