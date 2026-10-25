import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
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
    browser: { hostResolverRules: 'MAP * 127.0.0.1', userAgentSuffix: 'ScookieAudit/test', servizioUscita: url('trace.test', '/cdn-cgi/trace') },
    protocollo: { attesaDopoCaricamento: 300, attesaDopoScroll: 200, attesaDopoScelta: 800, pausaTraSessioni: 0, timeoutNavigazione: 15000 },
    scenari: { modalita: 'percorso', pagineDopoScelta: 2 },
    campionamento: { perTipo: 1, maxPagine: 4, esplorazione: { sePaginaMeno: 0 } },
    trackerExtra: join(FIXTURES, 'tracker-test.yaml'),
    siti: [
      { url: url('sito-a.test') },
      { url: url('www.sito-b.test'), sitemap: false },
      { url: url('shop.sito-b.test'), sitemap: false, banner: { attesa: 1500 } },
      { url: url('sito-c.test'), sitemap: false },
      { url: url('sito-e.test'), sitemap: false, seguiLink: false },
      { url: url('sito-f.test'), sitemap: false, seguiLink: false, banner: { attesa: 1500 } },
      { url: url('sito-g.test'), sitemap: false, seguiLink: false, banner: { attesa: 2000 } },
      { url: url('sito-h.test'), sitemap: false, seguiLink: false, banner: { attesa: 1000 } },
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
  assert.match(r.interaction.detail, /"Personalizza".*"Rifiuta tutti"/);
  assert.ok(r.cookies.some((c) => c.name === 'pref' && c.valuePreview === 'no'));
  assert.ok(rules('sito-e.test').includes('rifiuto-non-al-primo-livello'));
});

test('sito-f: tracciamento attivato dallo scroll distinto dal caricamento', () => {
  const s = session('sito-f.test', 'nessuna-azione');
  assert.equal(s.cookies.find((c) => c.name === '_ga')?.stage, 'scroll');
  assert.equal(s.cookies.find((c) => c.name === 'tecnico_f')?.stage, 'caricamento');
  const f = result.findings.find((x) => x.site.includes('sito-f.test') && x.ruleId === 'cookie-prima-del-consenso')!;
  assert.match(f.description, /solo dopo lo scroll/);
  const t = result.findings.find((x) => x.site.includes('sito-f.test') && x.ruleId === 'richiesta-tracker-prima-del-consenso')!;
  assert.match(t.description, /solo dopo lo scroll/);
  // sito-a invece traccia già al caricamento
  const a = result.findings.find((x) => x.site.includes('sito-a.test') && x.ruleId === 'cookie-prima-del-consenso')!;
  assert.match(a.description, /già al caricamento/);
});

test('sito-a: dati personali verso terzi, mascherati nel report e nei dati', () => {
  const f = result.findings.find((x) => x.ruleId === 'dati-personali-a-terzi' && x.site.includes('sito-a.test'))!;
  assert.equal(f.severity, 'alta');
  assert.ok(f.details.some((d) => /targa: ZZ•••ZZ/.test(d)), f.details.join(' | '));
  for (const file of ['report.html', 'dati.json', 'richieste.csv']) {
    const text = readFileSync(join(result.runDir, file), 'utf8');
    assert.ok(!text.includes('ZZ999ZZ') && !decodeURIComponent(text.replace(/%(?![0-9A-F]{2})/gi, '%25')).includes('ZZ999ZZ'), `${file} non deve contenere la targa in chiaro`);
  }
});

test('sito-a: elementi non classificati segnalati invece di restare invisibili', () => {
  const f = result.findings.find((x) => x.site.includes('sito-a.test') && x.ruleId === 'elementi-non-classificati');
  assert.ok(f);
  assert.ok(f.details.some((d) => d.includes('xyz_misterioso')));
  assert.ok(f.details.some((d) => d.includes('widget.ignoto.example')));
  assert.ok(!f.details.some((d) => d.includes('pixel.adtest.example')), 'i tracker classificati non compaiono');
});

