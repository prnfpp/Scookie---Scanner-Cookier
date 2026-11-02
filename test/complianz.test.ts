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

test('fix 2: analisi del banner limitata al banner, categorie del gestore, X presente', () => {
  const a = result.sessions.find((s) => s.bannerAnalysis)!.bannerAnalysis!;
  assert.deepEqual(a.firstLayer.accept, ['Accetta']);
  assert.deepEqual(a.firstLayer.reject, ['Nega']);
  assert.ok(a.firstLayer.close.length, 'X presente');
  assert.ok(!a.firstLayer.all.some((t) => /Lunedì|Mese|Norme sulla privacy|Promemoria/.test(t)), a.firstLayer.all.join(' | '));
  assert.deepEqual(a.preferences?.toggles.map((t) => [t.label, t.checked, t.disabled]), [['Funzionale', true, true], ['Statistiche', false, false], ['Marketing', false, false]]);
  assert.equal(findings('categorie-preattivate').length, 0);
  const s = findings('struttura-banner')[0];
  assert.doesNotMatch(s.description, /chiusura \(X\) assente/);
  assert.ok(!s.details.some((d) => /Lunedì/.test(d)));
});

test('fix 3: personalizza con l\'adattatore Complianz, stato verificato, video accorpato al rifiuto', () => {
  const p = session('personalizza').interaction;
  assert.equal(p.method, 'adattatore:complianz');
  assert.equal(p.verification, 'verificato', p.verificationDetail);
  assert.match(p.verificationDetail, /cmplz_statistics=allow/);
  assert.match(p.verificationDetail, /cmplz_marketing=deny/);
  assert.ok(!/Lunedì/.test(p.detail), p.detail);
  const f = findings('personalizzazione-non-rispettata').find((x) => x.subjects?.includes('VideoTest'));
  assert.ok(f, 'il video resta attivo con la sola statistica');
  assert.equal(f.severity, 'bassa');
  assert.match(p.detail, /attivazione di "Statistiche"/);
  assert.match(f.description, /stesso comportamento del rifiuto/);
  const ids = /vedi (R-\d{3}(?:, R-\d{3})*)/.exec(f.description)?.[1].split(', ') ?? [];
  assert.ok(ids.length, f.description);
  for (const id of ids) {
    const ref = result.findings.find((x) => x.id === id)!;
    assert.equal(ref.ruleId, 'attivazione-dopo-rifiuto', id);
    assert.ok(ref.subjects?.includes('VideoTest'), id);
  }
});

test('fix 4: comando di revoca trovato dopo la scelta e usato nello scenario revoca', () => {
  const rej = session('rifiuta');
  assert.match(rej.revokeAfterChoice?.text ?? '', /Gestisci consenso/);
  assert.match(rej.revokeAfterChoice?.how ?? '', /manage-consent/);
  const rev = session('revoca').revocation!;
  assert.equal(rev.outcome, 'eseguita');
  assert.equal(rev.via, 'link');
  assert.match(rev.how, /Gestisci consenso/);
  assert.equal(findings('revoca-non-trovata').length, 0);
  const s = findings('struttura-banner')[0];
  assert.match(s.description, /Modo per rivedere la scelta nella pagina: trovato, "Gestisci consenso" \(.*visibile solo dopo la scelta\)/);
});

test('fix 5: tracker di prima parte (Matomo) attivo dopo il rifiuto e dopo la X, cookie rinnovati', () => {
  const rej = session('rifiuta');
  const hits = rej.requests.filter((r) => /\/matomo\.php/.test(r.url));
  assert.ok(hits.length, 'hit a /matomo.php registrati');
  assert.ok(hits.every((r) => r.party === 'prima' && r.tracker?.company === 'Matomo' && r.tracker.category === 'statistica'));
  assert.ok(hits.some((r) => r.phase === 'dopo'));
  const pk = rej.cookies.find((c) => c.name.startsWith('_pk_id.'))!;
  assert.equal(pk.phase, 'prima');
  assert.equal(pk.presentAfterChoice, true);
  assert.ok(pk.renewals?.some((r) => r.stage === 'scelta'), 'cookie _pk_id rinnovato dopo la scelta');
  for (const rule of ['attivazione-dopo-rifiuto', 'attivazione-dopo-chiusura']) {
    const f = findings(rule).find((x) => x.subjects?.includes('Matomo'));
    assert.ok(f, `${rule}: Matomo`);
    assert.equal(f.severity, 'alta', rule);
    assert.equal(f.evidenceLevel, 'identificativo');
    assert.match(f.evidenceExtra ?? '', /dati di navigazione inviati/);
    assert.match(f.description, /riscritti? .*_pk_/);
    assert.match(f.description, /matomo|complianz-like/i);
  }
  // prima della scelta: cookie e dati inviati nello stesso rilievo, senza una scheda duplicata sulle richieste
  const before = findings('cookie-prima-del-consenso').find((x) => x.subjects?.includes('Matomo'))!;
  assert.match(before.evidenceExtra ?? '', /dati di navigazione inviati/);
  assert.ok(!findings('richiesta-tracker-prima-del-consenso').some((x) => x.subjects?.includes('Matomo')));
  // inventario: colonna "Dopo rifiuto" valorizzata per i cookie _pk_*
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  assert.match(html, /<td>_pk_id\.1\.ab12<\/td>(?:(?!<\/tr>).)*<td>rinnovato<\/td>/s);
  assert.match(html, /raccolte sul dominio del sito/);
});

test('fix 6: evento inviato dal video all\'uscita attribuito alla pagina che lo ospita, marcato "all\'uscita"', () => {
  const rej = session('rifiuta');
  const home = rej.pages[0];
  const video = rej.requests.filter((r) => r.host.startsWith('video-terzo.test') && /log_event/.test(r.url));
  const exits = video.filter((r) => /ev=uscita/.test(r.url));
  assert.ok(exits.length, 'evento di uscita registrato');
  for (const r of exits) {
    assert.equal(r.pageUrl, home, r.url);
    assert.equal(r.sentOnExit, true, r.url);
  }
  // la seconda pagina non ha video: nessuna richiesta del video le è attribuita
  assert.ok(!video.some((r) => /chi-siamo/.test(r.pageUrl)), video.map((r) => r.pageUrl).join(' '));
  const f = findings('attivazione-dopo-rifiuto').find((x) => x.subjects?.includes('VideoTest'))!;
  const pagesLine = f.details.find((d) => d.startsWith('Pagine in cui si osserva'))!;
  assert.doesNotMatch(pagesLine, /chi-siamo/);
  assert.ok(f.details.some((d) => /^Invii all'uscita dalla pagina/.test(d)), f.details.join(' | '));
});
