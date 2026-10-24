import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type LaunchOptions } from 'playwright';
import { Classifier, type TrackerEntry } from './classify/classifier.js';
import type { LoadedConfig } from './config/load.js';
import type { AuditConfig } from './config/schema.js';
import { compareDeclared } from './declared/compare.js';
import { loadDeclaredFile } from './declared/declared.js';
import { discoverSite, type DiscoveryResult } from './discovery/discover.js';
import { detectExit, type ExitInfo } from './browser/exit.js';
import { runSession, type SessionPlan } from './browser/session.js';
import { renderHtml } from './report/html.js';
import { writeCsvs } from './report/csv.js';
import { DEFAULT_NORMS_FILE, evaluateRules, loadNorms } from './rules/engine.js';
import type { ComparisonRow, DeclaredSet, Finding, ScenarioName, SessionResult } from './types.js';
import { sha256, sha256File, sleep, slug, timestampForPath } from './util/misc.js';
import { TOOL_VERSION } from './version.js';

export interface RunOptions {
  outDir?: string;
  pdf?: boolean;
  log?: (msg: string) => void;
}

export interface RunResult {
  runDir: string;
  findings: Finding[];
  sessions: SessionResult[];
}

export function launchOptions(cfg: AuditConfig, headless = cfg.browser.headless): LaunchOptions {
  const args: string[] = [];
  if (cfg.browser.hostResolverRules) args.push(`--host-resolver-rules=${cfg.browser.hostResolverRules}`);
  return {
    headless,
    args,
    executablePath: cfg.browser.executablePath,
    proxy: cfg.browser.proxy ? { server: cfg.browser.proxy } : undefined,
  };
}

export async function resolveUserAgent(browser: Browser, cfg: AuditConfig): Promise<string> {
  if (cfg.browser.userAgent) return cfg.browser.userAgent;
  const ctx = await browser.newContext();
  const ua = await (await ctx.newPage()).evaluate(() => navigator.userAgent);
  await ctx.close();
  return cfg.browser.userAgentSuffix ? `${ua} ${cfg.browser.userAgentSuffix}` : ua;
}

/** Costruisce le sessioni da eseguire per un sito a partire dal campione. */
export function planSessions(cfg: AuditConfig, discovery: DiscoveryResult, siteIndex: number, startId: number): SessionPlan[] {
  const site = cfg.siti[siteIndex];
  const sample = discovery.sample;
  const host = new URL(discovery.site).hostname;
  const plans: SessionPlan[] = [];
  const active = new Set(cfg.scenari.attivi);
  let n = startId;
  const id = (scenario: ScenarioName) => `S${String(n++).padStart(3, '0')}_${slug(host, 40)}_${scenario}`;
  const following = (from: number) => {
    const out: string[] = [];
    for (let k = 1; out.length < cfg.scenari.pagineDopoScelta && k <= sample.length; k++) {
      const next = sample[(from + k) % sample.length].url;
      if (next !== sample[from].url || sample.length === 1) out.push(next);
    }
    return out.length ? out : [sample[from].url];
  };

  if (active.has('nessuna-azione')) {
    for (const p of sample) plans.push({ id: id('nessuna-azione'), site: discovery.site, siteConfig: site, scenario: 'nessuna-azione', pageType: p.type, pages: [p.url] });
  }
  const choiceScenarios = (['rifiuta', 'accetta'] as const).filter((s) => active.has(s));
  const starts = cfg.scenari.modalita === 'per-pagina' ? sample.map((_, i) => i) : [0];
  for (const i of starts) {
    for (const scenario of choiceScenarios) {
      plans.push({ id: id(scenario), site: discovery.site, siteConfig: site, scenario, pageType: sample[i].type, pages: [sample[i].url, ...following(i)] });
    }
  }
  return plans;
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p)];
  });
}

async function hashFiles(runDir: string, paths: string[]) {
  const out = [];
  for (const p of paths.sort()) {
    const abs = join(runDir, p);
    out.push({ path: p.split('\\').join('/'), sha256: await sha256File(abs), bytes: statSync(abs).size });
  }
  return out;
}

