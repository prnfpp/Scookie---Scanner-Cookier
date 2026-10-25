import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { stringify } from 'yaml';
import type { Collector } from '../src/browser/collector.js';
import { manualJourney } from '../src/browser/manual.js';
import { loadConfig } from '../src/config/load.js';
import { recordingFile, runAudit, type RunResult } from '../src/run.js';
import { FIXTURES, startFixtureServer } from './fixtures/server.js';

let srv: Awaited<ReturnType<typeof startFixtureServer>>;
let result: RunResult;
let cfgPath: string;
const logs: string[] = [];
const url = (host: string, path = '/') => `http://${host}:${srv.port}${path}`;

before(async () => {
  srv = await startFixtureServer();
  const dir = mkdtempSync(join(tmpdir(), 'scookie-manuale-'));
  const config = {
    cliente: 'Prova navigazione manuale',
    output: join(dir, 'runs'),
    browser: { hostResolverRules: 'MAP * 127.0.0.1', verificaUscita: 'no' },
    protocollo: { attesaDopoCaricamento: 300, attesaDopoScroll: 200, attesaDopoScelta: 800, pausaTraSessioni: 0, timeoutNavigazione: 15000 },
    scenari: { attivi: ['nessuna-azione'], ripetizioni: 2 },
    report: { pdf: false },
    trackerExtra: join(FIXTURES, 'tracker-test.yaml'),
    siti: [
      // sito irraggiungibile (porta chiusa): nessuna criticità deve nascere da sessioni senza pagine
      { url: 'http://spento.test:1/', sitemap: false, seguiLink: false, esplora: 'no' },
      {
        url: url('sito-a.test'),
        soloPagineExtra: true,
        navigazioneManuale: { istruzioni: 'Apri la scheda del prodotto Alfa', scenari: ['rifiuta'], maxMinuti: 2 },
      },
    ],
  };
  cfgPath = join(dir, 'config.yaml');
  writeFileSync(cfgPath, stringify(config));
  // L'operatore simulato: controlla il riquadro, naviga e preme "Ho finito"
  result = await runAudit(loadConfig(cfgPath), {
    log: (m) => logs.push(m),
    manualDriver: async (page) => {
      await page.locator('#scookie-operatore').waitFor({ state: 'attached', timeout: 10000 });
      // azioni vere (clic e campo compilato): vengono registrate per rigiocarle nelle esecuzioni successive
      await page.click('nav >> text=Alfa');
      await page.fill('input[name="targa"]', 'AA123BB');
      await page.locator('input[name="targa"]').blur();
      await page.click('#calcola');
      await page.waitForURL(/beta\.html/);
      await page.waitForTimeout(1500);
      await page.locator('#scookie-operatore >> text=Ho finito').click();
    },
  });
});

after(async () => {
  await srv?.close();
});

