import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Classifier, normalizeDeclaredCategory } from '../src/classify/classifier.js';
import { declaredPattern } from '../src/declared/compare.js';
import { pageType, parseSitemap, robotsDisallows, sample } from '../src/discovery/discover.js';
import { TEXTS } from '../src/cmp/heuristic.js';
import { isConsentModeDeniedPing } from '../src/rules/helpers.js';
import { PartyResolver, registrableDomain } from '../src/util/domains.js';
import { parseCsv, toCsv } from '../src/util/csv.js';
import type { RequestRecord } from '../src/types.js';
import { parseTrace } from '../src/browser/exit.js';
import { trimHar } from '../src/browser/har.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('pattern dei nomi dichiarati', () => {
  assert.ok(declaredPattern('_ga_xxxxxxx').test('_ga_ABC123'));
  assert.ok(declaredPattern('_ga_*').test('_ga_ABC123'));
  assert.ok(declaredPattern('_hjSession_<site_id>').test('_hjSession_42'));
  assert.ok(declaredPattern('_hjSessionUser_').test('_hjSessionUser_42'));
  assert.ok(declaredPattern('_ga').test('_GA'));
  assert.ok(!declaredPattern('_ga').test('_gat'));
  assert.ok(!declaredPattern('_ga_xxxxxxx').test('_ga'));
  assert.ok(declaredPattern('a.b').test('a.b') && !declaredPattern('a.b').test('axb'));
});

test('classificazione cookie e host', () => {
  const c = new Classifier();
  assert.equal(c.classifyName('_ga', 'esempio.it').category, 'statistica');
  assert.equal(c.classifyName('_ga_ABC123', 'esempio.it').category, 'statistica');
  assert.equal(c.classifyName('_fbp', 'esempio.it').category, 'marketing');
  assert.equal(c.classifyName('_hjSessionUser_42', 'esempio.it').category, 'registrazione-sessioni');
  assert.equal(c.classifyName('xyz_sconosciuto', 'esempio.it').category, 'sconosciuta');
  assert.equal(c.classifyName('IDE', '.doubleclick.net').category, 'marketing');
  assert.equal(c.classifyHost('www.facebook.com', '/tr')?.categoria, 'marketing');
  assert.equal(c.classifyHost('www.facebook.com', '/plugins/like.php')?.categoria, 'social');
  assert.equal(c.classifyHost('www.google.com', '/recaptcha/api.js')?.categoria, 'tecnico');
  assert.equal(c.classifyHost('region1.google-analytics.com', '/g/collect')?.categoria, 'statistica');
  assert.equal(c.classifyHost('www.esempio.it', '/'), undefined);
});

test('categorie dichiarate normalizzate', () => {
  assert.equal(normalizeDeclaredCategory('Cookie strettamente necessari'), 'tecnico');
  assert.equal(normalizeDeclaredCategory('Statistiche'), 'statistica');
  assert.equal(normalizeDeclaredCategory('Targeting Cookies'), 'marketing');
  assert.equal(normalizeDeclaredCategory('Funzionalità'), 'funzionalita');
});

test('prima e terza parte', () => {
  assert.equal(registrableDomain('shop.esempio.co.uk'), 'esempio.co.uk');
  const p = new PartyResolver('esempio.it', ['esempio-cdn.com']);
  assert.equal(p.party('www.esempio.it'), 'prima');
  assert.equal(p.party('.esempio.it'), 'prima');
  assert.equal(p.party('static.esempio-cdn.com'), 'prima');
  assert.equal(p.party('www.google-analytics.com'), 'terza');
});

test('sitemap e tipi di pagina', () => {
  const { isIndex, locs } = parseSitemap('<sitemapindex><sitemap><loc><![CDATA[https://a.it/s1.xml]]></loc></sitemap></sitemapindex>');
  assert.ok(isIndex);
  assert.deepEqual(locs, ['https://a.it/s1.xml']);
  assert.equal(pageType('https://a.it/', {}), 'home');
  assert.equal(pageType('https://a.it/it/', {}), 'home');
  assert.equal(pageType('https://a.it/it/blog/post', {}), 'blog');
  assert.equal(pageType('https://a.it/p/123', { prodotto: '^/p/' }), 'prodotto');
  assert.equal(pageType('https://a.it/10-picadillo-de-pollo.html', {}), 'numerata.html');
  assert.equal(pageType('https://a.it/16-alimenti-e-snack', {}), 'numerata');
  assert.equal(pageType('https://a.it/chi-siamo.html', {}), 'pagina.html');
  assert.equal(pageType('https://a.it/chi-siamo', {}), 'chi-siamo');
});

