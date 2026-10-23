#!/usr/bin/env node
// Verifica che tutte le dipendenze installate (dirette e transitive) abbiano
// una licenza compatibile con l'uso commerciale e con la licenza MIT del progetto.
// Esce con codice 1 se trova licenze non in elenco o mancanti.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD',
  'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0',
]);

const root = new URL('..', import.meta.url).pathname;
const nm = join(root, 'node_modules');
const includeDev = process.argv.includes('--dev');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

function licenseOk(expr) {
  if (!expr) return false;
  // Gestisce espressioni SPDX semplici: "(MIT OR Apache-2.0)", "MIT AND ISC"
  const clean = expr.replace(/[()]/g, '').trim();
  if (clean.includes(' OR ')) return clean.split(' OR ').some((p) => ALLOWED.has(p.trim()));
  if (clean.includes(' AND ')) return clean.split(' AND ').every((p) => ALLOWED.has(p.trim()));
  return ALLOWED.has(clean);
}

const problems = [];
let count = 0;
for (const [path, info] of Object.entries(lock.packages ?? {})) {
  if (!path.startsWith('node_modules/')) continue;
  if (info.dev && !includeDev) continue;
  count++;
  let license = info.license;
  if (!license) {
    const pj = join(root, path, 'package.json');
    if (existsSync(pj)) license = JSON.parse(readFileSync(pj, 'utf8')).license;
  }
  if (typeof license === 'object' && license) license = license.type;
  if (!licenseOk(license)) problems.push(`${path.replace(/^node_modules\//, '')}: ${license ?? 'licenza non dichiarata'}`);
}

// Dati di terze parti inclusi nel repository
const vendor = join(root, 'data', 'vendor');
if (existsSync(vendor)) {
  for (const f of readdirSync(vendor)) if (f.startsWith('LICENSE')) count++;
}

if (problems.length) {
  console.error(`Licenze non ammesse (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`OK: ${count} pacchetti${includeDev ? ' (incluse dipendenze di sviluppo)' : ''} con licenze ammesse: ${[...ALLOWED].join(', ')}`);
