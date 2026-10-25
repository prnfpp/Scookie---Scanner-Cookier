import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type LaunchOptions, type Page } from 'playwright';
import { Classifier, type TrackerEntry } from './classify/classifier.js';
import type { LoadedConfig } from './config/load.js';
import type { AuditConfig } from './config/schema.js';
import { compareDeclared } from './declared/compare.js';
import { loadDeclaredFile } from './declared/declared.js';
import { readPolicyDeclared } from './declared/policy.js';
import { discoverSite, type DiscoveryResult } from './discovery/discover.js';
import { detectExit, type ExitInfo } from './browser/exit.js';
import { runSession, type SessionPlan } from './browser/session.js';
import { renderHtml } from './report/html.js';
import { writeCsvs } from './report/csv.js';
import { REVIEW_FILE, writeReviewTemplate } from './report/review.js';
import { DEFAULT_NORMS_FILE, evaluateRules, loadNorms } from './rules/engine.js';
import type { ComparisonRow, DeclaredSet, Finding, ScenarioName, SessionResult } from './types.js';
import { closeSafely, sha256, sha256File, sleep, slug, timestampForPath } from './util/misc.js';
import { TOOL_VERSION } from './version.js';

export interface RunOptions {
  outDir?: string;
  pdf?: boolean;
  log?: (msg: string) => void;
  /** Solo test: simula l'operatore nelle sessioni con navigazione manuale (il browser resta senza finestra). */
  manualDriver?: (page: Page) => Promise<void>;
}

export interface RunResult {
  runDir: string;
  findings: Finding[];
  sessions: SessionResult[];
}

export function launchOptions(cfg: AuditConfig, headless = cfg.browser.headless): LaunchOptions {
  const args: string[] = [];
  if (cfg.browser.hostResolverRules) {
    // Solo per i test: tutti gli host puntano a 127.0.0.1 e la protezione della rete locale di Chromium
    // bloccherebbe le letture di robots.txt e sitemap fatte dal documento fittizio (vedi discovery).
    args.push(`--host-resolver-rules=${cfg.browser.hostResolverRules}`, '--disable-features=LocalNetworkAccessChecks');
  }
  return {
    headless,
    args,
    channel: cfg.browser.canale === 'chromium' ? undefined : cfg.browser.canale,
    executablePath: cfg.browser.executablePath,
    proxy: cfg.browser.proxy ? { server: cfg.browser.proxy } : undefined,
  };
}

