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
import { detectPii, registerTypedValue, setTestData } from '../src/util/pii.js';

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
