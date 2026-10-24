import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Classifier, normalizeDeclaredCategory } from '../src/classify/classifier.js';
import { declaredPattern } from '../src/declared/compare.js';
import { pageType, parseSitemap, sample } from '../src/discovery/discover.js';
import { TEXTS } from '../src/cmp/heuristic.js';
import { isConsentModeDeniedPing } from '../src/rules/helpers.js';
import { PartyResolver, registrableDomain } from '../src/util/domains.js';
import { parseCsv, toCsv } from '../src/util/csv.js';
import type { RequestRecord } from '../src/types.js';
import { parseTrace } from '../src/browser/exit.js';

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