test('campionamento deterministico e vario', () => {
  const urls = [
    ...Array.from({ length: 10 }, (_, i) => `https://a.it/blog/${i}`),
    ...Array.from({ length: 3 }, (_, i) => `https://a.it/prodotti/${i}`),
    'https://a.it/contatti',
  ].map((url) => ({ url, source: 'sitemap' as const }));
  const cfg = { perTipo: 2, maxPagine: 5, tipi: {} };
  // Con pochi tipi il campione si completa fino al massimo
  const few = Array.from({ length: 6 }, (_, i) => ({ url: `https://a.it/online/p${i}`, source: 'link' as const }));
  assert.equal(sample(few, 'https://a.it/', [], { perTipo: 1, maxPagine: 4, tipi: {} }).length, 4);
  const s1 = sample(urls, 'https://a.it/', ['https://a.it/preventivo/step-2'], cfg);
  const s2 = sample([...urls].reverse(), 'https://a.it/', ['https://a.it/preventivo/step-2'], cfg);
  assert.deepEqual(s1, s2);
  assert.equal(s1.length, 5);
  assert.equal(s1[0].type, 'home');
  assert.equal(s1[1].source, 'extra');
  assert.deepEqual(new Set(s1.slice(2).map((p) => p.type)), new Set(['blog', 'prodotti', 'contatti']));
});

test('testi dei pulsanti', () => {
  for (const t of ['Rifiuta', 'Rifiuta tutti', 'Solo necessari', 'Continua senza accettare', 'Reject all', 'Accetta solo i necessari']) assert.ok(TEXTS.reject.test(t), t);
  for (const t of ['Accetta', 'Accetta tutti', 'Accept all cookies', 'Ok']) assert.ok(TEXTS.accept.test(t), t);
  assert.ok(!TEXTS.accept.test('Accetta solo i necessari'));
  assert.ok(TEXTS.preferences.test('Personalizza'));
});

test('ping Consent Mode', () => {
  const r = (gcs: string) => ({ consentParams: { gcs } }) as unknown as RequestRecord;
  assert.ok(isConsentModeDeniedPing(r('G100')));
  assert.ok(isConsentModeDeniedPing(r('G1--')));
  assert.ok(!isConsentModeDeniedPing(r('G111')));
  assert.ok(!isConsentModeDeniedPing(r('G110')));
});

test('CSV andata e ritorno', () => {
  const out = toCsv(['a', 'b'], [['x;y', 'con "virgolette"'], [1, null]]);
  const rows = parseCsv(out, ';');
  assert.deepEqual(rows, [['a', 'b'], ['x;y', 'con "virgolette"'], ['1', '']]);
});

test('lettura IP e paese di uscita', () => {
  assert.deepEqual(parseTrace('fl=1\nip=203.0.113.5\nts=1\nloc=it\ncolo=MXP\n'), { ip: '203.0.113.5', country: 'IT' });
  assert.deepEqual(parseTrace('niente'), { ip: null, country: null });
});

test('riduzione HAR: via immagini e testi grandi, restano i corpi delle richieste', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'har-')), 'x.har');
  const entry = (mimeType: string, text: string, encoding?: string) => ({
    request: { method: 'POST', postData: { mimeType: 'text/plain', text: 'cid=1&ev=PageView' } },
    response: { content: { mimeType, size: text.length, text, ...(encoding ? { encoding } : {}) } },
  });
  writeFileSync(path, JSON.stringify({ log: { entries: [entry('image/png', 'AAAA', 'base64'), entry('application/json', '{"ok":1}'), entry('text/javascript', 'x'.repeat(600 * 1024))] } }));
  assert.equal(trimHar(path, 'testo'), 2);
  const h = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(h.log.entries[0].response.content.text, undefined);
  assert.equal(h.log.entries[1].response.content.text, '{"ok":1}');
  assert.equal(h.log.entries[2].response.content.text, undefined);
  assert.ok(h.log.entries.every((e: { request: { postData: { text: string } } }) => e.request.postData.text === 'cid=1&ev=PageView'));
});

test('robots.txt: Disallow, Allow, * e $', () => {
  const d = robotsDisallows('User-agent: Googlebot\nDisallow: /solo-google\n\nUser-agent: *\nDisallow: /area-riservata/\nDisallow: /*.pdf$\nDisallow: /cerca?\nAllow: /area-riservata/pubblica\n');
  assert.ok(d('/area-riservata/profilo'));
  assert.ok(!d('/area-riservata/pubblica/x'));
  assert.ok(d('/doc/file.pdf'));
  assert.ok(!d('/doc/file.pdf.html'));
  assert.ok(d('/cerca?q=1'));
  assert.ok(!d('/solo-google'));
  assert.ok(!d('/prodotti/a'));
  assert.ok(!robotsDisallows('')('/x'));
});
