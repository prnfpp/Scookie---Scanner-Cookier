#!/usr/bin/env node
// Diagnosi di una rilevazione già raccolta, dai dati (dati.json) e dalle registrazioni del traffico (HAR):
//   1. hit di statistica ospitata sul sito (Matomo/Piwik) e cookie _pk_* dopo il rifiuto e dopo la X;
//   2. richieste dopo la scelta partite a ridosso di una navigazione (possibili invii all'uscita dalla pagina
//      precedente), con il Referer, che indica il documento (pagina o iframe) che ha fatto la richiesta;
//   3. per gli host indicati: metodi, percorsi, tipo di risorsa e documento di origine (Referer).
// Solo lettura: non modifica la cartella della rilevazione.
//
// Uso: node scripts/diagnosi-har.mjs <cartella-rilevazione> [--sessioni S016,S020] [--host a.example,b.example]
//      [--finestra 1500]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const dir = args[0];
if (!dir || !existsSync(join(dir, 'dati.json'))) {
  console.error('Uso: node scripts/diagnosi-har.mjs <cartella-rilevazione> [--sessioni S016,S020] [--host h1,h2] [--finestra ms]');
  process.exit(1);
}
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > 0 ? args[i + 1] : undefined;
};
const only = opt('sessioni')?.split(',').map((s) => s.trim()).filter(Boolean);
const hosts = (opt('host') ?? 'jnn-pa.googleapis.com,lh3.googleusercontent.com,yt3.ggpht.com,play.google.com,www.google.com,csp.withgoogle.com,calendar.google.com,calendar-pa.clients6.google.com')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
const windowMs = Number(opt('finestra') ?? 1500);

