import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attributeByHost, checkDeclared } from '../src/report/attribution.js';
import { enrichRequests } from '../src/classify/enrich.js';
import { adStorageGranted, consensoConcessoDopoRifiuto } from '../src/rules/regole/consenso-concesso-dopo-rifiuto.js';
import { describeGoogleConsent, strongestRequest, uetConsentSummary } from '../src/rules/helpers.js';
import { tidy } from '../src/rules/engine.js';
import { cfFromTestData, detectPii, maskedCfMatchesTestSurname, maskPii, registerTypedValue, reviveTestHits, setTestData, typedTestData } from '../src/util/pii.js';
import type { CookieRecord, DeclaredSet, InteractionReport, RequestRecord, SessionResult } from '../src/types.js';

const interaction = (extra: Partial<InteractionReport> = {}): InteractionReport => ({
  method: 'adattatore:onetrust',
  detectedCmps: ['OneTrust'],
  outcome: 'eseguito',
  layer: 'primo-livello',
  via: 'click',
  detail: 'click su pulsante "Rifiuta"',
  verification: 'verificato',
  verificationDetail: '',
  bannerVisibleBefore: true,
  bannerVisibleAfter: false,
  ...extra,
});

const req = (pageUrl: string, extra: Partial<RequestRecord> = {}): RequestRecord => ({
  seq: 1,
  at: '2026-01-01T00:00:00Z',
  msFromChoice: 5000,
  url: 'https://tracker.test/collect?x=1',
  host: 'tracker.test',
  method: 'GET',
  resourceType: 'image',
  party: 'terza',
  phase: 'dopo',
  stage: 'scelta',
  pageUrl,
  status: 200,
  ...extra,
});

const cookie = (name: string, firstSeenUrl: string): CookieRecord => ({
  name,
  domain: '.esempio.test',
  path: '/',
  expires: null,
  httpOnly: false,
  secure: true,
  sameSite: 'Lax',
  party: 'prima',
  phase: 'prima',
  stage: 'caricamento',
  firstSeenUrl,
  firstSeenAt: '2026-01-01T00:00:00Z',
  valuePreview: '',
  classification: { category: 'marketing', source: 'test' },
});

const session = (extra: Partial<SessionResult>): SessionResult => ({
  id: 'S001_app_rifiuta-manuale',
  site: 'https://app.esempio.test',
  registrableDomain: 'esempio.test',
  scenario: 'rifiuta',
  pageType: 'navigazione manuale',
  pages: ['https://www.esempio.test/'],
  startedAt: '',
  endedAt: '',
  choiceAt: null,
  interaction: interaction(),
  cookies: [],
  storage: [],
  requests: [],
  screenshots: [
    { label: '1-banner', file: 'evidenze/S001_1-banner.png' },
    { label: '3-fine', file: 'evidenze/S001_3-fine.png' },
  ],
  har: 'evidenze/S001.har',
  errors: [],
  ...extra,
});

test('attribuzione per host: la parte della navigazione su un altro sito va a quel sito', () => {
  const s = session({
    manual: { instructions: 'preventivo', pages: ['https://www.esempio.test/', 'https://app.esempio.test/preventivo'], endedBy: 'operatore', seconds: 120 },
    cookies: [cookie('_gtmeec', 'https://www.esempio.test/'), cookie('PLATE', 'https://app.esempio.test/preventivo')],
    requests: [req('https://www.esempio.test/'), req('https://app.esempio.test/preventivo'), req('https://app.esempio.test/preventivo')],
  });
  const { sessions, notes } = attributeByHost([s]);
  const app = sessions.find((x) => x.site === 'https://app.esempio.test')!;
  const www = sessions.find((x) => x.site === 'https://www.esempio.test')!;
  assert.deepEqual(app.cookies.map((c) => c.name), ['PLATE']);
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.manual!.pages, ['https://app.esempio.test/preventivo']);
  assert.match(app.interaction.detail, /scelta fatta su www\.esempio\.test/);
  // il banner fotografato era su www: la prova va con www
  assert.deepEqual(app.screenshots.map((e) => e.label), ['3-fine']);
  assert.deepEqual(www.cookies.map((c) => c.name), ['_gtmeec']);
  assert.equal(www.requests.length, 1);
  assert.deepEqual(www.attributedFrom, { session: s.id, site: 'https://app.esempio.test' });
  assert.deepEqual(www.screenshots.map((e) => e.label), ['1-banner']);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /è passata anche da www\.esempio\.test/);
});

