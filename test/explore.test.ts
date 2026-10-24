import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { configSchema } from '../src/config/schema.js';
import { discoverSite } from '../src/discovery/discover.js';
import { launchOptions } from '../src/run.js';
import { startFixtureServer } from './fixtures/server.js';

let srv: Awaited<ReturnType<typeof startFixtureServer>>;
let browser: Browser;
const url = (host: string, path = '/') => `http://${host}:${srv.port}${path}`;

before(async () => {
  srv = await startFixtureServer();
});

after(async () => {
  await browser?.close();
  await srv?.close();
});

test('esplorazione con clic su un\'applicazione senza sitemap né link', async () => {
  const config = configSchema.parse({
    cliente: 'Prova',
    browser: { hostResolverRules: 'MAP * 127.0.0.1' },
    protocollo: { timeoutNavigazione: 15000 },
    campionamento: { perTipo: 2, maxPagine: 10, esplorazione: { maxSecondi: 120 } },
    siti: [{ url: url('sito-i.test') }],
  });
  browser = await chromium.launch(launchOptions(config));
  const d = await discoverSite(browser, config.siti[0], config, 'ScookieAudit/test');
  const found = d.sample.filter((p) => p.source !== 'home').map((p) => new URL(p.url).pathname + new URL(p.url).hash);
  // il link nel menu nascosto è già letto dalla home; gli altri indirizzi si raggiungono solo con i clic
  assert.ok(d.sample.some((p) => p.url.endsWith('/chi-siamo') && p.source === 'link'));
  assert.ok(d.sample.filter((p) => p.source === 'esplorazione').length >= 5);
  for (const p of ['/prodotti', '/chi-siamo', '/preventivo/passo-1', '/preventivo/passo-2', '/assistenza', '/#/offerte', '/area-nascosta']) {
    assert.ok(found.includes(p), `${p} trovata (trovate: ${found.join(', ')})`);
  }
  // Il sottodominio info.sito-i.test è stato attraversato (da lì si arriva ad /area-nascosta) ma non entra nel campione
  assert.ok(d.sample.every((p) => new URL(p.url).hostname === 'sito-i.test'));
  // Mai cliccati: scelta sul banner, uscita, invio di moduli
  for (const p of ['/accettato', '/logout', '/inviato']) assert.ok(!found.includes(p), `${p} non deve essere cliccata`);
  assert.ok(d.notes.some((n) => /Esplorazione con clic \(trovata una sola pagina con sitemap e link\)/.test(n)), d.notes.join(' | '));

  // Con esplora: no non parte
  const off = await discoverSite(browser, { ...config.siti[0], esplora: 'no' }, config, 'ScookieAudit/test');
  assert.ok(!off.sample.some((p) => p.source === 'esplorazione'));
  assert.equal(d.sample.length, new Set(d.sample.map((p) => p.url)).size, 'nessun indirizzo ripetuto');
});

test('esplorazione fermata da una verifica anti-bot', async () => {
  const config = configSchema.parse({
    cliente: 'Prova',
    browser: { hostResolverRules: 'MAP * 127.0.0.1' },
    siti: [{ url: url('sito-h.test'), esplora: 'sempre' }],
  });
  const d = await discoverSite(browser, config.siti[0], config, 'ScookieAudit/test');
  assert.ok(d.notes.some((n) => /Esplorazione fermata: verifica anti-bot Cloudflare/.test(n)), d.notes.join(' | '));
});
