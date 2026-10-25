import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Finding, NormRef, Severity } from '../types.js';
import { registrableDomain } from '../util/domains.js';
import { RULES } from './index.js';
import type { RuleContext } from './types.js';

export const DEFAULT_NORMS_FILE = fileURLToPath(new URL('../../../config/norme.yaml', import.meta.url));

interface NormsFile {
  norme: Record<string, { titolo: string; riferimento: string; url?: string }>;
  regole?: Record<string, { norme?: string[]; gravita?: Severity }>;
}

export interface NormsTable {
  path: string;
  file: NormsFile;
}

export function loadNorms(path = DEFAULT_NORMS_FILE): NormsTable {
  const file = parse(readFileSync(path, 'utf8')) as NormsFile;
  if (!file?.norme) throw new Error(`File norme non valido: ${path}`);
  return { path, file };
}

const ORDER: Severity[] = ['alta', 'media', 'bassa', 'informativa'];

export function evaluateRules(ctx: RuleContext, norms: NormsTable): Finding[] {
  const all: Omit<Finding, 'id'>[] = [];
  for (const rule of RULES) {
    const override = norms.file.regole?.[rule.id];
    const keys = override?.norme ?? rule.defaultNorms;
    const refs: NormRef[] = keys.map((k) => {
      const n = norms.file.norme[k];
      return n ? { key: k, title: n.titolo, reference: n.riferimento, url: n.url } : { key: k, title: k, reference: `(norma "${k}" non presente nella tabella)` };
    });
    for (const raw of rule.evaluate(ctx)) {
      all.push({
        ruleId: rule.id,
        ruleTitle: rule.title,
        // la gravità del caso specifico (es. "informativa") prevale; altrimenti quella della tabella o della regola
        severity: raw.severity ?? override?.gravita ?? rule.defaultSeverity,
        site: raw.site,
        scenario: raw.scenario,
        pageUrl: raw.pageUrl,
        description: raw.description,
        details: raw.details,
        evidence: raw.evidence,
        requestExcerpt: raw.requestExcerpt,
        evidenceLevel: raw.evidenceLevel,
        headline: raw.headline,
        sites: [raw.site],
        key: raw.groupKey
          ? `${rule.id}|${raw.groupKey}|${registrableDomain(shortHost(raw.site))}`
          : `${rule.id}|${shortHost(raw.site)}|${raw.scenario ?? ''}|${raw.headline ?? raw.description.slice(0, 160)}`,
        norms: refs,
        groupKey: raw.groupKey,
      } as Omit<Finding, 'id'> & { groupKey?: string });
    }
  }
  const merged = mergeAcrossSites(all as (Omit<Finding, 'id'> & { groupKey?: string })[]);
  merged.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.site.localeCompare(b.site));
  return merged.map((f, i) => ({ id: `C-${String(i + 1).padStart(3, '0')}`, ...f }));
}

const shortHost = (site: string) => {
  try {
    return new URL(site).hostname;
  } catch {
    return site;
  }
};

/**
 * Unisce le schede della stessa regola e con la stessa chiave osservate su più siti dello stesso dominio
 * (es. la stessa configurazione OneTrust su www, app e area candidati): una scheda sola con l'elenco dei siti
 * e, per ogni sito, i suoi dettagli. La descrizione resta quella del primo sito, con il rimando agli altri.
 */
function mergeAcrossSites(list: (Omit<Finding, 'id'> & { groupKey?: string })[]): Omit<Finding, 'id'>[] {
  const out: Omit<Finding, 'id'>[] = [];
  const groups = new Map<string, (Omit<Finding, 'id'> & { groupKey?: string })[]>();
  for (const f of list) {
    if (!f.groupKey) {
      const { groupKey: _g, ...rest } = f;
      out.push(rest);
      continue;
    }
    const k = `${f.ruleId}|${f.groupKey}|${registrableDomain(shortHost(f.site))}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  for (const g of groups.values()) {
    const { groupKey: _g, ...first } = g[0];
    if (g.length === 1) {
      out.push(first);
      continue;
    }
    const sites = [...new Set(g.flatMap((f) => f.sites))];
    const hosts = sites.map(shortHost);
    out.push({
      ...first,
      site: `${registrableDomain(hosts[0])} (${hosts.join(', ')})`,
      sites,
      severity: ORDER[Math.min(...g.map((f) => ORDER.indexOf(f.severity)))],
      description: `${first.description} Lo stesso si osserva anche su: ${hosts.slice(1).join(', ')}.`,
      // dettagli per sito; i siti senza dettagli non producono intestazioni vuote
      details: g.flatMap((f) => (f.details.length ? [`— ${shortHost(f.site)}:`, ...f.details.map((d) => `   ${d}`)] : [])),
      evidence: g.slice(0, 3).flatMap((f) => f.evidence),
      headline: first.headline ? `${first.headline} (${hosts.join(', ')})` : undefined,
    });
  }
  return out;
}
