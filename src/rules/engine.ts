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
const STRENGTH = ['', 'risorsa', 'raccolta', 'identificativo'];

/** `merge: false`: schede per singolo sito, senza raggruppare tra sottodomini (per contare la ripetibilità per sito). */
export function evaluateRules(ctx: RuleContext, norms: NormsTable, opts: { merge?: boolean } = {}): Finding[] {
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
        ...(raw.subjects?.length ? { subjects: raw.subjects } : {}),
        sites: [raw.site],
        key: raw.groupKey
          ? `${rule.id}|${raw.groupKey}|${registrableDomain(shortHost(raw.site))}`
          : `${rule.id}|${shortHost(raw.site)}|${raw.scenario ?? ''}|${raw.headline ?? raw.description.slice(0, 160)}`,
        norms: refs,
        groupKey: raw.groupKey,
      } as Omit<Finding, 'id'> & { groupKey?: string });
    }
  }
  const merged = opts.merge === false ? all.map(({ groupKey: _g, ...f }: Omit<Finding, 'id'> & { groupKey?: string }) => f) : mergeAcrossSites(all as (Omit<Finding, 'id'> & { groupKey?: string })[]);
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
  for (const g0 of groups.values()) {
    // la scheda prende titolo e descrizione dal caso con la prova più forte (es. cookie scritto, non solo script)
    const g = [...g0].sort((a, b) => STRENGTH.indexOf(b.evidenceLevel ?? '') - STRENGTH.indexOf(a.evidenceLevel ?? ''));
    const { groupKey: _g, ...first } = g[0];
    if (g.length === 1) {
      out.push(first);
      continue;
    }
    // lo stesso fatto può arrivare più volte dallo stesso sito (ripetizioni, navigazione manuale): un blocco per sito
    const sites = [...new Set(g.flatMap((f) => f.sites))];
    const hosts = [...new Set(sites.map(shortHost))];
    const byHost = new Map<string, string[][]>();
    for (const f of g) byHost.set(shortHost(f.site), [...(byHost.get(shortHost(f.site)) ?? []), f.details]);
    const multi = hosts.length > 1;
    out.push({
      ...first,
      site: multi ? `${registrableDomain(hosts[0])} (${hosts.join(', ')})` : first.site,
      sites,
      severity: ORDER[Math.min(...g.map((f) => ORDER.indexOf(f.severity)))],
      description: multi ? `${first.description} Lo stesso si osserva anche su: ${hosts.slice(1).join(', ')}.` : first.description,
      // dettagli per sito; i siti senza dettagli non producono intestazioni vuote
      details: hosts.flatMap((h) => {
        const lines = mergeDetails(byHost.get(h) ?? []);
        if (!lines.length) return [];
        return multi ? [`— ${h}:`, ...lines.map((d) => `   ${d}`)] : lines;
      }),
      evidence: g.slice(0, 3).flatMap((f) => f.evidence),
      subjects: [...new Set(g.flatMap((f) => f.subjects ?? []))],
      headline: first.headline && multi ? `${first.headline} (${hosts.join(', ')})` : first.headline,
    });
  }
  return out;
}

/** Righe che descrivono un esempio: dello stesso sito basta il primo. */
const FIRST_ONLY = ['Richiesta di esempio', 'Metodo di interazione', 'Consenso Google dichiarato nella richiesta di esempio', 'Segnali di consenso Google nelle richieste'];

/**
 * Unisce i dettagli di più schede dello stesso sito: elenchi di pagine uniti, esempi presi una volta,
 * righe identiche una volta sola.
 */
export function mergeDetails(groups: string[][]): string[] {
  const out: string[] = [];
  const lists = new Map<string, { index: number; items: string[] }>();
  const seen = new Set<string>();
  for (const lines of groups) {
    for (const line of lines) {
      const m = /^(Pagine[^:]*): (.*)$/.exec(line);
      if (m) {
        const l = lists.get(m[1]);
        const items = m[2].split(', ');
        if (l) {
          for (const it of items) if (!l.items.includes(it)) l.items.push(it);
        } else {
          lists.set(m[1], { index: out.length, items });
          out.push(line);
        }
        continue;
      }
      const prefix = FIRST_ONLY.find((p) => line.startsWith(`${p}:`));
      const key = prefix ?? line;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  for (const [name, l] of lists) out[l.index] = `${name}: ${l.items.join(', ')}`;
  return out;
}
