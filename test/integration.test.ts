import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config/load.js';
import { runAudit, type RunResult } from '../src/run.js';
import type { Finding } from '../src/types.js';
import { FIXTURES, startFixtureServer } from './fixtures/server.js';

let srv: Awaited<ReturnType<typeof startFixtureServer>>;
let result: RunResult;
const url = (host: string, path = '/') => `http://${host}:${srv.port}${path}`;
const bySite = (host: string) => (f: Finding) => f.site.includes(host);
const rules = (host: string) => result.findings.filter(bySite(host)).map((f) => f.ruleId);
const session = (host: string, scenario: string) => result.sessions.find((s) => s.site.includes(host) && s.scenario === scenario)!;

before(async () => {
  srv = await startFixtureServer();
  const dir = mkdtempSync(join(tmpdir(), 'scookie-test-'));
  const config = {
    cliente: 'Cliente di prova',
    output: join(dir, 'runs'),
    browser: { hostResolverRules: 'MAP * 127.0.0.1', userAgentSuffix: 'ScookieAudit/test' },
    protocollo: { attesaDopoCaricamento: 300, attesaDopoScroll: 200, attesaDopoScelta: 800, pausaTraSessioni: 0, timeoutNavigazione: 15000 },
    scenari: { modalita: 'percorso', pagineDopoScelta: 2 },
    campionamento: { perTipo: 1, maxPagine: 4 },
    trackerExtra: join(FIXTURES, 'tracker-test.yaml'),
    siti: [
      { url: url('sito-a.test') },
      { url: url('www.sito-b.test'), sitemap: false },
      { url: url('shop.sito-b.test'), sitemap: false, banner: { attesa: 1500 } },
      { url: url('sito-c.test'), sitemap: false },
      { url: url('sito-e.test'), sitemap: false, seguiLink: false },
      { url: url('sito-d.test'), sitemap: false, dichiarati: join(FIXTURES, 'dichiarati-sito-d.csv'), cookiePolicy: url('www.sito-b.test', '/cookie-policy') },
    ],
  };
  const cfgPath = join(dir, 'config.yaml');
  writeFileSync(cfgPath, stringify(config));
  result = await runAudit(loadConfig(cfgPath), { log: () => {} });
});

after(async () => {
  await srv?.close();
});

test('sito-a: banner sconosciuto gestito con l\'euristica', () => {
  const r = session('sito-a.test', 'rifiuta').interaction;
  assert.equal(r.method, 'euristica');
  assert.equal(r.layer, 'primo-livello');
  assert.match(r.detail, /"Rifiuta"/);
  assert.equal(session('sito-a.test', 'accetta').interaction.method, 'euristica');
});

test('sito-a: campione da robots.txt e sitemap, PDF escluso', () => {
  const pages = result.sessions.filter((s) => s.site.includes('sito-a.test') && s.scenario === 'nessuna-azione').map((s) => s.pages[0]);
  assert.ok(pages.some((p) => p.includes('/prodotti/')));
  assert.ok(pages.some((p) => p.includes('/blog/')));
  assert.ok(!pages.some((p) => p.endsWith('.pdf')));
  const d = (JSON.parse(readFileSync(join(result.runDir, 'dati.json'), 'utf8')).discovery as { site: string; sitemapUrls: string[]; sample: { source: string }[] }[]).find((x) => x.site.includes('sito-a.test'))!;
  assert.equal(d.sitemapUrls.length, 1, 'sitemap letta da robots.txt');
  assert.ok(d.sample.some((p) => p.source === 'sitemap'));
});

test('sito-a: tracciamenti prima della scelta e dopo il rifiuto', () => {
  const r = rules('sito-a.test');
  assert.ok(r.includes('cookie-prima-del-consenso'), 'cookie _ga prima della scelta');
  assert.ok(r.includes('richiesta-tracker-prima-del-consenso'), 'pixel AdTest prima della scelta');
  assert.ok(r.includes('consent-mode-senza-consenso'), 'ping gcs=G100');
  const after = result.findings.find((f) => f.site.includes('sito-a.test') && f.ruleId === 'attivazione-dopo-rifiuto');
  assert.ok(after, 'registrazione sessioni dopo il rifiuto');
  assert.match(after.description, /SessionTest|Hotjar/);
  const rej = session('sito-a.test', 'rifiuta');
  assert.ok(rej.cookies.some((c) => c.name === '_hjSessionUser_1' && c.phase === 'dopo'));
  assert.ok(rej.pages.length >= 3, 'navigazione di altre pagine dopo la scelta');
});

