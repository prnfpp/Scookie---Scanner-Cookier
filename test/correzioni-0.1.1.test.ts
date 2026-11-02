import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Classifier } from '../src/classify/classifier.js';

// Correzioni della versione 0.1.1: casi generali, senza riferimenti a siti reali.

test('fix 5: strumenti di statistica ospitati sul sito riconosciuti da percorso e parametri, su qualsiasi host', () => {
  const c = new Classifier();
  assert.equal(c.classifyHost('www.esempio.it', '/wp-content/plugins/matomo/app/matomo.php', '?idsite=1&rec=1')?.azienda, 'Matomo');
  assert.equal(c.classifyHost('stats.esempio.it', '/piwik.php')?.categoria, 'statistica');
  assert.equal(c.classifyHost('www.esempio.it', '/wp-content/uploads/matomo/matomo.js')?.azienda, 'Matomo');
  assert.equal(c.classifyHost('www.esempio.it', '/js/', '?idsite=3&rec=1&url=x')?.azienda, 'Matomo');
  // servono entrambi i parametri; un percorso qualsiasi non basta
  assert.equal(c.classifyHost('www.esempio.it', '/js/', '?idsite=3'), undefined);
  assert.equal(c.classifyHost('www.esempio.it', '/pagina'), undefined);
  // il dominio specifico prevale sulla voce generica
  assert.equal(c.classifyHost('www.google-analytics.com', '/matomo.php')?.azienda, 'Google');
  const pk = c.classifyName('_pk_id.1.ab12', 'www.esempio.it');
  assert.equal(pk.category, 'statistica');
  assert.equal(pk.platform, 'Matomo');
  assert.throws(() => new Classifier([{ dominio: '*', azienda: 'X', categoria: 'statistica' }]), /senza percorsi né parametri/);
});

test('fix 7: widget di accessibilità e prenotazione appuntamenti di Google classificati', () => {
  const c = new Classifier();
  for (const h of ['eu.acsbapp.com', 'eu-cdn.acsbapp.com', 'embeds.acswapp.com']) {
    const t = c.classifyHost(h, '/x.js')!;
    assert.equal(t.azienda, 'accessiBe', h);
    assert.equal(t.categoria, 'funzionalita', h);
    assert.match(t.nota ?? '', /da valutare se raccoglie dati/);
  }
  assert.equal(c.classifyHost('calendar.google.com', '/calendar/appointments/schedules/AbC')?.azienda, 'Google Calendar (contenuti incorporati)');
  assert.equal(c.classifyHost('calendar-pa.clients6.google.com', '/$rpc/x')?.categoria, 'funzionalita');
  // fuori dal percorso degli appuntamenti resta da valutare
  assert.equal(c.classifyHost('calendar.google.com', '/calendar/u/0/r'), undefined);
});

test('fix 8: concordanze e sintesi senza elenchi vuoti', async () => {
  const { nWords, plural, labelled } = await import('../src/util/text.js');
  assert.equal(nWords(1, 'categoria risulta già attiva', 'categorie risultano già attive'), '1 categoria risulta già attiva');
  assert.equal(nWords(3, 'sessione', 'sessioni'), '3 sessioni');
  assert.equal(plural(0, 'a', 'b'), 'b');
  assert.equal(labelled('Attivi', ''), 'Attivi');
  assert.equal(labelled('Attivi', '', 'Attivi altri strumenti'), 'Attivi altri strumenti');
  assert.equal(labelled('Attivi', 'X e Y'), 'Attivi: X e Y');
  const { summaryItems } = await import('../src/report/summary.js');
  const f = {
    id: 'R-001', ruleId: 'personalizzazione-non-rispettata', ruleTitle: 't', severity: 'alta', site: 'https://www.esempio.it', scenario: 'personalizza',
    pageUrl: null, description: 'd', details: [], evidence: [], evidenceLevel: 'raccolta', sites: ['https://www.esempio.it'], norms: [],
  } as unknown as import('../src/types.js').Finding;
  const t = summaryItems([f])[0].title;
  assert.doesNotMatch(t, /:\s*$/);
  assert.equal(t, 'Con il consenso alle sole statistiche sono attivi anche strumenti di altre categorie');
  assert.equal(summaryItems([{ ...f, subjects: ['AdTest'] }])[0].title, 'Con il consenso alle sole statistiche sono attivi anche: AdTest');
});

