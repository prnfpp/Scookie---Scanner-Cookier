import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config/load.js';
import { runAudit, type RunResult } from '../src/run.js';
import { FIXTURES, startFixtureServer } from './fixtures/server.js';

let srv: Awaited<ReturnType<typeof startFixtureServer>>;
let result: RunResult;
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
    scenari: { attivi: ['nessuna-azione'] },
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
  const cfgPath = join(dir, 'config.yaml');
  writeFileSync(cfgPath, stringify(config));
  // L'operatore simulato: controlla il riquadro, naviga e preme "Ho finito"
  result = await runAudit(loadConfig(cfgPath), {
    log: (m) => logs.push(m),
    manualDriver: async (page) => {
      await page.locator('#scookie-operatore').waitFor({ state: 'attached', timeout: 10000 });
      await page.goto(url('sito-a.test', '/prodotti/alfa.html'));
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
  assert.match(readFileSync(join(result.runDir, 'report.html'), 'utf8'), /Attenzione — pagine non caricate/);
});