test('sito-g: vanilla-cookieconsent v2 e ripetizione della sessione se lo script del banner non si carica', () => {
  const r = session('sito-g.test', 'rifiuta').interaction;
  assert.equal(r.method, 'adattatore:vanilla-cookieconsent');
  assert.equal(r.layer, 'primo-livello');
  assert.equal(r.verification, 'verificato');
  assert.equal(session('sito-g.test', 'accetta').interaction.verification, 'verificato');
  const first = session('sito-g.test', 'nessuna-azione');
  assert.ok(first.retryOf, 'la prima sessione senza banner è stata ripetuta');
  assert.equal(first.interaction.bannerVisibleBefore, true);
  const dati = JSON.parse(readFileSync(join(result.runDir, 'dati.json'), 'utf8')) as { sessioniScartate: { id: string; requests: { host: string; failure?: string }[] }[] };
  const scartata = dati.sessioniScartate.find((s) => s.id === first.retryOf)!;
  assert.ok(scartata.requests.some((q) => q.host === 'cdn.flaky.example' && q.failure));
  assert.ok(!rules('sito-g.test').includes('banner-intermittente'));
  assert.ok(!rules('sito-g.test').includes('banner-assente'));
});

test('analisi del banner: comandi, categorie pre-attivate, informativa, revoca', () => {
  const e = result.sessions.find((s) => s.site.includes('sito-e.test') && s.bannerAnalysis)!.bannerAnalysis!;
  assert.deepEqual(e.firstLayer.reject, []);
  assert.ok(e.firstLayer.preferences.includes('Personalizza'));
  assert.equal(e.policyLink?.text, 'Cookie policy');
  assert.equal(e.revokeLink, null);
  assert.ok(e.preferences?.toggles.some((t) => /Statistiche/.test(t.label) && t.checked && !t.disabled));
  const r = rules('sito-e.test');
  for (const id of ['categorie-preattivate', 'revoca-non-trovata', 'struttura-banner']) assert.ok(r.includes(id), id);
  const pre = result.findings.find((f) => f.ruleId === 'categorie-preattivate' && f.site.includes('sito-e.test'))!;
  assert.match(pre.description, /"Statistiche"/);
  assert.doesNotMatch(pre.description, /Necessari/);
  // OneTrust: categoria configurata ma senza interruttore nel centro preferenze
  const np = result.findings.find((f) => f.ruleId === 'categorie-non-presentate' && f.site.includes('www.sito-b.test'))!;
  assert.match(np.description, /"Cookie funzionali" \(1 elemento\)/);
  assert.equal(session('www.sito-b.test', 'accetta').interaction.verification === 'incoerente', false, 'categoria non presentata: non è un consenso incoerente');
  // Dynatrace dichiarato tecnico ma attivo solo dopo l'accettazione
  const dt = result.findings.find((f) => f.ruleId === 'tecnico-solo-dopo-consenso' && f.site.includes('www.sito-b.test'))!;
  assert.match(dt.headline ?? '', /^Dynatrace: elementi dichiarati tecnici/);
  // OneTrust: link "Impostazioni cookie" nel footer
  const b = result.sessions.find((s) => s.site.includes('www.sito-b.test') && s.bannerAnalysis)!.bannerAnalysis!;
  assert.ok(b.revokeLink);
  assert.ok(!rules('www.sito-b.test').includes('revoca-non-trovata'));
  // sito-a: nessun link all'informativa nel banner
  assert.ok(rules('sito-a.test').includes('link-informativa-assente'));
  // sito-a: evidenza dei comandi misurata (pulsante verde contro link piccolo)
  const pa = result.sessions.find((s) => s.site.includes('sito-a.test') && s.bannerAnalysis)!.bannerAnalysis!.prominence!;
  assert.equal(pa.accept?.kind, 'pulsante');
  assert.equal(pa.accept?.background, '#2e7d32');
  assert.equal(pa.reject?.kind, 'link');
  assert.ok((pa.accept!.width * pa.accept!.height) > 3 * (pa.reject!.width * pa.reject!.height));
  const sa = result.findings.find((f) => f.ruleId === 'evidenza-asimmetrica' && f.site.includes('sito-a.test'))!;
  assert.equal(sa.severity, 'media');
  assert.match(sa.description, /"Accetta tutti" è un pulsante con sfondo pieno #2e7d32 .*del banner; "Rifiuta" è un link senza sfondo/);
  assert.ok(!/contrasto/.test(sa.description), 'il contrasto resta solo nei dettagli');
});

test('sito-e: elenco dichiarato ricavato dalle tabelle della cookie policy', () => {
  const dati = JSON.parse(readFileSync(join(result.runDir, 'dati.json'), 'utf8')) as { declared: { site: string; source: string; items: { name: string; category: string }[] }[] };
  const d = dati.declared.find((x) => x.site.includes('sito-e.test'))!;
  assert.match(d.source, /cookie policy/);
  assert.deepEqual(d.items.map((i) => [i.name, i.category]), [['pref', 'tecnico'], ['_ga', 'statistica']]);
});

test('scenario personalizza: rispettato su vanilla-cookieconsent, violato su OneTrust di prova', () => {
  const g = session('sito-g.test', 'personalizza').interaction;
  assert.equal(g.method, 'adattatore:vanilla-cookieconsent');
  assert.equal(g.verification, 'verificato');
  assert.ok(!rules('sito-g.test').includes('personalizzazione-non-rispettata'));
  const b = session('www.sito-b.test', 'personalizza').interaction;
  assert.equal(b.method, 'adattatore:onetrust');
  assert.equal(b.verification, 'verificato', b.verificationDetail);
  const f = result.findings.find((x) => x.ruleId === 'personalizzazione-non-rispettata' && x.site.includes('www.sito-b.test'));
  assert.ok(f, 'pixel pubblicitario con la sola statistica');
  assert.match(f.description, /AdTest/);
  // CMP senza supporto affidabile: scenario dichiarato non eseguibile
  // banner senza preferenze: la scelta per categoria non è possibile
  assert.match(session('sito-a.test', 'personalizza').interaction.detail, /preferenze non trovato/);
  // banner sconosciuto con preferenze: scelta eseguita dall'interfaccia
  const e = session('sito-e.test', 'personalizza').interaction;
  assert.equal(e.method, 'euristica');
  assert.equal(e.outcome, 'eseguito');
  assert.match(e.detail, /"Personalizza".*"Salva preferenze"/);
});

test('scenario revoca: link nel footer e cookie rimasti; sito senza modo di revocare', () => {
  const b = session('www.sito-b.test', 'revoca');
  assert.equal(b.revocation?.outcome, 'eseguita');
  assert.match(b.revocation!.how, /Impostazioni cookie/);
  assert.ok(b.revocation!.remaining.some((c) => c.startsWith('_ga')));
  assert.ok(!rules('www.sito-b.test').includes('attivazione-dopo-revoca'));
  assert.ok(result.findings.some((f) => f.ruleId === 'esito-revoca' && f.site.includes('www.sito-b.test')));
  const a = session('sito-a.test', 'revoca');
  assert.equal(a.revocation?.outcome, 'non-trovata');
  assert.ok(result.findings.some((f) => f.ruleId === 'esito-revoca' && f.site.includes('sito-a.test') && /non è stato trovato/.test(f.headline ?? '')));
});

test('sito-h: pagina di verifica anti-bot riconosciuta, sessioni non valide e nessuna criticità sul sito', () => {
  const ss = result.sessions.filter((s) => s.site.includes('sito-h.test'));
  assert.ok(ss.length >= 3);
  assert.ok(ss.every((s) => s.blocked?.provider === 'Cloudflare'));
  assert.ok(!ss.some((s) => s.retryOf), 'nessuna ripetizione delle sessioni bloccate');
  const r = rules('sito-h.test');
  assert.deepEqual(r, ['accesso-bloccato']);
});

test('paese di uscita verificato e registrato nel manifest', () => {
  const m = JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8')) as { ambiente: { uscita: { verified: boolean; country: string; matches: boolean } } };
  assert.equal(m.ambiente.uscita.verified, true);
  assert.equal(m.ambiente.uscita.country, 'IT');
  assert.equal(m.ambiente.uscita.matches, true);
  assert.match(readFileSync(join(result.runDir, 'report.html'), 'utf8'), /rilevato <strong>IT<\/strong>/);
});

test('output: report, dati, evidenze con hash verificabili', () => {
  for (const f of ['report.html', 'report.pdf', 'manifest.json', 'manifest.json.sha256', 'dati.json', 'cookie.csv', 'richieste.csv', 'criticita.csv', 'confronto-dichiarati.csv']) {
    assert.ok(existsSync(join(result.runDir, f)), f);
  }
  const manifest = JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8')) as { file: { path: string; sha256: string }[] };
  // HAR compressi; quelli delle sessioni non citate nelle schede senza corpi delle risposte
  const hars = manifest.file.filter((f) => f.path.endsWith('.har.gz'));
  assert.ok(hars.length && !manifest.file.some((f) => f.path.endsWith('.har')));
  const cited = new Set(result.findings.flatMap((f) => f.evidence.map((e) => e.file)));
  const uncited = hars.find((f) => !cited.has(f.path))!;
  const log = JSON.parse(gunzipSync(readFileSync(join(result.runDir, uncited.path))).toString('utf8')) as { log: { entries: { response: { content: { text?: string } } }[] } };
  assert.ok(log.log.entries.length && log.log.entries.every((e) => e.response.content.text === undefined));
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
