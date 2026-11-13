import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assembleHar } from '../src/browser/har.js';
import { hasSecretStep, recordedFills, type RecordedStep } from '../src/browser/replay.js';
import { sessionBudgetMs } from '../src/browser/session.js';
import { configSchema } from '../src/config/schema.js';
import { detectPii, registerTypedValue, setTestData, typedTestData, typedValuesFromUrl } from '../src/util/pii.js';
import { chromium } from 'playwright';
import { rejectOnPreferencesPage } from '../src/cmp/revoke.js';
import { consolidateByVendor, VENDOR_RULE } from '../src/report/consolidate.js';
import { expandFindings } from '../src/report/parts.js';
import type { Finding } from '../src/types.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const md5 = (v: string) => createHash('md5').update(v).digest('hex');

test('dati di prova riconosciuti anche come hash o in base64', () => {
  setTestData([
    { tipo: 'email', valore: 'Mario.Rossi@Example.org' },
    { tipo: 'telefono', valore: '333 123 4567' },
  ]);
  // email normalizzata (minuscolo) in SHA-256, come nel pixel di Meta
  let hits = detectPii(`https://www.facebook.com/tr/?id=1&ud[em]=${sha256('mario.rossi@example.org')}`);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].test);
  assert.match(hits[0].kind, /email \(hash SHA-256\)/);
  assert.equal(hits[0].masked, 'Mario.Rossi@Example.org');
  // MD5 in maiuscolo
  hits = detectPii(`https://t.example/p?h=${md5('mario.rossi@example.org').toUpperCase()}`);
  assert.match(hits[0]?.kind ?? '', /hash MD5/);
  // telefono con prefisso internazionale, come lo normalizzano i fornitori
  hits = detectPii(null, JSON.stringify({ user_data: { ph: sha256('393331234567') } }));
  assert.ok(hits.some((h) => h.test && /telefono \(hash SHA-256\)/.test(h.kind)));
  // base64 del valore in chiaro
  hits = detectPii(`https://t.example/p?d=${Buffer.from('Mario.Rossi@Example.org').toString('base64')}`);
  assert.ok(hits.some((h) => h.test && /base64/.test(h.kind)));
  // un hash qualsiasi non è un dato di prova
  assert.equal(detectPii(`https://t.example/p?h=${sha256('altro@example.org')}`).filter((h) => h.test).length, 0);
  // hash non riconducibile ai dati di prova ma dichiarato dal nome del parametro: da verificare, mascherato
  hits = detectPii(`https://t.example/p?sha256_email_address=${sha256('altro@example.org')}`);
  assert.equal(hits[0]?.kind, 'email con hash');
  assert.ok(!hits[0].test);
  setTestData([]);
});

test('dati di prova cercati in tutto il corpo, non solo all\'inizio', () => {
  setTestData([{ tipo: 'email', valore: 'prova@example.org' }]);
  const body = `${'x'.repeat(60000)}{"email":"prova@example.org"}`;
  assert.ok(detectPii(null, body).some((h) => h.test));
  setTestData([]);
});

test('percorso registrato: i valori dei campi valgono come dati di prova, i campi riservati non si registrano', () => {
  const steps: RecordedStep[] = [
    { type: 'fill', css: 'input[name="email"]', text: 'Email', tag: 'input', value: 'cliente@example.org', url: 'https://x.test/' },
    { type: 'fill', css: 'input[name="nome"]', text: 'Nome', tag: 'input', value: 'Mario Rossi', url: 'https://x.test/' },
    { type: 'click', css: 'button', text: 'Avanti', tag: 'button', url: 'https://x.test/' },
  ];
  assert.equal(hasSecretStep(steps), false);
  setTestData([]);
  for (const f of recordedFills(steps)) registerTypedValue(f.value, f.hint);
  const hits = detectPii('https://tracker.example/collect?n=mario%20rossi&e=cliente@example.org');
  assert.ok(hits.some((h) => h.test && h.kind === 'email'));
  assert.ok(hits.some((h) => h.test && h.kind === 'nome'));
  const secret: RecordedStep[] = [...steps, { type: 'fill', css: '#pwd', text: 'Password', tag: 'input', value: '', secret: true, url: 'https://x.test/' }];
  assert.equal(hasSecretStep(secret), true);
  assert.equal(recordedFills(secret).length, 2);
  setTestData([]);
});