export async function resolveUserAgent(browser: Browser, cfg: AuditConfig): Promise<string> {
  if (cfg.browser.userAgent) return cfg.browser.userAgent;
  const ctx = await browser.newContext();
  const ua = await (await ctx.newPage()).evaluate(() => navigator.userAgent);
  await closeSafely(ctx, 15000);
  // Esecuzione di controllo: lo user agent di un browser qualunque, senza dichiarazione dell'audit
  if (cfg.browser.uaNormale) return ua.replace('HeadlessChrome', 'Chrome');
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
    for (const [k, p] of sample.entries()) {
      plans.push({ id: id('nessuna-azione'), site: discovery.site, siteConfig: site, scenario: 'nessuna-azione', pageType: p.type, pages: [p.url], analyzeBanner: k === 0 });
    }
  }
  const choiceScenarios = (['rifiuta', 'accetta', 'personalizza', 'revoca'] as const).filter((s) => active.has(s));
  const starts = cfg.scenari.modalita === 'per-pagina' ? sample.map((_, i) => i) : [0];
  for (const i of starts) {
    for (const scenario of choiceScenarios) {
      plans.push({
        id: id(scenario),
        site: discovery.site,
        siteConfig: site,
        scenario,
        pageType: sample[i].type,
        pages: [sample[i].url, ...following(i)],
        revokePage: scenario === 'revoca' ? discovery.revokePages?.[0] : undefined,
      });
    }
  }
  // Navigazione manuale: una sessione per scenario richiesto, dalla pagina di partenza indicata
  const m = site.navigazioneManuale;
  if (m) {
    const start = m.partenza ? new URL(m.partenza, discovery.site).toString() : sample[0].url;
    for (const scenario of m.scenari) {
      plans.push({
        id: `${id(scenario)}-manuale`,
        site: discovery.site,
        siteConfig: site,
        scenario,
        pageType: 'navigazione manuale',
        pages: [start],
        manual: { instructions: m.istruzioni, maxMs: m.maxMinuti * 60000 },
      });
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

/** Host delle richieste senza risposta in una sessione, per spiegare un banner mancante. */
function failedHosts(s: SessionResult): string {
  const hosts = [...new Set(s.requests.filter((r) => r.failure).map((r) => r.host))];
  return hosts.slice(0, 5).join(', ') + (hosts.length > 5 ? ` e altri ${hosts.length - 5}` : '');
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

  // Con la navigazione manuale il browser deve avere una finestra (salvo nei test, dove l'operatore è simulato)
  const manualSites = config.siti.filter((s) => s.navigazioneManuale);
  if (manualSites.length && !opts.manualDriver) {
    log(`Navigazione manuale prevista per: ${manualSites.map((s) => s.url).join(', ')}. Il browser si aprirà in una finestra: restare al computer.`);
  }
  const browser = await chromium.launch(launchOptions(config, manualSites.length && !opts.manualDriver ? false : config.browser.headless));
  const sessions: SessionResult[] = [];
  const discovery: DiscoveryResult[] = [];
  const declared: DeclaredSet[] = [];
  /** Sessioni sostituite da una ripetizione (restano nei dati e nelle evidenze). */
  const discarded: SessionResult[] = [];
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
      const exec = async (plan: SessionPlan) => {
        log(`  ${plan.id} (${plan.pages.length} pagine)…`);
        const res = await runSession(browser, plan, {
          config,
          runDir,
          classifier,
          userAgent,
          manualDriver: opts.manualDriver,
          log,
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
        await sleep(config.protocollo.pausaTraSessioni);
        return res;
      };
      const siteResults: SessionResult[] = [];
      for (const plan of plans) siteResults.push(await exec(plan));

      // Se il sito mostra il banner in alcune sessioni e non in altre, le sessioni senza banner
      // si ripetono una volta: spesso lo script del CMP non è stato scaricato (errore di rete).
      // La sessione scartata resta tra i dati e le evidenze, per trasparenza.
      // Non si ripetono le sessioni bloccate da un sistema anti-bot (ripetere non aiuta e insiste sul sito),
      // e le ripetizioni si fermano se una ripetizione non mostra il banner o dopo MAX_RETRIES tentativi.
      const MAX_RETRIES = 3;
      let retries = 0;
      const valid = (s: SessionResult) => !s.blocked;
      if (siteResults.some((s) => valid(s) && s.interaction.bannerVisibleBefore)) {
        for (let k = 0; k < siteResults.length && retries < MAX_RETRIES; k++) {
          const first = siteResults[k];
          if (first.interaction.bannerVisibleBefore || !valid(first) || first.manual) continue;
          retries++;
          const plan = plans.find((p) => p.id === first.id)!;
          log(`    banner assente solo in questa sessione: ripetizione di ${first.id}`);
          const retry = await exec({ ...plan, id: `${plan.id}_ripetuta` });
          retry.retryOf = first.id;
          const failed = failedHosts(first);
          retry.errors.unshift(
            `Ripetizione di ${first.id}: in quella sessione il banner non è comparso${failed ? `; richieste senza risposta verso ${failed}` : ''}.`,
          );
          discarded.push(first);
          siteResults[k] = retry;
          if (!retry.interaction.bannerVisibleBefore || retry.blocked) break;
        }
      }
      const blockedCount = siteResults.filter((s) => s.blocked).length;
      if (blockedCount) log(`    ${blockedCount} sessioni su ${siteResults.length} bloccate da un sistema anti-bot: escluse dalle regole`);
      sessions.push(...siteResults);
      if (!decl.source) {
        // Ultima fonte: le tabelle della cookie policy (indirizzo configurato, link nel banner, pagina "cookie" scoperta).
        const fromBanner = siteResults.find((s) => s.bannerAnalysis?.policyLink?.href)?.bannerAnalysis?.policyLink?.href;
        const fromSample = d.sample.find((p) => /cookie/i.test(new URL(p.url).pathname))?.url;
        const policyUrl = site.cookiePolicy ?? (fromBanner && /cookie/i.test(fromBanner) ? fromBanner : undefined) ?? fromSample ?? fromBanner;
        if (policyUrl) {
          log(`  lettura dell'elenco dichiarato dalla cookie policy: ${policyUrl}`);
          const items = await readPolicyDeclared(browser, new URL(policyUrl, site.url).toString(), userAgent, config.browser.locale).catch((e: Error) => {
            log(`    non riuscita: ${e.message.split('\n')[0]}`);
            return [];
          });
          if (items.length) {
            decl.items = items;
            decl.source = `cookie policy (${policyUrl})`;
            decl.note = 'Elenco ricavato dalle tabelle della cookie policy: va verificato a vista, la struttura delle pagine varia.';
          }
        }
      }
      if (!decl.source) decl.note = 'Nessun elenco leggibile dal CMP, dalla cookie policy o da un file configurato: confronto con i dichiarati non eseguito.';
    }
  } finally {
    await browser.close();
  }

  // Le sessioni bloccate da un sistema anti-bot non descrivono il sito: restano nei dati ma non entrano nelle regole.
  const validSessions = sessions.filter((s) => !s.blocked);
  const blockedSessions = sessions.filter((s) => s.blocked);
  const comparison: ComparisonRow[] = declared.flatMap((d) =>
    compareDeclared(d.site, validSessions.filter((s) => s.site === d.site), d),
  );
  const findings = evaluateRules({ config, sessions: validSessions, blocked: blockedSessions, declared, comparison, exit, discovery }, norms);
  linkEvidenceToFindings(runDir, findings);

  const evidenceFiles = await hashFiles(runDir, listFiles(join(runDir, 'evidenze')).map((p) => join('evidenze', p)));
  const endedAt = new Date().toISOString();

  writeFileSync(join(runDir, 'dati.json'), JSON.stringify({ discovery, sessions, sessioniScartate: discarded, declared, comparison, findings }, null, 2));
  const csvs = writeCsvs(runDir, sessions, comparison, findings);
  // Modulo per la revisione manuale delle schede (con i giudizi già dati nell'esecuzione precedente, se ci sono)
  const rev = writeReviewTemplate(runDir, findings, config.cliente);
  if (rev.prefilled) log(`Revisione: ${rev.prefilled} schede precompilate dalla revisione di ${rev.from}`);
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
  // revisione.csv è un modulo da compilare dopo l'esecuzione: non entra nelle impronte (lo traccia revisione-applicata.json)
  const allFiles = await hashFiles(runDir, listFiles(runDir).filter((p) => p !== 'manifest.json' && p !== REVIEW_FILE));
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
