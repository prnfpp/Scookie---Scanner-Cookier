import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Finding, NormRef, Severity } from '../types.js';
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
        norms: refs,
      });
    }
  }
  all.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.site.localeCompare(b.site));
  return all.map((f, i) => ({ id: `C-${String(i + 1).padStart(3, '0')}`, ...f }));
}