test('configurazione: host ripetuti ed espressioni regolari non valide rifiutati al salvataggio', () => {
  const ok = configSchema.safeParse({ cliente: 'x', siti: [{ url: 'https://www.x.it/' }, { url: 'https://shop.x.it/', escludi: ['^/en/'] }] });
  assert.ok(ok.success);
  const dup = configSchema.safeParse({ cliente: 'x', siti: [{ url: 'https://www.x.it/it/' }, { url: 'https://www.x.it/en/' }] });
  assert.ok(!dup.success);
  assert.match(dup.error!.issues[0].message, /già presente/);
  const bad = configSchema.safeParse({ cliente: 'x', siti: [{ url: 'https://www.x.it/', escludi: ['['] }] });
  assert.ok(!bad.success);
  assert.match(bad.error!.issues[0].message, /espressione regolare/);
  const badType = configSchema.safeParse({ cliente: 'x', campionamento: { tipi: { prodotto: '(' } }, siti: [{ url: 'https://www.x.it/' }] });
  assert.ok(!badType.success);
});

test('tetto di durata della sessione: cresce con le visite previste', () => {
  const p = configSchema.parse({ cliente: 'x', siti: [{ url: 'https://www.x.it/' }] }).protocollo;
  const pages = (n: number) => Array.from({ length: n }, (_, i) => `https://www.x.it/p${i}`);
  // una pagina sola: resta il tetto della configurazione
  assert.equal(sessionBudgetMs({ scenario: 'nessuna-azione', pages: pages(1) }, p, 6000), p.timeoutSessione);
  const revoca4 = sessionBudgetMs({ scenario: 'revoca', pages: pages(4) }, p, 6000);
  const revoca8 = sessionBudgetMs({ scenario: 'revoca', pages: pages(8) }, p, 6000);
  assert.ok(revoca4 > p.timeoutSessione, 'la revoca visita dieci pagine: 300 s non bastano su un sito lento');
  assert.ok(revoca8 > revoca4);
  assert.equal(sessionBudgetMs({ scenario: 'revoca', pages: pages(4), timeoutFactor: 2 }, p, 6000), revoca4 * 2);
});

test('file HAR composto dai corpi separati: richieste sempre, risposte secondo harContenuti', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scookie-har-'));
  const tmp = join(dir, '.har-S1');
  mkdirSync(tmp);
  writeFileSync(join(tmp, 'a.html'), '<html>ciao</html>');
  writeFileSync(join(tmp, 'b.mp4'), Buffer.alloc(2_000_000, 1));
  writeFileSync(join(tmp, 'c.txt'), 'email=test@example.org');
  writeFileSync(
    join(tmp, 'S1.har'),
    JSON.stringify({
      log: {
        entries: [
          { request: {}, response: { content: { mimeType: 'text/html', size: 17, _file: 'a.html' } } },
          { request: {}, response: { content: { mimeType: 'video/mp4', size: 2_000_000, _file: 'b.mp4' } } },
          { request: { postData: { text: '', _file: 'c.txt' } }, response: { content: { mimeType: 'image/gif', size: 0 } } },
        ],
      },
    }),
  );
  const dest = join(dir, 'S1.har');
  assert.equal(assembleHar(tmp, 'S1.har', dest, 'testo'), 1);
  const har = JSON.parse(readFileSync(dest, 'utf8'));
  assert.equal(har.log.entries[0].response.content.text, '<html>ciao</html>');
  assert.equal(har.log.entries[1].response.content.text, undefined);
  assert.match(har.log.entries[1].response.content.comment, /omesso/);
  assert.equal(har.log.entries[2].request.postData.text, 'email=test@example.org');
  assert.ok(!existsSync(tmp), 'la cartella temporanea viene eliminata');
  assert.ok(readFileSync(dest).length < 10_000);
});

const card = (ruleId: string, severity: Finding['severity'], site: string, vendor: string, key: string): Finding => ({
  id: `R-${key}`,
  ruleId,
  ruleTitle: ruleId,
  severity,
  site,
  sites: [site],
  scenario: null,
  pageUrl: site,
  description: `${vendor} ${ruleId}`,
  details: [],
  evidence: [{ label: '1-banner', file: `evidenze/${key}.png` }],
  subjects: [vendor],
  key: `${ruleId}|${vendor}|${key}`,
  headline: `${vendor} ${ruleId}`,
  norms: [{ key: 'gdpr7', title: 'Art. 7', reference: 'art. 7' }],
});

