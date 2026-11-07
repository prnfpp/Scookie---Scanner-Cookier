import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config/load.js';
import { runAudit, type RunResult } from '../src/run.js';
import type { Finding } from '../src/types.js';
import { startFixtureServer } from './fixtures/server.js';

// Correzioni della versione 0.1.2: siti senza banner, Matomo senza cookie, contenuti incorporati (Spotify, Sentry),
// risorse dei temi e informative scritte come testo. Casi generali, con siti di prova; nessun riferimento a siti reali.

// Il browser dei test raggiunge solo il server locale: un proxy dell'ambiente (variabili https_proxy) non deve
// intercettare le richieste HTTPS dei contenuti incorporati di prova.
for (const k of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) delete process.env[k];

let srv: Awaited<ReturnType<typeof startFixtureServer>>;
let result: RunResult;
const MATOMO = 'senza-banner-matomo-cookieless.test';
const SPOTIFY = 'senza-banner-embed-spotify.test';
const url = (host: string, path = '/') => `http://${host}:${srv.port}${path}`;
const of = (host: string) => result.findings.filter((f) => f.site.includes(host));
const texts = (f: Finding) => [f.ruleTitle, f.description, f.headline ?? '', ...f.details].join('\n');

before(async () => {
  srv = await startFixtureServer();
  const dir = mkdtempSync(join(tmpdir(), 'scookie-012-'));
  const config = {
    cliente: 'Cliente di prova 0.1.2',
    output: join(dir, 'runs'),
    browser: { hostResolverRules: 'MAP * 127.0.0.1', userAgentSuffix: 'ScookieAudit/test', servizioUscita: url('trace.test', '/cdn-cgi/trace') },
    protocollo: { attesaDopoCaricamento: 600, attesaDopoScroll: 800, attesaDopoScelta: 500, pausaTraSessioni: 0, timeoutNavigazione: 15000 },
    scenari: { modalita: 'percorso', pagineDopoScelta: 2 },
    campionamento: { perTipo: 1, maxPagine: 4, esplorazione: { sePaginaMeno: 0 } },
    report: { pdf: false },
    siti: [
      { url: url(MATOMO), sitemap: false, banner: { attesa: 800 } },
      { url: url(SPOTIFY), sitemap: false, banner: { attesa: 800 } },
    ],
  };
  const cfgPath = join(dir, 'config.yaml');
  writeFileSync(cfgPath, stringify(config));
  result = await runAudit(loadConfig(cfgPath), { log: () => {} });
});

after(async () => {
  await srv?.close();
});

test('fix 1: senza banner nessun rilievo parla di "scelta sul banner"; titolo di prima parte; scenari solo eseguiti', () => {
  const fs = of(MATOMO);
  assert.ok(fs.length, 'rilievi sul sito di prova');
  for (const f of fs) assert.doesNotMatch(texts(f), /scelta sul banner/, `${f.id} ${f.ruleId}`);
  const m = fs.find((f) => f.ruleId === 'richiesta-tracker-prima-del-consenso' && (f.subjects ?? []).includes('Matomo'))!;
  assert.ok(m, 'rilievo sulle richieste di Matomo');
  assert.match(m.ruleTitle, /di prima parte/);
  assert.match(m.description, /senza alcun meccanismo di consenso \(nessun banner rilevato\)/i);
  const sc = m.details.find((d) => d.startsWith('Scenari:'))!;
  assert.match(sc, /^Scenari: nessuna-azione/);
  // gli scenari con scelta non sono "eseguiti": o non compaiono o sono dichiarati non eseguiti
  assert.doesNotMatch(sc.split(';')[0], /rifiuta|accetta/);
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  assert.doesNotMatch(html.slice(html.indexOf('<h2>1. Sintesi'), html.indexOf('<h2>2. Perimetro')), /scelta sul banner/);
  assert.match(html, /Richieste di tracciamento di prima parte in assenza di banner/);
});

