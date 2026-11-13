import type { Finding, NormRef, Severity } from '../types.js';
import { registrableDomain } from '../util/domains.js';
import { findingScore, vendorKey } from './summary.js';

/** Regole che descrivono lo stesso fornitore in momenti diversi rispetto alla scelta sul banner. */
const MOMENTS: [string, string][] = [
  ['cookie-prima-del-consenso', 'Prima della scelta'],
  ['richiesta-tracker-prima-del-consenso', 'Prima della scelta'],
  ['attivazione-dopo-rifiuto', 'Dopo il rifiuto'],
  ['attivazione-dopo-chiusura', 'Dopo la chiusura del banner con la X'],
  ['personalizzazione-non-rispettata', 'Con il consenso alle sole statistiche'],
  ['attivazione-dopo-revoca', 'Dopo la revoca del consenso'],
];
const MOMENT = new Map(MOMENTS);
const ORDER = MOMENTS.map(([r]) => r);
const SEV: Severity[] = ['alta', 'media', 'bassa', 'informativa'];
const STRENGTH = ['', 'risorsa', 'raccolta', 'identificativo'];

/** Regola della scheda che riunisce un fornitore: i rilievi per momento sono in `parts`. */
export const VENDOR_RULE = 'tracciamenti-fornitore';
export const VENDOR_RULE_TITLE = 'Tracciamenti dello stesso fornitore in più momenti';

/** Momento di un rilievo, per titolo di sezione: senza banner "prima della scelta" non ha senso. */
export function momentLabel(f: Finding): string {
  const m = MOMENT.get(f.ruleId) ?? f.ruleTitle;
  return f.noBanner && m === 'Prima della scelta' ? 'In assenza di banner' : m;
}

const hostOf = (s: string) => {
  try {
    return new URL(s).hostname;
  } catch {
    return s;
  }
};
const listIt = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);

/**
 * Una scheda per fornitore e dominio: i rilievi dello stesso fornitore prima della scelta, dopo il rifiuto, dopo la
 * X, dopo la revoca (e con il consenso alle sole statistiche) diventano sezioni di una scheda sola, con la priorità
 * più alta tra le sezioni. Ogni sezione conserva testo, prove, ripetibilità e chiave del rilievo da cui viene.
 * Un fornitore osservato in un solo momento resta una scheda normale.
 */
export function consolidateByVendor(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  const out: Finding[] = [];
  for (const f of findings) {
    const vendor = f.subjects?.[0];
    if (!MOMENT.has(f.ruleId) || !vendor) {
      out.push(f);
      continue;
    }
    const k = `${vendorKey(vendor)}|${registrableDomain(hostOf(f.sites[0] ?? f.site))}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  for (const [k, list] of groups) {
    if (list.length < 2) {
      out.push(...list);
      continue;
    }
    const [vendor, domain] = k.split('|');
    const parts = [...list].sort(
      (a, b) => ORDER.indexOf(a.ruleId) - ORDER.indexOf(b.ruleId) || SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || findingScore(b) - findingScore(a),
    );
    const best = [...parts].sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || findingScore(b) - findingScore(a))[0];
    const sites = [...new Set(parts.flatMap((p) => p.sites))];
    const hosts = [...new Set(sites.map(hostOf))];
    const moments = [...new Set(parts.map(momentLabel))];
    const norms = [...new Map(parts.flatMap((p) => p.norms).map((n): [string, NormRef] => [n.key, n])).values()];
    const evidence = [...new Map(parts.flatMap((p) => p.evidence).map((e) => [e.file, e])).values()];
    const strongest = parts.map((p) => p.evidenceLevel).sort((a, b) => STRENGTH.indexOf(b ?? '') - STRENGTH.indexOf(a ?? ''))[0];
    const momentsText = moments.map((m) => m.charAt(0).toLowerCase() + m.slice(1));
    out.push({
      id: best.id,
      ruleId: VENDOR_RULE,
      ruleTitle: VENDOR_RULE_TITLE,
      severity: best.severity,
      site: hosts.length > 1 ? `${domain} (${hosts.join(', ')})` : best.site,
      sites,
      scenario: null,
      pageUrl: best.pageUrl,
      headline: `${vendor} attivo ${listIt(momentsText)}`,
      description:
        `${vendor} è osservato in ${moments.length === 1 ? '1 momento' : `${moments.length} momenti`}: ${listIt(momentsText)}. ` +
        'Ogni momento è descritto qui sotto con le sue prove e la sua priorità; la priorità della scheda è la più alta.',
      // per i CSV e la revisione: una riga per momento
      details: parts.map((p) => `${momentLabel(p)} — priorità ${p.severity}: ${p.headline ?? p.description.slice(0, 200)}`),
      evidence,
      evidenceLevel: strongest,
      subjects: [...new Set(parts.flatMap((p) => p.subjects ?? []))],
      key: `${VENDOR_RULE}|${vendor}|${domain}`,
      ...(best.repeats ? { repeats: best.repeats } : {}),
      norms,
      ...(parts.every((p) => p.noBanner) ? { noBanner: true } : {}),
      ...(parts.some((p) => p.unverifiable?.length) ? { unverifiable: [...new Set(parts.flatMap((p) => p.unverifiable ?? []))] } : {}),
      parts,
    });
  }
  return out;
}