test('attribuzione per host: una navigazione mai entrata nel sito non lo descrive', () => {
  const s = session({
    site: 'https://cani.esempio.test',
    manual: { instructions: 'preventivo', pages: ['https://www.esempio.test/', 'https://www.esempio.test/cani/'], endedBy: 'operatore', seconds: 40 },
    cookies: [cookie('_gtmeec', 'https://www.esempio.test/')],
    requests: [req('https://www.esempio.test/cani/')],
  });
  const { sessions, notes } = attributeByHost([s]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].site, 'https://www.esempio.test');
  assert.match(notes[0], /non è mai entrata su cani\.esempio\.test/);
});

test('attribuzione per host: www e il sito senza www sono lo stesso sito; le sessioni automatiche restano intatte', () => {
  const auto = session({ id: 'S002', site: 'https://www.esempio.test', pageType: 'home', scenario: 'nessuna-azione', pages: ['https://www.esempio.test/'], requests: [req('https://esempio.test/')] });
  const { sessions, notes } = attributeByHost([auto]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0], auto);
  assert.equal(notes.length, 0);
});

test('elenco dichiarato: scartato se letto dal gestore di un altro sito', () => {
  const declared: DeclaredSet[] = [{ site: 'https://cani.esempio.test', source: 'CMP OneTrust', items: [{ kind: 'cookie', name: '_ga', declaredCategory: 'x', category: 'statistica', alwaysActive: true, source: 'cmp:onetrust' }] }];
  const auto = session({ id: 'S010', site: 'https://cani.esempio.test', manual: undefined, scenario: 'nessuna-azione', interaction: interaction({ detectedCmps: ['HubSpot'] }) });
  const r = checkDeclared(declared, [auto]);
  assert.equal(r.declared[0].source, null);
  assert.equal(r.declared[0].items.length, 0);
  assert.match(r.notes[0], /gestore mostrato è HubSpot/);
  // stesso gestore: l'elenco resta
  const ok = checkDeclared(declared, [{ ...auto, interaction: interaction({ detectedCmps: ['OneTrust'] }) }]);
  assert.equal(ok.declared[0].source, 'CMP OneTrust');
});

test('dati digitati dall\'operatore: riconosciuti come dati di prova, in chiaro; codice fiscale calcolato da quei dati', () => {
  setTestData([{ tipo: 'targa', valore: 'AA123BB' }]);
  assert.ok(registerTypedValue('01/01/2000', 'input[name="dataNascita"] Data di nascita'));
  assert.ok(registerTypedValue('AB123CD', 'input[name="targa"]'));
  assert.ok(registerTypedValue('Mario Rossa', 'input[name="nomeCognome"] Nome e cognome'));
  // valori senza forma di dato personale o già noti: ignorati
  assert.equal(registerTypedValue('Roma', 'input[name="citta"]'), null);
  assert.equal(registerTypedValue('AA123BB', 'targa'), null);
  assert.deepEqual(typedTestData().map((t) => t.tipo).sort(), ['data', 'nome', 'targa']);
  assert.equal(maskPii('https://x.test/?dataNascita=01%2F01%2F2000&targa=AB123CD'), 'https://x.test/?dataNascita=01%2F01%2F2000&targa=AB123CD');
  // codice fiscale di Rossa Mario, nato il 1/1/2000 (comune e controllo qualsiasi)
  assert.ok(cfFromTestData('RSSMRA00A01H501X'));
  assert.ok(!cfFromTestData('BNCLGU80A01H501X'));
  const hits = detectPii('cf=RSSMRA00A01H501X');
  assert.ok(hits.some((h) => h.test && /calcolato dai dati di prova/.test(h.kind)));
  // rilevazione precedente: valori mascherati che corrispondono ai dati digitati tornano dati di prova
  const revived = reviveTestHits([
    { kind: 'targa', param: 'targa', masked: 'AB•••CD' },
    { kind: 'data di nascita', param: 'dataNascita', masked: '01••••••00' },
    { kind: 'data di nascita', param: null, masked: '20••••••01' },
  ]);
  assert.ok(revived.every((h) => h.test));
  assert.equal(revived[0].masked, 'AB123CD');
  assert.equal(maskedCfMatchesTestSurname('RS••••••3L'), 'Rossa');
  assert.equal(maskedCfMatchesTestSurname('BN••••••3L'), null);
  setTestData([]);
});