/** Parte del rapporto dall'intestazione indicata fino all'intestazione h3 successiva. */
function section(html: string, start: RegExp): string {
  const i = html.search(start);
  assert.ok(i >= 0, `sezione ${start}`);
  const rest = html.slice(i + 1);
  const j = rest.search(/<h[23]>/);
  return rest.slice(0, j < 0 ? undefined : j);
}

test('fix 2: "Dopo rifiuto" vale n/a se il rifiuto non è stato eseguito; valore esplicito nei CSV', () => {
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  const own = section(html, new RegExp(`${MATOMO}:\\d+ — strumenti di tracciamento sul dominio del sito`));
  assert.match(own, /<td>n\/a<\/td><\/tr>/);
  assert.doesNotMatch(own, /<td>0<\/td><\/tr>/);
  assert.match(own, /<strong>n\/a<\/strong> se il rifiuto non è stato eseguito \(qui: nessun banner\)/);
  const ck = section(html, new RegExp(`${SPOTIFY}:\\d+ — cookie \\(`));
  assert.match(ck, /sp_t<\/td>.*<td>n\/a<\/td>/s);
  const csv = (n: string) => readFileSync(join(result.runDir, n), 'utf8');
  const req = csv('richieste.csv').split('\n');
  const head = req[0].replace(/^﻿/, '').split(';');
  const iMs = head.indexOf('ms_dalla_scelta');
  const iEsito = head.indexOf('esito_scelta');
  assert.ok(iMs > 0 && iEsito > 0, head.join(';'));
  const rows = req.slice(1).filter(Boolean).map((l) => l.split(';'));
  assert.ok(rows.every((r) => r[iMs] !== ''), 'nessuna cella vuota per i millisecondi dalla scelta');
  assert.ok(rows.some((r) => /non-applicabile \(nessuna-azione\)/.test(r[iEsito])));
  assert.match(csv('cookie.csv').split('\n')[0], /esito_scelta/);
});

test('fix 2: esito della scelta per i CSV distingue eseguita, nessun banner e scelta non trovata', async () => {
  const { choiceStatus } = await import('../src/report/csv.js');
  const base = { scenario: 'rifiuta', interaction: { outcome: 'eseguito', bannerVisibleBefore: true, detectedCmps: ['X'] } } as never;
  assert.equal(choiceStatus(base), 'eseguita');
  assert.equal(choiceStatus({ scenario: 'rifiuta', interaction: { outcome: 'non-trovato', bannerVisibleBefore: false, detectedCmps: [] } } as never), 'non-applicabile (nessun banner)');
  assert.equal(choiceStatus({ scenario: 'rifiuta', interaction: { outcome: 'non-trovato', bannerVisibleBefore: true, detectedCmps: [] } } as never), 'non-applicabile (scelta non eseguita: non-trovato)');
  assert.equal(choiceStatus({ scenario: 'nessuna-azione', interaction: { outcome: 'non-applicabile' } } as never), 'non-applicabile (nessuna-azione)');
});