test('navigazione manuale: registrata come una sessione, con le pagine percorse dall\'operatore', () => {
  const s = result.sessions.find((x) => x.manual)!;
  assert.ok(s, 'sessione manuale presente');
  assert.equal(s.scenario, 'rifiuta');
  assert.equal(s.interaction.outcome, 'eseguito');
  assert.equal(s.manual!.endedBy, 'operatore');
  assert.ok(s.manual!.pages.some((p) => p.endsWith('/prodotti/alfa.html')), s.manual!.pages.join(', '));
  // il tracciamento dopo il rifiuto durante la navigazione manuale è rilevato come nelle sessioni automatiche
  assert.ok(result.findings.some((f) => f.ruleId === 'attivazione-dopo-rifiuto' && f.scenario === 'rifiuta'));
  const html = readFileSync(join(result.runDir, 'report.html'), 'utf8');
  assert.match(html, /Navigazione manuale<\/strong> — sessione .*-manuale, scenario "rifiuta", conclusa dall'operatore/);
});

test('navigazioni manuali eseguite prima delle sessioni automatiche', () => {
  const iManual = logs.findIndex((l) => /Navigazioni manuali \(1\)/.test(l));
  const iAuto = logs.findIndex((l) => /sessioni automatiche/.test(l));
  assert.ok(iManual >= 0 && iAuto > iManual, logs.join('\n'));
});

test('sito irraggiungibile: sessioni non valide, nessuna criticità, avviso nel report', () => {
  const ss = result.sessions.filter((x) => x.site.includes('spento.test'));
  assert.ok(ss.length && ss.every((x) => x.unreachable));
  assert.ok(!result.findings.some((f) => f.sites.some((x) => x.includes('spento.test'))));
  assert.match(readFileSync(join(result.runDir, 'report.html'), 'utf8'), /Pagine non caricate\.<\/strong>/);
  assert.match(readFileSync(join(result.runDir, 'report.html'), 'utf8'), /Nessun dato per spento\.test/);
});

test('ripetizioni: ogni scenario due volte, le schede dicono in quante è stato osservato', () => {
  const a = result.sessions.filter((x) => x.site.includes('sito-a.test') && x.scenario === 'nessuna-azione');
  assert.deepEqual(a.map((x) => x.repeat).sort(), [1, 2]);
  const f = result.findings.find((x) => x.ruleId === 'cookie-prima-del-consenso' && x.site.includes('sito-a.test'))!;
  assert.equal(f.repeats?.seen, 2);
  assert.equal(f.repeats?.of, 2);
  assert.ok(!f.repeats?.manual);
  assert.match(readFileSync(join(result.runDir, 'report.html'), 'utf8'), /Osservato in 2 su 2 esecuzioni/);
});

test('riquadro "Ho finito": formattato e cliccabile con CSP restrittiva e finestra modale del sito', async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    await ctx.route('http://csp.test/**', (r) =>
      r.fulfill({
        contentType: 'text/html',
        headers: { 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; require-trusted-types-for 'script'" },
        body: '<!doctype html><body><h1>CSP</h1><dialog id=d><p>Modale</p></dialog><script>document.getElementById("d").showModal()</script></body>',
      }),
    );
    const page = await ctx.newPage();
    await page.goto('http://csp.test/');
    let external: (() => void) | null = null;
    const collector = { snapshot: async () => {}, currentUrl: '' } as unknown as Collector;
    const journey = manualJourney(page, collector, { instructions: 'Prova <b>fittizia</b>', maxMs: 30000 }, undefined, (f) => (external = f ?? external));
    const btn = page.locator('#scookie-operatore >> text=Ho finito');
    await btn.waitFor();
    assert.equal(await btn.evaluate((b) => getComputedStyle(b).backgroundColor), 'rgb(52, 199, 89)');
    assert.ok(await page.locator('#scookie-operatore >> text=Prova <b>fittizia</b>').count(), 'istruzioni come testo');
    assert.ok(external, 'chiusura disponibile anche per l\'interfaccia');
    await btn.click({ timeout: 5000 });
    assert.equal((await journey).endedBy, 'operatore');
  } finally {
    await browser.close();
  }
});

test('percorso manuale registrato e rigiocato in automatico nella prova successiva', async () => {
  const rec = recordingFile(cfgPath, url('sito-a.test'));
  assert.ok(existsSync(rec), 'percorso salvato accanto alla configurazione');
  const path = JSON.parse(readFileSync(rec, 'utf8')) as { steps: { type: string; value?: string }[] };
  assert.deepEqual(path.steps.map((s) => s.type), ['click', 'fill', 'click']);
  assert.equal(path.steps[1].value, 'AA123BB');
  // seconda esecuzione: nessun operatore, il percorso si rigioca in ogni ripetizione
  const second = await runAudit(loadConfig(cfgPath), { log: () => {} });
  const replays = second.sessions.filter((s) => s.replay);
  assert.equal(replays.length, 2);
  assert.ok(!second.sessions.some((s) => s.manual), 'nessuna sessione manuale');
  for (const s of replays) {
    assert.equal(s.replay!.stepsDone, 3, s.replay!.stoppedAt);
    assert.ok(s.pages.some((p) => /beta\.html\?targa=/.test(p)), s.pages.join(', '));
  }
  assert.match(readFileSync(join(second.runDir, 'report.html'), 'utf8'), /Percorso registrato<\/strong>/);
});