const data = JSON.parse(readFileSync(join(dir, 'dati.json'), 'utf8'));
const sessions = data.sessions.filter((s) => !only || only.some((p) => s.id.startsWith(p)));
const MATOMO = /\/(matomo|piwik)\.php(\?|$)|[?&]idsite=\d+[^#]*[?&]rec=1|[?&]rec=1[^#]*[?&]idsite=\d+/;

function readHar(s) {
  for (const rel of [s.har ? `${s.har}.gz` : null, s.har].filter(Boolean)) {
    const p = join(dir, rel);
    if (!existsSync(p)) continue;
    const buf = readFileSync(p);
    return JSON.parse((rel.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8')).log;
  }
  // nome alternativo: evidenze/<id>.har.gz
  const ev = join(dir, 'evidenze');
  const f = existsSync(ev) ? readdirSync(ev).find((x) => x.startsWith(s.id) && /\.har(\.gz)?$/.test(x)) : null;
  if (!f) return null;
  const buf = readFileSync(join(ev, f));
  return JSON.parse((f.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8')).log;
}
const header = (e, name) => e.request.headers.find((h) => h.name.toLowerCase() === name)?.value ?? '';
/** Documento caricato nel frame della voce (iframe o pagina), dal campo _frameref del HAR di Playwright. */
function frameDoc(har, e) {
  if (!e?._frameref) return null;
  const t = Date.parse(e.startedDateTime);
  return har.entries.filter((x) => x._frameref === e._frameref && x._resourceType === 'document' && Date.parse(x.startedDateTime) <= t).at(-1)?.request.url ?? null;
}
const short = (u, n = 140) => (u.length > n ? `${u.slice(0, n)}…` : u);

console.log(`Rilevazione: ${dir}\nSessioni esaminate: ${sessions.length}\n`);

// 1. Statistica ospitata sul sito dopo la scelta
console.log('== 1. Hit Matomo/Piwik e cookie _pk_* (scenari rifiuta e chiudi)');
for (const s of sessions.filter((x) => ['rifiuta', 'chiudi'].includes(x.scenario))) {
  const hits = s.requests.filter((r) => MATOMO.test(r.url));
  const after = hits.filter((r) => r.phase === 'dopo');
  const pk = s.cookies.filter((c) => /^_pk_/.test(c.name));
  console.log(`${s.id} (${s.scenario}, scelta ${s.interaction.outcome}): hit prima ${hits.length - after.length}, dopo ${after.length}`);
  for (const r of after.slice(0, 6)) console.log(`   dopo +${r.msFromChoice} ms ${r.method} ${r.resourceType} su ${r.pageUrl} — ${short(r.url)}`);
  for (const c of pk) console.log(`   cookie ${c.name} (${c.domain}): ${c.phase} la scelta, scadenza ${c.expires ?? 'sessione'}${c.renewals ? `, riscritto: ${c.renewals.map((x) => x.stage).join(', ')}` : ''}${c.presentAfterChoice ? ', ancora presente dopo la scelta' : ''}`);
  const har = readHar(s);
  if (har) {
    const entries = har.entries.filter((e) => MATOMO.test(e.request.url));
    const ids = [...new Set(entries.map((e) => /(?:^|; )_pk_id\.[^=]+=([^;]*)/.exec(header(e, 'cookie'))?.[1]).filter(Boolean))];
    console.log(`   HAR: ${entries.length} hit${entries.length ? `, cookie _pk_id inviato: ${ids.join(' | ') || 'nessuno'}` : ''}`);
  } else console.log('   HAR non trovato');
}

// 2. Richieste dopo la scelta a ridosso di una navigazione della pagina principale
console.log(`\n== 2. Richieste di terze parti dopo la scelta entro ${windowMs} ms dall'inizio di una navigazione (possibili invii all'uscita)`);
for (const s of sessions.filter((x) => x.choiceAt)) {
  const docs = s.requests.filter((r) => r.resourceType === 'document' && r.party === 'prima');
  const har = readHar(s);
  const near = s.requests.filter((r) => r.phase === 'dopo' && r.party === 'terza' && r.resourceType !== 'document').map((r) => {
    const t = Date.parse(r.at);
    const doc = docs.filter((d) => Date.parse(d.at) <= t).at(-1);
    return { r, doc, gap: doc ? t - Date.parse(doc.at) : Infinity };
  }).filter((x) => x.gap <= windowMs);
  if (!near.length) continue;
  console.log(`${s.id} (${s.scenario}): ${near.length} richieste`);
  for (const { r, doc, gap } of near.slice(0, 12)) {
    const e = har?.entries.find((x) => x.request.url === r.url && Math.abs(Date.parse(x.startedDateTime) - Date.parse(r.at)) < 2000);
    console.log(`   seq ${r.seq} +${gap} ms dopo la richiesta di ${doc.url} — attribuita a ${r.pageUrl}`);
    console.log(`      ${r.method} ${short(r.url)}`);
    if (e) console.log(`      documento del frame: ${frameDoc(har, e) ?? '(non registrato)'}; Referer: ${header(e, 'referer') || '(assente)'}; pageref: ${e.pageref ?? '—'}`);
  }
}

// 3. Host da classificare: cosa inviano e da quale documento
console.log('\n== 3. Host da classificare: richieste e documento di origine (Referer)');
for (const h of hosts) {
  const rows = new Map();
  for (const s of sessions) {
    const har = readHar(s);
    if (!har) continue;
    for (const e of har.entries) {
      let u;
      try {
        u = new URL(e.request.url);
      } catch {
        continue;
      }
      if (u.hostname !== h) continue;
      let ref = header(e, 'referer');
      try {
        const x = new URL(ref);
        ref = x.origin + x.pathname.split('/').slice(0, 4).join('/');
      } catch {
        // Referer assente o non valido
      }
      let doc = frameDoc(har, e) ?? '';
      try {
        const x = new URL(doc);
        doc = x.origin + x.pathname.split('/').slice(0, 4).join('/');
      } catch {
        // documento del frame non registrato
      }
      const k = `${e.request.method} ${u.pathname.replace(/[A-Za-z0-9_-]{24,}/g, '…')} | ${e._resourceType ?? '?'} | ${e.response.content?.mimeType ?? ''} | frame ${doc || '?'} | Referer ${ref || '—'}`;
      rows.set(k, (rows.get(k) ?? 0) + 1);
    }
  }
  console.log(`${h}: ${rows.size ? '' : 'nessuna richiesta nei HAR'}`);
  for (const [k, n] of [...rows].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`   ${n}× ${k}`);
}
