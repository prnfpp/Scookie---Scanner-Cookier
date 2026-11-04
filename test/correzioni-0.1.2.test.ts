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
  assert.ok(rows.some((r) => /non-applicabile \(nessun banner\)/.test(r[iEsito])));
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
