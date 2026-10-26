import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { parse, stringify } from 'yaml';
import { startUi } from '../src/ui/server.js';
import { FIXTURES, startFixtureServer } from './fixtures/server.js';

let srv: Awaited<ReturnType<typeof startFixtureServer>>;
let ui: Awaited<ReturnType<typeof startUi>>;
let browser: Browser;
let page: Page;
let clientsDir: string;
let runsDir: string;

/** Richiesta HTTP grezza, per provare intestazioni che il browser non permette di falsificare. */
function raw(path: string, headers: Record<string, string>): Promise<number> {
  const u = new URL(ui.url);
  return new Promise((ok, ko) => {
    const r = request({ host: '127.0.0.1', port: u.port, path, headers }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    r.on('error', ko);
    r.end();
  });
}

before(async () => {
  srv = await startFixtureServer();
  const dir = mkdtempSync(join(tmpdir(), 'scookie-ui-'));
  clientsDir = join(dir, 'clienti');
  runsDir = join(dir, 'runs');
  ui = await startUi({ clientsDir, runsDir, port: 0, log: () => {} });
  // Configurazione con opzioni avanzate (solo da file) che il modulo deve conservare
  writeFileSync(
    join(clientsDir, 'prova.yaml'),
    stringify({
      cliente: 'Cliente di prova',
      output: '../runs',
      browser: { hostResolverRules: 'MAP * 127.0.0.1', servizioUscita: `http://trace.test:${srv.port}/cdn-cgi/trace`, verificaUscita: 'blocca' },
      protocollo: { attesaDopoCaricamento: 300, attesaDopoScroll: 200, attesaDopoScelta: 800, pausaTraSessioni: 0, timeoutNavigazione: 15000 },
      scenari: { pagineDopoScelta: 1 },
      trackerExtra: join(FIXTURES, 'tracker-test.yaml'),
      siti: [{ url: `http://sito-c.test:${srv.port}/`, sitemap: false }],
    }),
  );
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(ui.url);
});

after(async () => {
  await browser?.close();
  await ui?.close();
  await srv?.close();
});

test('protezioni: solo da questo computer e solo dalla pagina dell\'interfaccia', async () => {
  const port = new URL(ui.url).port;
  const cookie = (await page.context().cookies()).find((c) => c.name === 'scookie')!;
  assert.ok(cookie.httpOnly && cookie.sameSite === 'Strict');
  const ok = { host: `127.0.0.1:${port}`, cookie: `scookie=${cookie.value}`, 'x-scookie': '1' };
  assert.equal(await raw('/api/clienti', ok), 200);
  assert.equal(await raw('/api/clienti', { ...ok, host: `attaccante.example:${port}` }), 403, 'DNS rebinding');
  assert.equal(await raw('/api/clienti', { host: ok.host, 'x-scookie': '1' }), 401, 'senza cookie');
  assert.equal(await raw('/api/clienti', { host: ok.host, cookie: ok.cookie }), 403, 'senza intestazione');
  assert.equal(await raw('/esecuzioni/..%2F..%2Fetc/passwd', ok), 400, 'percorso fuori dalla cartella');
});

test('nuovo cliente dal modulo, con errore leggibile se manca l\'indirizzo', async () => {
  await page.click('#new-client');
  await page.fill('#f-cliente', 'Rossi Srl');
  assert.equal(await page.inputValue('#f-file'), 'rossi-srl');
  await page.click('#save');
  await page.waitForSelector('#save-msg .msg.err');
  assert.match(await page.textContent('#save-msg') ?? '', /Sito 1: indirizzo mancante/);
  await page.fill('#sites .site .s-url', 'https://www.rossi.it/');
  await page.selectOption('#sites .site .s-mode', 'solo');
  await page.fill('#sites .site .s-extra', '/contatti\n/preventivo/step-1');
  await page.click('#save');
  await page.waitForSelector('#save-msg .msg.ok');
  const saved = parse(readFileSync(join(clientsDir, 'rossi-srl.yaml'), 'utf8'));
  assert.equal(saved.cliente, 'Rossi Srl');
  assert.deepEqual(saved.siti[0], { url: 'https://www.rossi.it/', pagineExtra: ['/contatti', '/preventivo/step-1'], soloPagineExtra: true });
});

test('modifica dal modulo senza perdere le opzioni avanzate', async () => {
  await page.click('#tab-clienti');
  await page.click('#clients >> text=Cliente di prova');
  await page.waitForFunction(() => (document.querySelector('#f-cliente') as HTMLInputElement).value === 'Cliente di prova');
  await page.selectOption('#sites .site .s-mode', 'mix');
  await page.fill('#sites .site .s-extra', '/servizi/uno.html');
  await page.fill('#sites .site .s-escludi', '/area-riservata');
  await page.click('.step[data-step="2"]');
  await page.click('#adv-general summary');
  await page.uncheck('#f-pdf');
  await page.click('#save');
  await page.waitForSelector('#save-msg .msg.ok');
  const saved = parse(readFileSync(join(clientsDir, 'prova.yaml'), 'utf8'));
  assert.equal(saved.browser.hostResolverRules, 'MAP * 127.0.0.1');
  assert.equal(saved.protocollo.attesaDopoScelta, 800);
  assert.equal(saved.siti[0].sitemap, false);
  assert.deepEqual(saved.siti[0].pagineExtra, ['/servizi/uno.html']);
  assert.deepEqual(saved.siti[0].escludi, ['^/area-riservata']);
  assert.equal(saved.report.pdf, false);
  // Riaprendo, l'esclusione si rilegge come percorso semplice
  await page.reload();
  await page.click('#clients >> text=Cliente di prova');
  await page.click('.step[data-step="1"]');
  await page.waitForFunction(() => (document.querySelector('#sites .site .s-escludi') as HTMLTextAreaElement)?.value === '/area-riservata');
});

test('anteprima pagine', async () => {
  await page.click('.step[data-step="3"]');
  await page.click('#preview');
  await page.waitForSelector('#preview-result table', { timeout: 60000 });
  const text = await page.textContent('#preview-result');
  assert.match(text ?? '', /servizi\/uno\.html/);
});

test('audit dall\'interfaccia e apertura del report', async () => {
  await page.click('.step[data-step="4"]');
  await page.click('#run');
  await page.waitForSelector('text=Audit completato', { timeout: 240000 });
  const [report] = await Promise.all([page.waitForEvent('popup'), page.click('text=Apri il rapporto')]);
  await report.waitForLoadState();
  assert.match(await report.textContent('h1') ?? '', /Rapporto tecnico di verifica/);
  // le immagini delle evidenze si caricano dalla cartella esecuzioni
  const imgOk = await report.evaluate(() => Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0));
  assert.ok(imgOk);
  await report.close();
  await page.click('#tab-esecuzioni');
  await page.waitForSelector('#runs .run');
  assert.match(await page.textContent('#runs') ?? '', /Cliente di prova/);
  assert.ok(existsSync(runsDir));
});

test('confronto con l\'esecuzione precedente', async () => {
  // Si simula un'esecuzione precedente copiando quella appena fatta con una data anteriore.
  const last = readdirSync(runsDir).find((n) => existsSync(join(runsDir, n, 'manifest.json')))!;
  const prev = join(runsDir, 'precedente');
  cpSync(join(runsDir, last), prev, { recursive: true });
  const man = JSON.parse(readFileSync(join(prev, 'manifest.json'), 'utf8'));
  writeFileSync(join(prev, 'manifest.json'), JSON.stringify({ ...man, inizio: '2026-01-01T10:00:00.000Z' }));
  await page.click('#refresh-runs');
  await page.click('text=Confronta con precedente');
  const link = page.locator('#runs a', { hasText: 'Confronto:' });
  await link.waitFor();
  assert.match(await link.textContent() ?? '', /−0 \/ =\d+ \/ \+0/);
  const [cmp] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await cmp.waitForLoadState();
  assert.match(await cmp.textContent('h1') ?? '', /Confronto tra due rilevazioni/);
  await cmp.close();
});
