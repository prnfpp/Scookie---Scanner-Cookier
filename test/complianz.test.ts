import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config/load.js';
import { runAudit, type RunResult } from '../src/run.js';
import type { Finding, SessionResult } from '../src/types.js';
import { FIXTURES, startFixtureServer } from './fixtures/server.js';

/**
 * Sito con markup e cookie di Complianz, un widget di calendario di terze parti in un iframe fuori dal banner,
 * un tracker di prima parte in stile Matomo che ignora il consenso e un video incorporato che invia un evento
 * all'uscita dalla pagina.
 */
let srv: Awaited<ReturnType<typeof startFixtureServer>>;
let result: RunResult;
const HOST = 'complianz-like.test';
const url = (host: string, path = '/') => `http://${host}:${srv.port}${path}`;
const session = (scenario: string): SessionResult => result.sessions.find((s) => s.scenario === scenario && !s.attributedFrom)!;
const findings = (rule: string): Finding[] => result.findings.filter((f) => f.ruleId === rule);

before(async () => {
  srv = await startFixtureServer();
  const dir = mkdtempSync(join(tmpdir(), 'scookie-cmplz-'));
  const config = {
    cliente: 'Cliente di prova',
    output: join(dir, 'runs'),
    browser: { hostResolverRules: 'MAP * 127.0.0.1', userAgentSuffix: 'ScookieAudit/test', servizioUscita: url('trace.test', '/cdn-cgi/trace') },
    protocollo: { attesaDopoCaricamento: 600, attesaDopoScroll: 200, attesaDopoScelta: 800, pausaTraSessioni: 0, timeoutNavigazione: 15000 },
    scenari: { modalita: 'percorso', pagineDopoScelta: 1 },
    campionamento: { perTipo: 1, maxPagine: 2, esplorazione: { sePaginaMeno: 0 } },
    report: { pdf: false },
    trackerExtra: join(FIXTURES, 'tracker-test.yaml'),
    siti: [{ url: url(HOST), sitemap: false, seguiLink: false, esplora: 'no', soloPagineExtra: true, pagineExtra: [url(HOST, '/chi-siamo.html')], banner: { attesa: 2000 } }],
  };
  const cfgPath = join(dir, 'config.yaml');
  writeFileSync(cfgPath, stringify(config));
  result = await runAudit(loadConfig(cfgPath), { log: () => {} });
});

after(async () => {
  await srv?.close();
});

test('complianz: banner riconosciuto e scelte eseguite con l\'adattatore', () => {
  assert.equal(session('rifiuta').interaction.method, 'adattatore:complianz');
  assert.equal(session('accetta').interaction.method, 'adattatore:complianz');
  assert.equal(session('chiudi').interaction.layer, 'chiusura-x');
  assert.ok(session('rifiuta').pages.some((p) => p.includes('/chi-siamo')), session('rifiuta').pages.join(' '));
});

test('fix 1: dopo "Nega" e dopo la X il banner è chiuso e non ricompare alla pagina successiva', () => {
  for (const sc of ['rifiuta', 'chiudi', 'accetta']) {
    const i = session(sc).interaction;
    assert.equal(i.bannerVisibleBefore, true, sc);
    assert.equal(i.bannerVisibleAfter, false, `${sc}: ${i.verificationDetail}`);
    assert.equal(i.bannerOnNextPage, false, sc);
    assert.doesNotMatch(i.verificationDetail, /banner ancora visibile/, sc);
    assert.match(i.verificationDetail, /banner chiuso/, sc);
  }
  const x = findings('esito-chiusura-x')[0];
  assert.ok(x);
  assert.match(x.description, /il banner non ricompare/);
  assert.match(x.description, /registra un rifiuto/);
  const csv = readFileSync(join(result.runDir, 'sessioni.csv'), 'utf8');
  assert.match(csv, /banner_visibile_dopo_scelta;banner_alla_pagina_successiva/);
  for (const f of result.findings) assert.doesNotMatch([f.description, ...f.details].join(' '), /banner ancora visibile dopo la scelta/, f.id);
});