test('una scheda per fornitore e dominio, con una sezione per momento', () => {
  const fs = [
    card('attivazione-dopo-rifiuto', 'alta', 'https://www.esempio.it', 'Google', 'a'),
    card('cookie-prima-del-consenso', 'alta', 'https://shop.esempio.it', 'Google', 'b'),
    card('attivazione-dopo-revoca', 'bassa', 'https://www.esempio.it', 'Google', 'c'),
    card('attivazione-dopo-rifiuto', 'media', 'https://www.esempio.it', 'Meta', 'd'),
    card('struttura-banner', 'informativa', 'https://www.esempio.it', 'Google', 'e'),
    card('cookie-prima-del-consenso', 'alta', 'https://www.altro.it', 'Google', 'f'),
  ];
  const out = consolidateByVendor(fs);
  assert.equal(out.length, 4, 'Google su esempio.it in una scheda; Meta, struttura del banner e altro.it a parte');
  const g = out.find((f) => f.parts)!;
  assert.equal(g.ruleId, VENDOR_RULE);
  assert.equal(g.severity, 'alta');
  assert.deepEqual(g.parts!.map((p) => p.ruleId), ['cookie-prima-del-consenso', 'attivazione-dopo-rifiuto', 'attivazione-dopo-revoca']);
  assert.deepEqual(g.sites.sort(), ['https://shop.esempio.it', 'https://www.esempio.it']);
  assert.match(g.headline!, /Google attivo prima della scelta, dopo il rifiuto e dopo la revoca del consenso/);
  // la lettura per momento restituisce i rilievi originali, con il numero della scheda
  const flat = expandFindings(out);
  assert.equal(flat.length, 6);
  assert.ok(flat.filter((f) => f.ruleId === 'attivazione-dopo-rifiuto').some((f) => f.id === g.id));
});

test('pagina di preferenze propria del sito: interruttori spenti e "Salva", senza accettare', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<h1>Preferenze cookie</h1>
      <button id="acc">Accetta i cookie</button>
      <div class="categoria">Cookie funzionali <input type="checkbox" checked disabled></div>
      <div class="categoria">Cookie pubblicitari
        <label><input type="radio" name="ads" value="on" checked> On</label>
        <label><input type="radio" name="ads" value="off"> Off</label></div>
      <div class="categoria">Statistiche <label><input type="checkbox" id="st" checked> attivi</label></div>
      <button id="save" onclick="window.saved = { ads: document.querySelector('[name=ads]:checked').value, st: document.getElementById('st').checked }">Salva preferenze personalizzate</button>
      <script>document.getElementById('acc').onclick = () => (window.accepted = true)</script>`);
    const r = await rejectOnPreferencesPage(page);
    assert.ok(r.ok, r.detail);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { saved: unknown }).saved), { ads: 'off', st: false });
    assert.equal(await page.evaluate(() => (window as unknown as { accepted?: boolean }).accepted ?? false), false);
    assert.match(r.detail, /Salva preferenze personalizzate/);
    // pulsante di salvataggio fatto con un <div> (come su alcuni siti HubSpot CMS), radio con l'etichetta che le contiene
    await page.setContent(`<div class="checkboxes_cookie"><h3>Cookie analitici</h3><div>
        <label for="on">On <input id="on" checked name="an" type="radio"><span class="checkmark"></span></label>
        <label for="off">Off <input id="off" name="an" type="radio"><span class="checkmark"></span></label></div></div>
      <div class="wrap"><div id="ACCEPT_" class="conte_container_button">Accetta i cookie</div></div>
      <div class="wrap"><div id="SAVE_PREFERENCES" class="conte_container_button button_conte_custom" onclick="window.saved = document.getElementById('off').checked">Salva preferenze personalizzate</div></div>`);
    const r2 = await rejectOnPreferencesPage(page);
    assert.ok(r2.ok, r2.detail);
    assert.equal(await page.evaluate(() => (window as unknown as { saved: boolean }).saved), true);
    // nessun modulo: niente da fare
    await page.setContent('<p>Informativa</p><button>Accetta</button>');
    assert.equal((await rejectOnPreferencesPage(page)).ok, false);
  } finally {
    await browser.close();
  }
});

test('dati inseriti dall\'operatore ritrovati nell\'indirizzo delle pagine del sito', () => {
  setTestData([]);
  const own = (h: string) => h.endsWith('esempio.it');
  const vals = typedValuesFromUrl('https://app.esempio.it/preventivo/inizio/?dataNascita=09%2F05%2F1997&targa=GA979MD&tipo=auto', own);
  assert.deepEqual(vals.map((v) => v.value), ['09/05/1997', 'GA979MD']);
  // pagine di altri siti: niente
  assert.equal(typedValuesFromUrl('https://tracker.example/p?dataNascita=09/05/1997', own).length, 0);
  for (const v of vals) registerTypedValue(v.value, v.hint, v.field);
  assert.deepEqual(typedTestData().map((t) => [t.tipo, t.etichetta ?? '', t.valore]), [
    ['data', 'data di nascita', '09/05/1997'],
    ['targa', '', 'GA979MD'],
  ]);
  // la data inviata a un terzo è riconosciuta come dato di prova e resta in chiaro
  const hits = detectPii('https://www.google.com/collect?dl=https%3A%2F%2Fapp.esempio.it%2F%3FdataNascita%3D09%252F05%252F1997');
  assert.ok(hits.some((h) => h.test && h.kind === 'data di nascita'), JSON.stringify(hits));
  setTestData([]);
});
