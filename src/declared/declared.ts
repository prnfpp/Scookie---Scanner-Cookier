import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parse } from 'yaml';
import { normalizeDeclaredCategory } from '../classify/classifier.js';
import type { DeclaredItem } from '../types.js';
import { detectSeparator, parseCsv } from '../util/csv.js';

const truthy = (v: unknown) => /^(1|s[iì]|y(es)?|true|vero|x)$/i.test(String(v ?? '').trim());

/**
 * Legge un elenco dichiarato da file (CSV o YAML), compilato a mano o esportato dal CMP.
 * Colonne riconosciute (maiuscole/minuscole indifferenti):
 *   nome | name | cookie       (obbligatoria)
 *   dominio | domain | host
 *   categoria | category | gruppo
 *   sempre attiva | sempreAttiva | always active
 *   tipo (cookie | servizio)
 */
export function loadDeclaredFile(path: string): DeclaredItem[] {
  const source = `file:${basename(path)}`;
  const text = readFileSync(path, 'utf8');
  let rows: Record<string, unknown>[];
  if (['.yaml', '.yml'].includes(extname(path).toLowerCase())) {
    const data = parse(text) as unknown;
    rows = (Array.isArray(data) ? data : ((data as { dichiarati?: unknown[] })?.dichiarati ?? [])) as Record<string, unknown>[];
  } else {
    const [header, ...body] = parseCsv(text, detectSeparator(text));
    rows = body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  }
  const get = (r: Record<string, unknown>, re: RegExp) => {
    const k = Object.keys(r).find((key) => re.test(key.trim()));
    return k ? r[k] : undefined;
  };
  const out: DeclaredItem[] = [];
  for (const r of rows) {
    const name = String(get(r, /^(nome|name|cookie|nome cookie|cookie name)$/i) ?? '').trim();
    if (!name) continue;
    const cat = String(get(r, /^(categoria|category|gruppo|group|finalit[aà])$/i) ?? '').trim();
    const always = get(r, /^(sempre ?attiv[ao]|always ?active)$/i);
    const kind = String(get(r, /^(tipo|type|kind)$/i) ?? 'cookie').toLowerCase().startsWith('serv') ? 'servizio' : 'cookie';
    const domain = String(get(r, /^(dominio|domain|host)$/i) ?? '').trim();
    const category = normalizeDeclaredCategory(cat);
    out.push({
      kind,
      name,
      domain: domain || undefined,
      declaredCategory: cat,
      category,
      alwaysActive: always !== undefined && always !== '' ? truthy(always) : category === 'tecnico',
      source,
    });
  }
  return out;
}