test('consenso pubblicitario concesso dopo il rifiuto: scheda dedicata', () => {
  const granted = req('https://app.esempio.test/', { host: 'www.google.com', consentParams: { gcs: 'G111' }, msFromChoice: 6000, method: 'POST' });
  const denied = req('https://app.esempio.test/', { host: 'www.google.com', consentParams: { gcs: 'G101' } });
  assert.ok(adStorageGranted(granted));
  assert.equal(adStorageGranted(denied), null);
  assert.ok(adStorageGranted(req('x', { consentParams: { gcd: '13v3v3v2v5l1' } })));
  const s = session({ site: 'https://app.esempio.test', pages: ['https://app.esempio.test/'], requests: [granted, denied] });
  const out = consensoConcessoDopoRifiuto.evaluate({ sessions: [s] } as never);
  assert.equal(out.length, 1);
  assert.match(out[0].description, /1 richiesta .* dichiara il consenso pubblicitario \(ad_storage\) come concesso/);
  assert.match(out[0].details.join(' '), /navigazione manuale|S001/);
  // gcd con lettere maiuscole o in formato non documentato: non resta senza spiegazione
  assert.match(describeGoogleConsent({ gcd: '13v3vPv2v5l1' }) ?? '', /formato non documentato/);
});

test('richiesta di esempio: non quella che registra la scelta, ma una raccolta successiva', () => {
  const choice = req('https://app.esempio.test/', { msFromChoice: 28, method: 'POST' });
  const later = req('https://app.esempio.test/pagina-2', { msFromChoice: 9000 });
  assert.equal(strongestRequest([choice, later]), later);
});

test('Microsoft UET: Consent Mode decodificato; Dynatrace Session Replay e New Relic del widget Genesys riconosciuti', () => {
  const bing = req('https://app.esempio.test/', { host: 'bat.bing.com', url: 'https://bat.bing.com/action/0?ti=1&evt=consent&asc=D' });
  const dt = req('https://app.esempio.test/', { host: 'bf123.bf.dynatrace.com', url: 'https://bf123.bf.dynatrace.com/bf?type=js3&contentType=srBm', tracker: { company: 'Dynatrace', category: 'statistica' } });
  const nr = req('https://app.esempio.test/', { host: 'bam.eu01.nr-data.net', url: 'https://bam.eu01.nr-data.net/1/x?a=1&ref=https://apps.mypurecloud.ie/widget', tracker: { company: 'New Relic', category: 'statistica' } });
  const s = session({ requests: [bing, dt, nr] });
  enrichRequests([s]);
  assert.match(bing.purpose ?? '', /asc=D: consenso negato/);
  assert.equal(bing.consentParams?.asc, 'D');
  assert.match(uetConsentSummary([bing]).short ?? '', /asc=D/);
  assert.equal(dt.tracker?.category, 'registrazione-sessioni');
  assert.match(dt.purpose ?? '', /Session Replay/);
  assert.match(nr.tracker?.company ?? '', /Genesys/);
});

test('testi delle schede: spazi ridotti e tentativi precedenti spostati nei dettagli', () => {
  const t = tidy('Dopo la revoca (click su link "Impostazioni Cookie     🍪\n   ", poi rifiuto (scelta via API (tentativi precedenti: a (b) | c))), per X partono 2 richieste.', ['riga   uno']);
  assert.equal(t.description, 'Dopo la revoca (click su link "Impostazioni Cookie 🍪 ", poi rifiuto (scelta via API)), per X partono 2 richieste.');
  assert.deepEqual(t.details, ['riga uno', 'Tentativi prima della scelta riuscita: a (b) | c']);
});