test('www.sito-b: adattatore OneTrust, rifiuto solo al secondo livello, stato verificato', () => {
  const r = session('www.sito-b.test', 'rifiuta').interaction;
  assert.deepEqual(r.detectedCmps.includes('OneTrust'), true);
  assert.equal(r.method, 'adattatore:onetrust');
  assert.equal(r.layer, 'secondo-livello');
  assert.equal(r.verification, 'verificato');
  assert.ok(rules('www.sito-b.test').includes('rifiuto-non-al-primo-livello'));
  assert.ok(!rules('www.sito-b.test').includes('attivazione-dopo-rifiuto'));
  assert.equal(session('www.sito-b.test', 'accetta').interaction.verification, 'verificato');
});

test('www.sito-b: confronto con elenco dichiarato da GetDomainData', () => {
  const comp = JSON.parse(readFileSync(join(result.runDir, 'dati.json'), 'utf8')).comparison as { site: string; name: string; status: string; categoryIssue: string | null }[];
  const b = comp.filter((c) => c.site.includes('www.sito-b.test'));
  assert.equal(b.find((c) => c.name === '_ga_ABC123')?.status, 'dichiarato', 'pattern _ga_xxxxxxxxxx');
  assert.equal(b.find((c) => c.name === '_fbp')?.status, 'non-dichiarato');
  assert.equal(b.find((c) => c.name === '_vecchio_cookie')?.status, 'dichiarato-non-osservato');
  assert.equal(b.find((c) => c.name === '_hjSessionUser_42')?.categoryIssue, 'incoerente');
  const r = rules('www.sito-b.test');
  for (const id of ['elementi-non-dichiarati', 'dichiarati-non-osservati', 'categoria-incoerente', 'endpoint-server-side', 'cookie-prima-del-consenso']) {
    assert.ok(r.includes(id), id);
  }
});

test('shop.sito-b: sottodominio senza banner', () => {
  assert.ok(rules('shop.sito-b.test').includes('banner-assente'));
  const f = result.findings.find((x) => x.ruleId === 'sottodomini-disomogenei' && x.site === 'sito-b.test');
  assert.ok(f, 'disomogeneità tra www e shop');
});

test('sito-c: banner in shadow DOM, rifiuto rispettato', () => {
  const r = session('sito-c.test', 'rifiuta').interaction;
  assert.equal(r.method, 'euristica');
  assert.equal(r.outcome, 'eseguito');
  assert.match(r.detail, /Rifiuta tutti/);
  assert.ok(!rules('sito-c.test').some((id) => ['attivazione-dopo-rifiuto', 'cookie-prima-del-consenso', 'richiesta-tracker-prima-del-consenso'].includes(id)));
  const acc = session('sito-c.test', 'accetta');
  assert.ok(acc.cookies.some((c) => c.name === '_ga' && c.phase === 'dopo'));
});

test('sito-d: banner in iframe, elenco dichiarato da file, policy su altro host', () => {
  const r = session('sito-d.test', 'rifiuta').interaction;
  assert.equal(r.method, 'euristica');
  assert.match(r.detail, /Solo necessari/);
  assert.ok(rules('sito-d.test').includes('dichiarati-non-osservati'));
  assert.ok(result.findings.some((f) => f.ruleId === 'sottodomini-disomogenei' && f.site.includes('sito-d.test')));
});

test('sito-e: euristica al secondo livello sceglie "Rifiuta tutti" nelle preferenze', () => {
  const r = session('sito-e.test', 'rifiuta');
  assert.equal(r.interaction.method, 'euristica');
  assert.equal(r.interaction.layer, 'secondo-livello');
  assert.match(r.interaction.detail, /"Personalizza" e poi su "Rifiuta tutti"/);
  assert.ok(r.cookies.some((c) => c.name === 'pref' && c.valuePreview === 'no'));
  assert.ok(rules('sito-e.test').includes('rifiuto-non-al-primo-livello'));
});

test('output: report, dati, evidenze con hash verificabili', () => {
  for (const f of ['report.html', 'report.pdf', 'manifest.json', 'manifest.json.sha256', 'dati.json', 'cookie.csv', 'richieste.csv', 'criticita.csv', 'confronto-dichiarati.csv']) {
    assert.ok(existsSync(join(result.runDir, f)), f);
  }
  const manifest = JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8')) as { file: { path: string; sha256: string }[] };
  assert.ok(manifest.file.some((f) => f.path.endsWith('.har')));
  for (const f of manifest.file) {
    const h = createHash('sha256').update(readFileSync(join(result.runDir, f.path))).digest('hex');
    assert.equal(h, f.sha256, f.path);
  }
  // le evidenze delle criticità richiamano il numero della criticità
  const withShot = result.findings.find((f) => f.evidence.some((e) => e.file.endsWith('.png')))!;
  assert.ok(withShot.evidence.some((e) => e.file.includes(`${withShot.id}_`)));
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  assert.match(html, /Perimetro e metodo/);
  assert.match(html, new RegExp(withShot.id));
});
