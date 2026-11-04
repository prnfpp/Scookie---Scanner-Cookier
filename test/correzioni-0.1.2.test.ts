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