test('fix 3: momento per pagina: un hit di Matomo al caricamento per ogni pagina, nessuno "dopo lo scroll"', () => {
  const ss = result.sessions.filter((s) => s.site.includes(MATOMO));
  let checked = 0;
  for (const s of ss) {
    assert.ok(s.visits?.length, `${s.id}: visite registrate`);
    for (const [i, v] of s.visits!.entries()) {
      if (/privacy-policy/.test(v.url)) continue;
      const hits = s.requests.filter((r) => r.visit === i && /matomo\.php/.test(r.url) && !r.sentOnExit);
      assert.equal(hits.filter((r) => r.stage === 'caricamento').length, 1, `${s.id} visita ${i} ${v.url}`);
      assert.equal(hits.filter((r) => r.stage === 'scroll').length, 0, `${s.id} visita ${i} ${v.url}`);
      checked++;
    }
  }
  assert.ok(checked >= 2, `pagine controllate: ${checked}`);
  const m = of(MATOMO).find((f) => f.ruleId === 'richiesta-tracker-prima-del-consenso')!;
  // raccolte e script contati a parte, mai sommati nella stessa frase sul momento
  assert.ok(!m.details.some((d) => /^Al caricamento:/.test(d)), m.details.join(' | '));
  const line = m.details.find((d) => /richieste? di raccolta dati \(al caricamento: \d+, dopo lo scroll e il movimento del mouse: 0\)/.test(d));
  assert.ok(line, m.details.join(' | '));
  assert.match(line!, /download di script o risorse \(al caricamento: \d+, dopo lo scroll/);
  assert.match(m.description, /invia a Matomo \(statistica\) \d+ richieste di raccolta dati, oltre a \d+ download di script o risorse/);
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  assert.doesNotMatch(html, /ci si aspetta al massimo una raccolta per pagina/);
});

test('fix 3: controllo di coerenza: più raccolte al caricamento che pagine visitate è un\'anomalia', async () => {
  const { pageviewCoherence } = await import('../src/report/coherence.js');
  const hit = (seq: number, visit: number) => ({
    seq, at: '', msFromChoice: null, url: `https://www.esempio.it/matomo.php?idsite=1&rec=1&r=${seq}`, host: 'www.esempio.it', method: 'POST', resourceType: 'ping', party: 'prima', phase: 'prima', stage: 'caricamento',
    pageUrl: 'https://www.esempio.it/', status: 204, tracker: { company: 'Matomo', category: 'statistica' }, visit,
  });
  const s = {
    id: 'S001', site: 'https://www.esempio.it', scenario: 'nessuna-azione', choiceAt: null, requests: [hit(1, 0), hit(2, 1)],
    visits: [{ url: 'https://www.esempio.it/', at: '2026-01-01T10:00:00Z' }, { url: 'https://www.esempio.it/b', at: '2026-01-01T10:00:10Z' }],
  };
  assert.deepEqual(pageviewCoherence([s as never]), []);
  const out = pageviewCoherence([{ ...s, requests: [hit(1, 0), hit(2, 0), hit(3, 1)] } as never]);
  assert.equal(out.length, 1);
  assert.match(out[0], /Matomo ha 3 richieste di raccolta "al caricamento" su 2 pagine visitate/);
  assert.match(out[0], /esempio: S001, https:\/\/www\.esempio\.it\/: 2 raccolte al caricamento/);
  // rilevazioni precedenti alla 0.1.2, senza le visite: nessun controllo
  assert.deepEqual(pageviewCoherence([{ ...s, visits: undefined, requests: [hit(1, 0), hit(2, 0), hit(3, 0)] } as never]), []);
});

test('fix 4: senza banner gli scenari con scelta non si eseguono e i Limiti lo dicono una volta', async () => {
  for (const host of [MATOMO, SPOTIFY]) {
    const ss = result.sessions.filter((s) => s.site.includes(host));
    assert.ok(ss.length, host);
    assert.deepEqual([...new Set(ss.map((s) => s.scenario))], ['nessuna-azione'], host);
  }
  const dati = JSON.parse(readFileSync(join(result.runDir, 'dati.json'), 'utf8')) as { discovery: { site: string; skippedChoice?: { scenarios: string[]; sessions: number } }[] };
  const d = dati.discovery.find((x) => x.site.includes(MATOMO))!;
  assert.deepEqual(d.skippedChoice?.scenarios, ['rifiuta', 'accetta', 'personalizza', 'revoca', 'chiudi']);
  // sito con una sola pagina nel campione: una sessione di conferma prima di saltare gli scenari
  const sp = result.sessions.filter((s) => s.site.includes(SPOTIFY));
  assert.ok(sp.some((s) => s.id.endsWith('_conferma')), sp.map((s) => s.id).join(', '));
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  const lim = html.slice(html.indexOf('<h2>5. Limiti'), html.indexOf('<h2>6. Allegati'));
  for (const host of [MATOMO, SPOTIFY]) {
    const lines = lim.match(new RegExp(`${host}: scenari con scelta non eseguiti: nessun banner rilevato in \\d+ sessioni`, 'g')) ?? [];
    assert.equal(lines.length, 1, `${host}: ${lim}`);
  }
  assert.doesNotMatch(lim, /scenario "(rifiuta|accetta|chiudi|personalizza)" non eseguito/);
  const { configSchema: auditConfigSchema } = await import('../src/config/schema.js');
  const cfg = auditConfigSchema.parse({ cliente: 'x', siti: [{ url: 'https://www.esempio.it/' }] });
  assert.equal(cfg.scenari.saltaSenzaBanner, true);
  assert.equal(auditConfigSchema.parse({ cliente: 'x', scenari: { saltaSenzaBanner: false }, siti: [{ url: 'https://www.esempio.it/' }] }).scenari.saltaSenzaBanner, false);
});

test('fix 4: avanzamento: le sessioni saltate escono dal totale', async () => {
  const { ProgressTracker } = await import('../src/progress.js');
  const seen: { total: number; sites: { total: number }[] }[] = [];
  const p = new ProgressTracker((x) => seen.push(x), 0);
  p.plan('https://www.esempio.it', 8, 0);
  p.skip('https://www.esempio.it', 5);
  assert.equal(seen.at(-1)!.total, 3);
  assert.equal(seen.at(-1)!.sites[0].total, 3);
});

test('fix 5: classificazione di Spotify, Sentry, Gravatar e risorse dei temi; elenco curato prima di Open Cookie Database', async () => {
  const { Classifier } = await import('../src/classify/classifier.js');
  const c = new Classifier();
  const emb = 'Spotify (contenuto incorporato)';
  assert.equal(c.classifyHost('open.spotify.com', '/embed/show/abc')?.azienda, emb);
  assert.equal(c.classifyHost('open.spotify.com', '/embed/show/abc')?.raggruppa, true);
  for (const h of ['embed-cdn.spotifycdn.com', 'image-cdn-ak.spotifycdn.com', 'image-cdn-fa.spotifycdn.com', 'encore.scdn.co', 'apresolve.spotify.com']) {
    const t = c.classifyHost(h, '/x');
    assert.equal(t?.azienda, emb, h);
    assert.equal(t?.categoria, 'funzionalita', h);
  }
  assert.equal(c.classifyHost('gew4-spclient.spotify.com', '/gabo-receiver-service/public/v3/events')?.categoria, 'statistica');
  assert.equal(c.classifyHost('gae2-spclient.spotify.com', '/melody/v1/msg/batch')?.categoria, 'statistica');
  assert.equal(c.classifyHost('gew4-spclient.spotify.com', '/metadata/4/show/x')?.categoria, 'funzionalita');
  // il modello non vale per nomi diversi
  assert.equal(c.classifyHost('image-cdn.esempio.it', '/x'), undefined);
  for (const h of ['o22381.ingest.sentry.io', 'o22381.ingest.us.sentry.io', 'o1.ingest.de.sentry.io']) assert.equal(c.classifyHost(h, '/api/1/envelope/')?.azienda, 'Sentry', h);
  const g = c.classifyHost('secure.gravatar.com', '/avatar/abc')!;
  assert.equal(g.azienda, 'Gravatar (Automattic)');
  assert.match(g.nota ?? '', /hash dell'email dell'autore o del commentatore; il visitatore invia IP e referrer ad Automattic/);
  const th = c.classifyHost('themes.muffingroup.com', '/be/business5/wp-content/uploads/x.svg')!;
  assert.equal(th.categoria, 'funzionalita');
  assert.match(th.nota ?? '', /trasmette IP e referrer allo sviluppatore del tema/);
  const sp = c.classifyName('sp_t', '.spotify.com');
  assert.equal(sp.category, 'marketing');
  assert.equal(sp.platform, emb);
  assert.equal(sp.source, 'elenco curato Scookie');
  assert.notEqual(c.classifyName('sp_landing', '.spotify.com').category, 'funzionalita');
  assert.equal(c.classifyName('sentryReplaySession', 'open.spotify.com').category, 'registrazione-sessioni');
});

test('fix 5: embed Spotify: identificativo, telemetria e Session Replay di Sentry in un rilievo con la priorità di YouTube', async () => {
  const fs = of(SPOTIFY);
  const emb = 'Spotify (contenuto incorporato)';
  const ck = fs.find((f) => f.ruleId === 'cookie-prima-del-consenso' && (f.subjects ?? []).includes(emb));
  assert.ok(ck, fs.map((f) => `${f.ruleId}:${f.subjects}`).join(' | '));
  // stessa regola e priorità dei cookie di un video YouTube non bloccato (config/norme.yaml)
  const { loadNorms } = await import('../src/rules/engine.js');
  assert.equal(ck.severity, loadNorms().file.regole?.['cookie-prima-del-consenso']?.gravita);
  assert.equal(ck.severity, 'alta');
  assert.equal(ck.evidenceLevel, 'identificativo');
  assert.ok(ck.details.some((d) => /^cookie "sp_t"/.test(d)), ck.details.join(' | '));
  assert.ok(ck.details.some((d) => /sentryReplaySession.*Sentry, caricato da Spotify \(contenuto incorporato\)/.test(d)), ck.details.join(' | '));
  assert.match(ck.description, /solo dopo lo scroll/);
  assert.match(ck.evidenceExtra ?? '', /dati di navigazione inviati/);
  // telemetria e Sentry sono lo stesso fatto (0.1.3): accorpati nel rilievo sui cookie, non un rilievo a parte
  assert.ok(!fs.some((f) => f.ruleId === 'richiesta-tracker-prima-del-consenso' && (f.subjects ?? []).includes(emb)), 'nessun rilievo separato per le richieste');
  assert.ok(ck.details.some((d) => /Natura delle richieste: Sentry .*caricato da Spotify \(contenuto incorporato\)/.test(d)), ck.details.join(' | '));
  // nessun dominio di Spotify o Sentry tra i non classificati
  const unk = fs.find((f) => f.ruleId === 'elementi-non-classificati');
  if (unk) assert.ok(!unk.details.some((d) => /spotify|scdn|sentry/i.test(d)), unk.details.join(' | '));
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  assert.match(html, /Sentry<br><span class="muted">caricato da Spotify \(contenuto incorporato\)<\/span>/);
});

test('fix 5: Gravatar e risorsa del tema classificati, non tra gli elementi da valutare', () => {
  const unk = of(MATOMO).find((f) => f.ruleId === 'elementi-non-classificati');
  if (unk) assert.ok(!unk.details.some((d) => /gravatar|muffingroup/.test(d)), unk.details.join(' | '));
  const reqs = result.sessions.filter((s) => s.site.includes(MATOMO)).flatMap((s) => s.requests);
  assert.ok(reqs.some((r) => r.host === 'secure.gravatar.com' && r.tracker?.company === 'Gravatar (Automattic)'));
  assert.ok(reqs.some((r) => r.host === 'themes.muffingroup.com' && r.tracker?.company === 'BeTheme (Muffin Group)'));
});

test('fix 6: Matomo di prima parte senza cookie (con disableCookies): titolo, testo, condizioni non verificabili, priorità', async () => {
  const m = of(MATOMO).find((f) => f.ruleId === 'richiesta-tracker-prima-del-consenso' && (f.subjects ?? []).includes('Matomo'))!;
  assert.match(m.ruleTitle, /Matomo di prima parte, in modalità senza cookie/);
  assert.match(m.description, /in modalità senza cookie/);
  assert.equal(m.evidenceLevel, 'raccolta');
  assert.ok(m.details.some((d) => /^Stato dei cookie di Matomo: senza cookie — .*_id vuoto o assente.*disableCookies.*hasCookies\(\) del tracker falso/.test(d)), m.details.join(' | '));
  assert.ok(m.unverifiable?.some((u) => /IP/.test(u)) && m.unverifiable.some((u) => /conservazione/.test(u)) && m.unverifiable.some((u) => /incroci/.test(u)) && m.unverifiable.some((u) => /titolarità/.test(u)));
  // priorità dalla chiave dedicata in norme.yaml: "bassa" dalla 0.1.3 (analytics di prima parte senza cookie)
  const { loadNorms } = await import('../src/rules/engine.js');
  const n = loadNorms().file.regole!['richiesta-tracker-prima-del-consenso'] as { gravita: string; primaParteSenzaCookie?: { gravita: string } };
  assert.equal(n.primaParteSenzaCookie?.gravita, 'bassa');
  assert.equal(m.severity, 'bassa');
  assert.doesNotMatch(texts(m), /\b(tecnico|esente)\b/);
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  assert.match(html, /Condizioni rilevanti non verificabili dal browser/);
  const own = section(html, new RegExp(`${MATOMO}:\\d+ — strumenti di tracciamento sul dominio del sito`));
  assert.match(own, /<th>Cookie<\/th>/);
  assert.match(own, /<td>senza cookie<\/td>/);
  const sint = html.slice(html.indexOf('<h2>1. Sintesi'), html.indexOf('<h2>2. Perimetro'));
  // priorità bassa: resta un rilievo ma non è tra i fatti principali della sintesi (solo alta e media)
  assert.doesNotMatch(sint, /Matomo di prima parte, senza cookie/);
});

test('fix 6: Matomo senza cookie riconosciuto anche senza disableCookies (hasCookies falso)', () => {
  const m = of(SPOTIFY).find((f) => f.ruleId === 'richiesta-tracker-prima-del-consenso' && (f.subjects ?? []).includes('Matomo'))!;
  assert.ok(m);
  assert.match(m.ruleTitle, /in modalità senza cookie/);
  const st = m.details.find((d) => d.startsWith('Stato dei cookie di Matomo'))!;
  assert.match(st, /senza cookie/);
  assert.doesNotMatch(st, /disableCookies/);
  assert.match(st, /hasCookies\(\) del tracker falso/);
});

test('fix 6: stato dei cookie di Matomo dai fatti: con cookie, non determinabile, dati utente negli hit', async () => {
  const { matomoCookieMode, paqCommands } = await import('../src/classify/firstparty.js');
  const hit = (q: string) => ({ url: `https://www.esempio.it/matomo.php?idsite=1&rec=1${q}`, method: 'POST', tracker: { company: 'Matomo', category: 'statistica' }, party: 'prima' });
  const s = (over: object) => ({ cookies: [], requests: [hit('&_id=')], statsProbe: [{ url: 'x', paq: ['disableCookies'], hasCookies: null, source: 'pagina' }], ...over }) as never;
  assert.equal(matomoCookieMode([s({})]).state, 'senza-cookie');
  assert.equal(matomoCookieMode([s({ cookies: [{ name: '_pk_id.1.ab12' }] })]).state, 'con-cookie');
  assert.equal(matomoCookieMode([s({ requests: [hit('&_id=0123456789abcdef')] })]).state, 'non-determinabile');
  assert.equal(matomoCookieMode([s({ statsProbe: undefined })]).state, 'non-determinabile');
  assert.deepEqual(matomoCookieMode([s({ requests: [hit('&_id=&uid=mario%40esempio.it&dimension1=abc&dimension2=')] })]).userData, ['uid (in 1 hit)', 'dimension1 (in 1 hit)']);
  assert.deepEqual(paqCommands('var _paq=[];_paq.push(["disableCookies"]); _paq.push([\'trackPageView\']);'), ['disableCookies', 'trackPageView']);
});

test('fix 7: informativa senza tabelle letta come dichiarazione testuale e confrontata per fornitore', () => {
  const dati = JSON.parse(readFileSync(join(result.runDir, 'dati.json'), 'utf8')) as { declared: import('../src/types.js').DeclaredSet[] };
  const d = dati.declared.find((x) => x.site.includes(MATOMO))!;
  assert.equal(d.source, null);
  assert.match(d.policy?.url ?? '', /\/privacy-policy\/$/);
  assert.equal(d.policy?.how, 'link con rel="privacy-policy"');
  assert.ok(d.textual, d.note);
  assert.deepEqual(d.textual!.vendors.map((v) => v.name), ['Matomo']);
  assert.match(d.textual!.vendors[0].quote, /Matomo Analytics/);
  assert.ok(d.textual!.vendors[0].quote.length <= 200);
  assert.deepEqual(d.textual!.claims.map((c) => c.claim), ['solo-tecnici']);
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  assert.match(html, /testuale \(1 fornitore citato\)/);
  const cmp = section(html, new RegExp(`${MATOMO}:\\d+ — confronto testuale con l'informativa`));
  assert.match(cmp, /<td>Matomo<\/td><td>osservato e citato<\/td><td>[^<]*osservato senza cookie<\/td>/);
  assert.match(cmp, /Affermazione &quot;solo cookie tecnici&quot;: nessun cookie o storage non tecnico osservato/);
  assert.match(readFileSync(join(result.runDir, 'confronto-testuale.csv'), 'utf8'), /Matomo;osservato e citato/);
  assert.ok(!of(MATOMO).some((f) => f.ruleId === 'informativa-assente'));
});

test('fix 7: nessuna informativa raggiungibile e nessun banner: rilievo informativa-assente con i percorsi e i 404', () => {
  const f = of(SPOTIFY).find((x) => x.ruleId === 'informativa-assente');
  assert.ok(f, of(SPOTIFY).map((x) => x.ruleId).join(', '));
  assert.equal(f.severity, 'media');
  assert.ok(f.norms.some((n) => n.key === 'gdpr13') && f.norms.some((n) => n.key === 'garante2021'));
  for (const p of ['/privacy-policy/', '/cookie-policy/', '/privacy/']) assert.ok(f.details.some((d) => d.includes(`${p} — percorso comune: 404`)), `${p}: ${f.details.join(' | ')}`);
  assert.match(f.description, /\/privacy-policy\/ 404/);
  assert.ok(f.evidence.some((e) => /pie-di-pagina\.png$/.test(e.file)), f.evidence.map((e) => e.file).join(', '));
  // il caso "banner senza link" resta dell'altra regola
  assert.ok(!of(SPOTIFY).some((x) => x.ruleId === 'link-informativa-assente'));
});

test('fix 7: estrazione testuale: sezione cookie, fornitori noti, affermazioni tipiche', async () => {
  const { extractTextual, vendorBase } = await import('../src/declared/textual.js');
  const t = extractTextual('https://www.esempio.it/privacy/', 'percorso comune', {
    full: 'Titolare. Usiamo Google Analytics per le statistiche. Cookie. Non sono utilizzati cookie di profilazione. Sono presenti cookie di terze parti di YouTube.',
    section: { title: 'Cookie', text: 'Non sono utilizzati cookie di profilazione. Sono presenti cookie di terze parti di YouTube.' },
  }, ['Google', 'Meta']);
  assert.deepEqual(t!.vendors.map((v) => v.name).sort(), ['Google']);
  assert.deepEqual(t!.claims.map((c) => c.claim).sort(), ['no-profilazione', 'terze-parti']);
  assert.equal(vendorBase('Spotify (contenuto incorporato)'), 'Spotify');
  assert.equal(vendorBase('Piwik'), 'Matomo');
  assert.equal(extractTextual('u', 'h', { full: 'Pagina senza informazioni.', section: null }, []), null);
});

// --- 0.1.3: correzioni dopo la verifica di una rilevazione su un sito senza banner con un lettore Spotify incorporato ---

test('0.1.3: categorie diverse tra gli elementi dello stesso fornitore dette una per una', () => {
  const ck = of(SPOTIFY).find((f) => f.ruleId === 'cookie-prima-del-consenso' && (f.subjects ?? []).includes('Spotify (contenuto incorporato)'))!;
  assert.match(ck.description, /Categorie: [^.]*marketing\/pubblicità \(sp_t\)[^.]*statistica \(sp_landing\)[^.]*registrazione sessioni\/heatmap \(sentryReplaySession\)/);
  assert.doesNotMatch(ck.description, /Categoria: marketing/);
});

test('0.1.3: Sentry con elementi replay_* nell\'envelope classificato come registrazione della sessione', async () => {
  const reqs = result.sessions.filter((s) => s.site.includes(SPOTIFY)).flatMap((s) => s.requests).filter((r) => r.host.endsWith('sentry.io'));
  assert.ok(reqs.length);
  for (const r of reqs) {
    assert.deepEqual(r.envelopeItems, ['replay_event']);
    assert.equal(r.tracker?.category, 'registrazione-sessioni');
    assert.match(r.purpose ?? '', /Session Replay.*caricato da Spotify/);
  }
  const { isSentryReplay } = await import('../src/classify/enrich.js');
  assert.equal(isSentryReplay({ host: 'o1.ingest.us.sentry.io', envelopeItems: ['event'] }), false);
  assert.equal(isSentryReplay({ host: 'o1.ingest.sentry.io', envelopeItems: ['replay_recording'] }), true);
  assert.equal(isSentryReplay({ host: 'esempio.it', envelopeItems: ['replay_event'] }), false);
});

test('0.1.3: nessun banner accorpato in sintesi al punto sui tracciamenti dello stesso sito', () => {
  const ba = of(SPOTIFY).find((f) => f.ruleId === 'banner-assente')!;
  assert.ok(ba);
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  const sint = html.slice(html.indexOf('<h2>1. Sintesi'), html.indexOf('<h2>2. Perimetro'));
  assert.doesNotMatch(sint, /Nessun banner di consenso, pur in presenza di tracciamenti/);
  assert.ok(sint.split('<li>').some((li) => /senza alcun meccanismo di consenso/.test(li) && li.includes(`#${ba.id}"`)), sint);
});

test('0.1.3: media per sessione accanto ai totali', async () => {
  const { perSession } = await import('../src/rules/helpers.js');
  const r = (n: number) => ({ n }) as never;
  const a = [r(1), r(2), r(3), r(4)];
  const ss = [{ requests: [a[0], a[1]] }, { requests: [a[2], a[3]] }, { requests: [] }] as never;
  assert.equal(perSession(a, ss), ' (in 2 sessioni, in media 2 per sessione)');
  assert.equal(perSession(a.slice(0, 2), ss), '');
});

test('0.1.3: Google Fonts e Gravatar caricati dalle pagine: rilievo informativo sull\'IP inviato a terzi', () => {
  const f = of(MATOMO).find((x) => x.ruleId === 'ip-a-terze-parti');
  assert.ok(f, of(MATOMO).map((x) => x.ruleId).join(' | '));
  assert.equal(f.severity, 'informativa');
  assert.ok(f.details.some((d) => /^Gravatar \(Automattic\): .*secure\.gravatar\.com/.test(d)), f.details.join(' | '));
  // le risorse dei contenuti incorporati non contano
  assert.ok(!of(SPOTIFY).some((x) => x.ruleId === 'ip-a-terze-parti' && x.details.some((d) => /spotify/i.test(d))));
});

test('0.1.3: senza banner e con il solo Matomo di prima parte senza cookie, "nessun banner" è informativo', () => {
  const ba = of(MATOMO).find((f) => f.ruleId === 'banner-assente')!;
  assert.ok(ba);
  assert.equal(ba.severity, 'informativa');
  assert.equal(ba.headline, undefined);
  assert.match(ba.description, /Matomo di prima parte in modalità senza cookie/);
  // con un lettore che scrive identificativi resta "media"
  const sp = of(SPOTIFY).find((f) => f.ruleId === 'banner-assente')!;
  assert.equal(sp.severity, 'media');
});