/** Sessione minima per provare le regole. */
function sess(over: Partial<import('../src/types.js').SessionResult>): import('../src/types.js').SessionResult {
  return {
    id: 'S1', site: 'https://www.esempio.it', registrableDomain: 'esempio.it', scenario: 'nessuna-azione', pageType: 'home', pages: ['https://www.esempio.it/'],
    startedAt: '', endedAt: '', choiceAt: null, cookies: [], storage: [], requests: [], screenshots: [], har: null, errors: [],
    interaction: { method: 'adattatore:x', detectedCmps: [], outcome: 'eseguito', layer: 'primo-livello', via: 'click', detail: 'click', verification: 'verificato', verificationDetail: '', bannerVisibleBefore: true, bannerVisibleAfter: false },
    ...over,
  } as import('../src/types.js').SessionResult;
}
const req = (over: Partial<import('../src/types.js').RequestRecord>): import('../src/types.js').RequestRecord => ({
  seq: 1, at: '', msFromChoice: 5000, url: 'https://ads.test/c?x=1', host: 'ads.test', method: 'GET', resourceType: 'image', party: 'terza', phase: 'dopo', stage: 'scelta',
  pageUrl: 'https://www.esempio.it/', status: 200, tracker: { company: 'AdTest', category: 'marketing' }, ...over,
});

test('fix 3: personalizza non verificata esce con priorità abbassata e lo dichiara (qualsiasi gestore)', async () => {
  const { personalizzazioneNonRispettata } = await import('../src/rules/regole/scenari-aggiuntivi.js');
  const run = (verification: 'verificato' | 'non-verificabile', withReject = false) =>
    personalizzazioneNonRispettata.evaluate({
      sessions: [
        sess({ scenario: 'personalizza', requests: [req({})], interaction: { ...sess({}).interaction, verification, verificationDetail: 'x' } }),
        ...(withReject ? [sess({ id: 'S2', scenario: 'rifiuta', requests: [req({})] })] : []),
      ],
    } as never);
  assert.equal(run('verificato')[0].severity, undefined, 'priorità piena della regola');
  const weak = run('non-verificabile')[0];
  assert.equal(weak.severity, 'media');
  assert.match(weak.description, /non è stata verificata/);
  const same = run('verificato', true)[0];
  assert.equal(same.severity, 'bassa');
  assert.match(same.description, /attivo anche dopo il rifiuto \(\{\{rilievi:attivazione-dopo-rifiuto:AdTest\}\}\): è lo stesso comportamento del rifiuto/);
});

test('fix 2: troppe "categorie" lette: analisi non affidabile, nessun rilievo di categorie pre-attivate', async () => {
  const { categoriePreattivate, strutturaBanner } = await import('../src/rules/regole/struttura-banner.js');
  const toggles = Array.from({ length: 30 }, (_, i) => ({ label: `${i + 1}, Lunedì`, checked: i === 1, disabled: false }));
  const a = { bannerVisible: true, cmp: [], firstLayer: { accept: ['Accetta'], reject: ['Nega'], preferences: [], close: [], all: [] }, policyLink: null, revokeLink: null, preferences: { opened: true, via: 'x', toggles, unreliable: 'analisi delle categorie non affidabile' } };
  const ctx = { sessions: [sess({ bannerAnalysis: a })] } as never;
  assert.equal(categoriePreattivate.evaluate(ctx).length, 0);
  assert.ok(strutturaBanner.evaluate(ctx)[0].details.some((d) => /non affidabile/.test(d)));
  // rilevazione precedente, senza la marcatura della raccolta: il controllo vale anche con "rigenera"
  const old = { sessions: [sess({ bannerAnalysis: { ...a, preferences: { opened: true, via: 'x', toggles } } })] } as never;
  assert.equal(categoriePreattivate.evaluate(old).length, 0);
  assert.ok(strutturaBanner.evaluate(old)[0].details.some((d) => /non affidabile: 30 interruttori/.test(d)));
});

test('fix 4 e 2: revoca usata con un comando della pagina e X usata nello scenario chiudi rendono coerente la struttura', async () => {
  const { revocaNonTrovata, strutturaBanner } = await import('../src/rules/regole/struttura-banner.js');
  const a = { bannerVisible: true, cmp: [], firstLayer: { accept: ['Accetta'], reject: ['Nega'], preferences: [], close: [], all: [] }, policyLink: null, revokeLink: null, preferences: null };
  const base = sess({ bannerAnalysis: a });
  assert.equal(revocaNonTrovata.evaluate({ sessions: [base] } as never).length, 1);
  const rev = sess({ id: 'S2', scenario: 'revoca', revocation: { outcome: 'eseguita', how: 'click su pulsante "Gestisci consenso", poi rifiuto con pulsante "Nega"', via: 'link', remaining: [] } });
  const x = sess({ id: 'S3', scenario: 'chiudi', interaction: { ...base.interaction, layer: 'chiusura-x', clicked: ['X di chiusura (etichetta "Chiudi")'] } });
  assert.equal(revocaNonTrovata.evaluate({ sessions: [base, rev] } as never).length, 0);
  // via API il comando della pagina non è provato
  assert.equal(revocaNonTrovata.evaluate({ sessions: [base, { ...rev, revocation: { ...rev.revocation!, via: 'api' } }] } as never).length, 1);
  const d = strutturaBanner.evaluate({ sessions: [base, rev, x] } as never)[0].description;
  assert.match(d, /Modo per rivedere la scelta nella pagina: trovato, "Gestisci consenso"/);
  assert.match(d, /visibile solo dopo la scelta/);
  assert.match(d, /chiusura \(X\) presente/);
});