/** Copia le evidenze di ogni criticità con il numero della criticità nel nome. */
function linkEvidenceToFindings(runDir: string, findings: Finding[]) {
  const dir = join(runDir, 'evidenze', 'criticita');
  mkdirSync(dir, { recursive: true });
  for (const f of findings) {
    f.evidence = f.evidence.map((e) => {
      if (!e.file.endsWith('.png')) return e;
      const rel = `evidenze/criticita/${f.id}_${basename(e.file)}`;
      try {
        copyFileSync(join(runDir, e.file), join(runDir, rel));
        return { ...e, file: rel };
      } catch {
        return e;
      }
    });
    if (f.requestExcerpt) {
      const rel = `evidenze/criticita/${f.id}_estratto-richiesta.json`;
      writeFileSync(join(runDir, rel), JSON.stringify(f.requestExcerpt, null, 2));
      f.evidence.push({ label: 'estratto richiesta', file: rel });
    }
  }
}

export async function runAudit(loaded: LoadedConfig, opts: RunOptions = {}): Promise<RunResult> {
  const { config } = loaded;
  const log = opts.log ?? ((m: string) => console.log(m));
  const startedAt = new Date().toISOString();
  const runDir = join(opts.outDir ?? loaded.resolvePath(config.output), `${timestampForPath()}_${slug(config.cliente, 40)}`);
  mkdirSync(join(runDir, 'evidenze'), { recursive: true });
  log(`Cartella esecuzione: ${runDir}`);

  const normsPath = config.norme ? loaded.resolvePath(config.norme) : DEFAULT_NORMS_FILE;
  const norms = loadNorms(normsPath);
  const extra: TrackerEntry[] = config.trackerExtra ? Classifier.loadExtraTrackers(loaded.resolvePath(config.trackerExtra)) : [];
  const classifier = new Classifier(extra);

  const browser = await chromium.launch(launchOptions(config));
  const sessions: SessionResult[] = [];
  const discovery: DiscoveryResult[] = [];
  const declared: DeclaredSet[] = [];
  let userAgent = '';
  let browserVersion = '';
  let exit: ExitInfo = {
    verified: false,
    ip: null,
    country: null,
    declared: config.browser.paeseUscita.toUpperCase(),
    source: '',
    matches: false,
    inEu: null,
    note: 'Verifica del paese di uscita disattivata nella configurazione: vale solo quello dichiarato.',
  };

  try {
    browserVersion = `Chromium ${browser.version()}`;
    userAgent = await resolveUserAgent(browser, config);
    if (config.browser.verificaUscita !== 'no') {
      exit = await detectExit(browser, config.browser.servizioUscita, config.browser.paeseUscita);
      log(`Uscita: ${exit.note}${exit.ip ? ` IP ${exit.ip}.` : ''}`);
      if (config.browser.verificaUscita === 'blocca' && !exit.matches) {
        throw new Error(`Esecuzione interrotta: ${exit.note} (impostare browser.verificaUscita: avvisa per proseguire comunque)`);
      }
    }

    let nextId = 1;
    for (let i = 0; i < config.siti.length; i++) {
      const site = config.siti[i];
      log(`\n[${site.url}] scoperta pagine…`);
      const d = await discoverSite(browser, site, config, userAgent);
      discovery.push(d);
      log(`  ${d.found} URL trovate, campione di ${d.sample.length} pagine`);

      const decl: DeclaredSet = { site: d.site, source: null, items: [] };
      if (site.dichiarati) {
        const path = loaded.resolvePath(site.dichiarati);
        decl.items = loadDeclaredFile(path);
        decl.source = `file ${basename(path)}`;
        decl.note = 'Elenco fornito nella configurazione (prevale sulla lettura dal CMP).';
      }
      declared.push(decl);

      const plans = planSessions(config, d, i, nextId);
      nextId += plans.length;
      for (const plan of plans) {
        log(`  ${plan.id} (${plan.pages.length} pagine)…`);
        const res = await runSession(browser, plan, {
          config,
          runDir,
          classifier,
          userAgent,
          onDeclared: decl.source
            ? undefined
            : (items, cmp) => {
                if (decl.source) return;
                decl.items = items;
                decl.source = `CMP ${cmp}`;
              },
        });
        const i2 = res.interaction;
        log(`    banner: ${i2.bannerVisibleBefore ? 'sì' : 'no'}; metodo: ${i2.method}; esito: ${i2.outcome}; verifica: ${i2.verification}; cookie: ${res.cookies.length}; richieste: ${res.requests.length}`);
        sessions.push(res);
        await sleep(config.protocollo.pausaTraSessioni);
      }
      if (!decl.source) decl.note = 'Nessun elenco leggibile dal CMP e nessun file configurato: confronto con i dichiarati non eseguito.';
    }
  } finally {
    await browser.close();
  }

  const comparison: ComparisonRow[] = declared.flatMap((d) =>
    compareDeclared(d.site, sessions.filter((s) => s.site === d.site), d),
  );
  const findings = evaluateRules({ config, sessions, declared, comparison, exit }, norms);
  linkEvidenceToFindings(runDir, findings);

  const evidenceFiles = await hashFiles(runDir, listFiles(join(runDir, 'evidenze')).map((p) => join('evidenze', p)));
  const endedAt = new Date().toISOString();

  writeFileSync(join(runDir, 'dati.json'), JSON.stringify({ discovery, sessions, declared, comparison, findings }, null, 2));
  const csvs = writeCsvs(runDir, sessions, comparison, findings);
  const html = renderHtml({
    config,
    toolVersion: TOOL_VERSION,
    browserVersion,
    userAgent,
    startedAt,
    endedAt,
    discovery,
    sessions,
    declared,
    comparison,
    findings,
    files: evidenceFiles,
    normsPath: basename(normsPath),
    exit,
  });
  writeFileSync(join(runDir, 'report.html'), html);

  const wantPdf = opts.pdf ?? config.report.pdf;
  if (wantPdf) {
    const pdfBrowser = await chromium.launch(launchOptions(config, true));
    try {
      const page = await pdfBrowser.newPage();
      await page.goto(pathToFileURL(join(runDir, 'report.html')).toString(), { waitUntil: 'load' });
      await page.pdf({ path: join(runDir, 'report.pdf'), format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    } catch (e) {
      log(`PDF non generato: ${(e as Error).message.split('\n')[0]}`);
    } finally {
      await pdfBrowser.close();
    }
  }

  const ocdPath = fileURLToPath(new URL('../../data/vendor/open-cookie-database.csv', import.meta.url));
  const allFiles = await hashFiles(runDir, listFiles(runDir).filter((p) => p !== 'manifest.json'));
  const manifest = {
    strumento: { nome: 'scookie', versione: TOOL_VERSION },
    cliente: config.cliente,
    inizio: startedAt,
    fine: endedAt,
    ambiente: { node: process.version, piattaforma: `${process.platform} ${process.arch}`, browser: browserVersion, userAgent, uscita: exit },
    configurazione: { file: basename(loaded.path), sha256: sha256(loaded.raw), contenuto: loaded.raw },
    norme: { file: basename(normsPath), sha256: await sha256File(normsPath) },
    datiClassificazione: {
      openCookieDatabase: { licenza: 'Apache-2.0', sha256: await sha256File(ocdPath) },
      trackerExtra: config.trackerExtra ? basename(config.trackerExtra) : null,
    },
    sessioni: sessions.length,
    criticita: findings.length,
    csv: csvs,
    file: allFiles,
  };
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(runDir, 'manifest.json.sha256'), `${await sha256File(join(runDir, 'manifest.json'))}  manifest.json\n`);
  log(`\nCompletato: ${sessions.length} sessioni, ${findings.length} criticità. Report: ${join(runDir, 'report.html')}`);
  return { runDir, findings, sessions };
}
