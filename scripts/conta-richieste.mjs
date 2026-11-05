#!/usr/bin/env node
// Conta, sessione per sessione e pagina per pagina, le richieste che corrispondono a un'espressione (predefinita:
// matomo.php) in una rilevazione: dai dati raccolti (momento assegnato dallo strumento) e dal file HAR (richieste
// registrate dal browser, con l'orario). Serve a verificare a mano il momento "al caricamento / dopo lo scroll".
//
// Uso: node scripts/conta-richieste.mjs <cartella-rilevazione> [espressione] [sessioni...]
// Esempio: node scripts/conta-richieste.mjs runs/2026-11-03_123112_Cliente 'matomo\.php' S001 S002 S003 S016
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [dir, pattern = 'matomo\\.php', ...only] = process.argv.slice(2);
if (!dir) {
  console.error('Uso: node scripts/conta-richieste.mjs <cartella-rilevazione> [espressione] [sessioni...]');
  process.exit(1);
}
const re = new RegExp(pattern);
const file = ['raccolta.json', 'dati.json'].map((f) => join(dir, f)).find(existsSync);
if (!file) throw new Error(`Nessun raccolta.json o dati.json in ${dir}`);
const data = JSON.parse(readFileSync(file, 'utf8'));
const readHar = (rel) => {
  for (const p of [rel, `${rel}.gz`, rel.replace(/\.gz$/, '')]) {
    const abs = join(dir, p);
    if (!existsSync(abs)) continue;
    const buf = readFileSync(abs);
    return JSON.parse((p.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
  }
  return null;
};
for (const s of data.sessions) {
  if (only.length && !only.some((id) => s.id.startsWith(id))) continue;
  const reqs = s.requests.filter((r) => re.test(r.url));
  console.log(`\n${s.id} — scenario ${s.scenario}, scelta: ${s.interaction.outcome}, banner: ${s.interaction.bannerVisibleBefore ? 'sì' : 'no'}`);
  if (s.visits?.length) for (const [i, v] of s.visits.entries()) console.log(`  visita ${i}: ${v.at} ${v.url}${v.interactionAt ? ` (prima interazione ${v.interactionAt})` : ''}`);
  const byPage = new Map();
  for (const r of reqs) {
    const k = r.pageUrl;
    const c = byPage.get(k) ?? { n: 0, caricamento: 0, scroll: 0, altro: 0, raccolta: 0, list: [] };
    c.n++;
    if (r.phase === 'prima' && r.stage === 'caricamento') c.caricamento++;
    else if (r.phase === 'prima' && r.stage === 'scroll') c.scroll++;
    else c.altro++;
    if (r.method !== 'GET' || /[?&](rec|idsite)=/.test(r.url)) c.raccolta++;
    c.list.push(`${r.at} ${r.method} ${r.resourceType} fase=${r.phase} momento=${r.stage}${r.sentOnExit ? ' all\'uscita' : ''}${r.visit !== undefined ? ` visita=${r.visit}` : ''}`);
    byPage.set(k, c);
  }
  for (const [page, c] of byPage) {
    console.log(`  ${page}: ${c.n} richieste (di cui ${c.raccolta} con parametri di raccolta) — al caricamento ${c.caricamento}, dopo lo scroll ${c.scroll}, dopo la scelta ${c.altro}`);
    for (const l of c.list) console.log(`     ${l}`);
  }
  const har = s.har ? readHar(s.har) : null;
  if (har) {
    const pages = new Map((har.log.pages ?? []).map((p) => [p.id, p]));
    const entries = har.log.entries.filter((e) => re.test(e.request.url));
    const byRef = new Map();
    for (const e of entries) byRef.set(e.pageref ?? '—', [...(byRef.get(e.pageref ?? '—') ?? []), e]);
    console.log(`  HAR ${s.har}: ${entries.length} richieste`);
    for (const [ref, list] of byRef) {
      const p = pages.get(ref);
      console.log(`    pagina HAR ${ref}${p ? ` (${p.startedDateTime} ${p.title ?? ''})` : ''}: ${list.length} — ${list.map((e) => `${e.startedDateTime.slice(11, 23)} ${e.request.method}`).join(', ')}`);
    }
  } else if (s.har) console.log(`  HAR ${s.har} non trovato`);
}
