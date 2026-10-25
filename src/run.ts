import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { trimHar } from './browser/har.js';
import { basename, dirname, join, relative } from 'node:path';
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
import { ProgressTracker, type Progress } from './progress.js';
import { setTestData } from './util/pii.js';
import { keepAwake } from './util/awake.js';
import type { RecordedPath } from './browser/replay.js';
import { findingScore } from './report/summary.js';

const SEV_ORDER = ['alta', 'media', 'bassa', 'informativa'];

export interface RunOptions {
  outDir?: string;
  pdf?: boolean;
  log?: (msg: string) => void;
  /** Solo test: simula l'operatore nelle sessioni con navigazione manuale (il browser resta senza finestra). */
  manualDriver?: (page: Page) => Promise<void>;
  /** Riceve la funzione che chiude la navigazione manuale in corso (null quando non ce n'è una). */
  onManualFinisher?: (finish: (() => void) | null) => void;
  /** Avanzamento per l'interfaccia (fase, sessioni, tempo stimato). */
  onProgress?: (p: Progress) => void;
  /** Esegue solo questi siti della configurazione (indirizzi), es. per ripetere quelli non raggiunti. */
  onlySites?: string[];
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
/** Errori di Chromium dovuti alla connessione del computer (non al sito): computer in stop, rete caduta. */
const NETWORK_ERROR = /net::ERR_(INTERNET_DISCONNECTED|NETWORK_IO_SUSPENDED|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|ADDRESS_UNREACHABLE)/;

/** Attende che il sito torni raggiungibile (fino a 5 minuti). */
async function waitOnline(browser: Browser, url: string, log: (m: string) => void): Promise<boolean> {
  const ctx = await browser.newContext();
  try {
    for (let k = 0; k < 30; k++) {
      const ok = await ctx.request
        .get(url, { timeout: 10000, maxRedirects: 5 })
        .then(() => true)
        .catch(() => false);
      if (ok) return true;
      await sleep(10000);
    }
    log('  connessione non ripristinata entro 5 minuti: le sessioni restano non valide');
    return false;
  } finally {
    await closeSafely(ctx, 10000);
  }
}

export function planSessions(cfg: AuditConfig, discovery: DiscoveryResult, siteIndex: number, startId: number, recording?: RecordedPath | null): SessionPlan[] {
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

  // Con le ripetizioni ogni scenario si esegue più volte, ciascuna con un profilo nuovo (id con suffisso -r2, -r3)
  const reps = cfg.scenari.ripetizioni;
  for (let r = 1; r <= reps; r++) {
    const rid = (scenario: ScenarioName) => `${id(scenario)}${reps > 1 ? `-r${r}` : ''}`;
    const repeat = reps > 1 ? r : undefined;
    if (active.has('nessuna-azione')) {
      for (const [k, p] of sample.entries()) {
        plans.push({ id: rid('nessuna-azione'), site: discovery.site, siteConfig: site, scenario: 'nessuna-azione', pageType: p.type, pages: [p.url], analyzeBanner: k === 0, repeat });
      }
    }
    const choiceScenarios = (['rifiuta', 'accetta', 'personalizza', 'revoca'] as const).filter((s) => active.has(s));
    const starts = cfg.scenari.modalita === 'per-pagina' ? sample.map((_, i) => i) : [0];
    for (const i of starts) {
      for (const scenario of choiceScenarios) {
        plans.push({
          id: rid(scenario),
          site: discovery.site,
          siteConfig: site,
          scenario,
          pageType: sample[i].type,
          pages: [sample[i].url, ...following(i)],
          revokePage: scenario === 'revoca' ? discovery.revokePages?.[0] : undefined,
          repeat,
        });
      }
    }
  }
  // Navigazione manuale: una sessione per scenario richiesto, dalla pagina di partenza indicata
  const m = site.navigazioneManuale;
  if (m) {
    // "www.esempio.it/preventivo" senza https:// è un indirizzo, non un percorso del sito
    const partenza = m.partenza && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(m.partenza) ? `https://${m.partenza}` : m.partenza;
    const start = partenza ? new URL(partenza, discovery.site).toString() : sample[0].url;
    // Percorso già registrato in un audit precedente: si rigioca in automatico, in ogni ripetizione
    if (recording?.steps.length) {
      for (let r = 1; r <= reps; r++) {
        for (const scenario of m.scenari) {
          plans.push({
            id: `${id(scenario)}-percorso${reps > 1 ? `-r${r}` : ''}`,
            site: discovery.site,
            siteConfig: site,
            scenario,
            pageType: 'percorso registrato',
            pages: [recording.start],
            replay: recording,
            repeat: reps > 1 ? r : undefined,
          });
        }
      }
      return plans;
    }
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

/** File del percorso registrato di un sito, accanto alla configurazione (cartella percorsi/). */
export function recordingFile(configPath: string, siteUrl: string): string {
  const name = basename(configPath).replace(/\.ya?ml$/i, '');
  return join(dirname(configPath), 'percorsi', `${name}_${new URL(siteUrl).hostname}.json`);
}
const recordingPath = (loaded: LoadedConfig, siteUrl: string) => recordingFile(loaded.path, siteUrl);

function readRecording(path: string): RecordedPath | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RecordedPath) : null;
  } catch {
    return null;
  }
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

/**
 * HAR più leggeri da consegnare: le sessioni non citate in nessuna scheda perdono i corpi delle risposte (restano
 * richieste, intestazioni, cookie, tempi e dati inviati ai terzi), poi tutti i HAR si comprimono in .har.gz.
 */
function compressHars(runDir: string, sessions: SessionResult[], findings: Finding[], mode: 'tutti' | 'testo' | 'nessuno') {
  const cited = new Set(findings.flatMap((f) => [...f.evidence.map((e) => e.file), String(f.requestExcerpt?.har ?? '')]).filter((x) => x.endsWith('.har')));
  const renamed = new Map<string, string>();
  for (const s of sessions) {
    if (!s.har?.endsWith('.har')) continue;
    const path = join(runDir, s.har);
    if (!existsSync(path)) continue;
    try {
      if (!cited.has(s.har) && mode !== 'nessuno') trimHar(path, 'nessuno');
      writeFileSync(`${path}.gz`, gzipSync(readFileSync(path)));
      rmSync(path);
      renamed.set(s.har, `${s.har}.gz`);
      s.har = `${s.har}.gz`;
    } catch (e) {
      s.errors.push(`compressione del file HAR non riuscita: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  for (const f of findings) {
    f.evidence = f.evidence.map((e) => (renamed.has(e.file) ? { ...e, file: renamed.get(e.file)! } : e));
    const har = f.requestExcerpt?.har;
    if (typeof har === 'string' && renamed.has(har)) f.requestExcerpt!.har = renamed.get(har);
  }
}

/** Host delle richieste senza risposta in una sessione, per spiegare un banner mancante. */
function failedHosts(s: SessionResult): string {
  const hosts = [...new Set(s.requests.filter((r) => r.failure).map((r) => r.host))];
  return hosts.slice(0, 5).join(', ') + (hosts.length > 5 ? ` e altri ${hosts.length - 5}` : '');
}

export async function runAudit(loaded: LoadedConfig, opts: RunOptions = {}): Promise<RunResult> {
  const config = opts.onlySites?.length
    ? { ...loaded.config, siti: loaded.config.siti.filter((s) => opts.onlySites!.some((u) => new URL(u).hostname === new URL(s.url).hostname)) }
    : loaded.config;
  if (!config.siti.length) throw new Error('Nessuno dei siti indicati è nella configurazione');
  // dati inseriti dall'operatore: riconosciuti come prova certa e riportati in chiaro
  setTestData(config.datiDiProva);
  const releaseAwake = keepAwake(opts.log ?? ((m: string) => console.log(m)));
  try {
    return await runAuditInner(loaded, opts, config);
  } finally {
    releaseAwake();
  }
}

async function runAuditInner(loaded: LoadedConfig, opts: RunOptions, config: AuditConfig): Promise<RunResult> {
  const progress = new ProgressTracker(opts.onProgress ?? (() => {}), 30 + (opts.pdf ?? config.report.pdf ? 20 : 0) + 5 * config.siti.length);
  const log = opts.log ?? ((m: string) => console.log(m));
  const startedAt = new Date().toISOString();
  const runDir = join(opts.outDir ?? loaded.resolvePath(config.output), `${timestampForPath()}_${slug(config.cliente, 40)}`);
  mkdirSync(join(runDir, 'evidenze'), { recursive: true });
  log(`Cartella esecuzione: ${runDir}`);

  const normsPath = config.norme ? loaded.resolvePath(config.norme) : DEFAULT_NORMS_FILE;
  const norms = loadNorms(normsPath);
  const extra: TrackerEntry[] = config.trackerExtra ? Classifier.loadExtraTrackers(loaded.resolvePath(config.trackerExtra)) : [];
  const classifier = new Classifier(extra);

  // Solo le navigazioni manuali hanno una finestra (un browser a parte, chiuso a fine fase); scoperta e sessioni
  // automatiche restano senza finestra, così il computer resta utilizzabile. Nei test l'operatore è simulato.
  const manualSites = config.siti.filter((s) => s.navigazioneManuale);
  if (manualSites.length && !opts.manualDriver) {
    log(`Navigazione manuale prevista per: ${manualSites.map((s) => s.url).join(', ')}. Il browser si aprirà in una finestra: restare al computer.`);
  }
  const headless = config.browser.headless;
  const browser = await chromium.launch(launchOptions(config, headless));
  let manualBrowser: Browser | null = null;
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
    progress.phase('uscita', 'verifica del paese di uscita');
    if (config.browser.verificaUscita !== 'no') {
      exit = await detectExit(browser, config.browser.servizioUscita, config.browser.paeseUscita);
      log(`Uscita: ${exit.note}${exit.ip ? ` IP ${exit.ip}.` : ''}`);
      if (config.browser.verificaUscita === 'blocca' && !exit.matches) {
        throw new Error(`Esecuzione interrotta: ${exit.note} (impostare browser.verificaUscita: avvisa per proseguire comunque)`);
      }
    }

    // Fase 1: scoperta delle pagine e piano delle sessioni per tutti i siti.
    // Fase 2: navigazioni manuali di tutti i siti, subito, così l'operatore serve solo all'inizio.
    // Fase 3: sessioni automatiche, che possono proseguire senza nessuno al computer.
    let nextId = 1;
    const jobs: { i: number; site: AuditConfig['siti'][number]; d: DiscoveryResult; decl: DeclaredSet; plans: SessionPlan[]; manual: SessionResult[] }[] = [];
    for (let i = 0; i < config.siti.length; i++) {
      const site = config.siti[i];
      log(`\n[${site.url}] scoperta pagine…`);
      progress.phase('scoperta', `${new URL(site.url).hostname} (${i + 1} di ${config.siti.length})`);
      let d = await discoverSite(browser, site, config, userAgent);
      if (d.notes.some((n) => NETWORK_ERROR.test(n))) {
        // Connessione caduta durante la scoperta (es. computer in stop): si aspetta che torni e si ripete una volta
        log('  connessione assente durante la scoperta: attesa del ripristino…');
        progress.wait('connessione');
        const back = await waitOnline(browser, site.url, log);
        progress.wait(null);
        if (back) d = await discoverSite(browser, site, config, userAgent);
      }
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
      const plans = planSessions(config, d, i, nextId, site.navigazioneManuale ? readRecording(recordingPath(loaded, site.url)) : null);
      nextId += plans.length;
      jobs.push({ i, site, d, decl, plans, manual: [] });
    }
    for (const j of jobs) progress.plan(j.d.site, j.plans.filter((p) => !p.manual).length, j.plans.filter((p) => p.manual).length);

    const exec = async (job: (typeof jobs)[number], plan: SessionPlan) => {
      const { decl } = job;
      log(`  ${plan.id} (${plan.pages.length} pagine)…`);
      const t0 = Date.now();
      progress.start(`${new URL(plan.site).hostname} · ${plan.scenario}${plan.manual ? ' (navigazione manuale)' : ''}${plan.repeat ? ` · ripetizione ${plan.repeat}` : ''}`);
      if (plan.manual) progress.wait('manuale');
      if (plan.manual && !opts.manualDriver && headless && !manualBrowser) manualBrowser = await chromium.launch(launchOptions(config, false));
      const res = await runSession(plan.manual && manualBrowser ? manualBrowser : browser, plan, {
        config,
        runDir,
        classifier,
        userAgent,
        manualDriver: opts.manualDriver,
        onManualFinisher: opts.onManualFinisher,
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
      if (plan.manual) progress.wait(null);
      await sleep(config.protocollo.pausaTraSessioni);
      progress.finished(plan.site, (Date.now() - t0) / 1000, !!plan.manual);
      return res;
    };

    const manualPlans = jobs.flatMap((j) => j.plans.filter((p) => p.manual).map((p) => ({ j, p })));
    if (manualPlans.length) {
      log(`\nNavigazioni manuali (${manualPlans.length}): si fanno adesso, poi l'audit prosegue da solo.`);
      progress.phase('manuale');
      try {
        for (const { j, p } of manualPlans) j.manual.push(await exec(j, p));
      } finally {
        // assegnato dentro exec: TypeScript non lo vede
        await (manualBrowser as Browser | null)?.close().catch(() => {});
        manualBrowser = null;
      }
      log('\nNavigazioni manuali concluse: da qui l\'audit prosegue da solo. Il computer deve restare acceso, sveglio e collegato a internet.');
      // La navigazione più completa di ogni sito diventa il percorso registrato: dalla prossima esecuzione si
      // rigioca in automatico, in ogni ripetizione, senza operatore.
      for (const j of jobs) {
        const best = j.manual.filter((r) => r.manual?.endedBy === 'operatore' && r.manual.steps?.length).sort((a, b) => b.manual!.steps!.length - a.manual!.steps!.length)[0];
        if (!best) continue;
        const rec: RecordedPath = { site: j.site.url, start: j.plans.find((p) => p.manual)!.pages[0], savedAt: new Date().toISOString(), fromSession: best.id, steps: best.manual!.steps! };
        const path = recordingPath(loaded, j.site.url);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(rec, null, 2));
        log(`Percorso registrato (${rec.steps.length} passi) salvato in ${path}: dalla prossima esecuzione si rigioca in automatico.`);
      }
    }

    progress.phase('automatiche');
    for (const job of jobs) {
      const { site, d, decl } = job;
      const plans = job.plans.filter((p) => !p.manual);
      log(`\n[${site.url}] sessioni automatiche…`);
      const siteResults: SessionResult[] = [];
      for (const plan of plans) siteResults.push(await exec(job, plan));

      // Sessioni fallite per mancanza di connessione (es. computer in stop): si aspetta il ripristino e si ripetono una volta.
      // La sessione fallita resta tra i dati scartati.
      for (let k = 0; k < siteResults.length; k++) {
        const first = siteResults[k];
        if (!first.unreachable || !NETWORK_ERROR.test(first.unreachable)) continue;
        log(`    ${first.id}: connessione assente, attesa del ripristino…`);
        progress.wait('connessione');
        const back = await waitOnline(browser, site.url, log);
        progress.wait(null);
        if (!back) break;
        const plan = plans.find((p) => p.id === first.id)!;
        progress.extra(d.site);
        const retry = await exec(job, { ...plan, id: `${plan.id}_ripetuta` });
        retry.retryOf = first.id;
        retry.errors.unshift(`Ripetizione di ${first.id}: sessione fallita per mancanza di connessione (${first.unreachable}).`);
        discarded.push(first);
        siteResults[k] = retry;
      }

      // Se il sito mostra il banner in alcune sessioni e non in altre, le sessioni senza banner
      // si ripetono una volta: spesso lo script del CMP non è stato scaricato (errore di rete).
      // La sessione scartata resta tra i dati e le evidenze, per trasparenza.
      // Non si ripetono le sessioni bloccate da un sistema anti-bot (ripetere non aiuta e insiste sul sito),
      // e le ripetizioni si fermano se una ripetizione non mostra il banner o dopo MAX_RETRIES tentativi.
      const MAX_RETRIES = 3;
      let retries = 0;
      const valid = (s: SessionResult) => !s.blocked && !s.unreachable;
      if (siteResults.some((s) => valid(s) && s.interaction.bannerVisibleBefore)) {
        for (let k = 0; k < siteResults.length && retries < MAX_RETRIES; k++) {
          const first = siteResults[k];
          if (first.interaction.bannerVisibleBefore || !valid(first)) continue;
          retries++;
          const plan = plans.find((p) => p.id === first.id.replace(/_ripetuta$/, ''))!;
          log(`    banner assente solo in questa sessione: ripetizione di ${first.id}`);
          progress.extra(d.site);
          const retry = await exec(job, { ...plan, id: `${plan.id}_ripetuta${first.retryOf ? '2' : ''}` });
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
      siteResults.push(...job.manual);
      const blockedCount = siteResults.filter((s) => s.blocked).length;
      if (blockedCount) log(`    ${blockedCount} sessioni su ${siteResults.length} bloccate da un sistema anti-bot: escluse dalle regole`);
      const unreachableCount = siteResults.filter((s) => s.unreachable).length;
      if (unreachableCount) log(`    ${unreachableCount} sessioni su ${siteResults.length} senza accesso al sito: escluse dalle regole`);
      sessions.push(...siteResults);
      if (!decl.source) {
        // Ultima fonte: le tabelle della cookie policy (indirizzo configurato, link nel banner, pagina "cookie" scoperta).
        const fromBanner = siteResults.find((s) => s.bannerAnalysis?.policyLink?.href)?.bannerAnalysis?.policyLink?.href;
        const fromSample = d.sample.find((p) => /cookie/i.test(new URL(p.url).pathname))?.url;
        const policyUrl = site.cookiePolicy ?? (fromBanner && /cookie/i.test(fromBanner) ? fromBanner : undefined) ?? fromSample ?? fromBanner;
        if (policyUrl) {
          log(`  lettura dell'elenco dichiarato dalla cookie policy: ${policyUrl}`);
          const { items, skipped } = await readPolicyDeclared(browser, new URL(policyUrl, site.url).toString(), userAgent, config.browser.locale).catch((e: Error) => {
            log(`    non riuscita: ${e.message.split('\n')[0]}`);
            return { items: [], skipped: [] as string[] };
          });
          if (items.length) {
            decl.items = items;
            decl.source = `cookie policy (${policyUrl})`;
            decl.note =
              'Elenco ricavato dalle tabelle della cookie policy: va verificato a vista, la struttura delle pagine varia.' +
              (skipped.length ? ` ${skipped.length} righe non lette perché la prima colonna non contiene un nome di cookie (es. "${skipped.slice(0, 3).join('", "')}"): per un confronto completo fornire l'elenco a mano (file dei dichiarati).` : '');
          }
        }
      }
      if (!decl.source) decl.note = 'Nessun elenco leggibile dal CMP, dalla cookie policy o da un file configurato: confronto con i dichiarati non eseguito.';
    }
  } finally {
    await browser.close();
  }

  // Le sessioni bloccate da un sistema anti-bot o senza accesso al sito non descrivono il sito:
  // restano nei dati ma non entrano nelle regole.
  const validSessions = sessions.filter((s) => !s.blocked && !s.unreachable);
  const blockedSessions = sessions.filter((s) => s.blocked);
  const comparison: ComparisonRow[] = declared.flatMap((d) =>
    compareDeclared(d.site, validSessions.filter((s) => s.site === d.site), d),
  );
  progress.phase('report', 'regole, report e allegati');
  const findings = evaluateRules({ config, sessions: validSessions, blocked: blockedSessions, declared, comparison, exit, discovery }, norms);
  // Ripetizioni: le regole si valutano anche su ogni ripetizione da sola; per ogni scheda si conta in quante compare.
  // Le navigazioni manuali non si ripetono e non entrano nel conteggio.
  const reps = config.scenari.ripetizioni;
  // Ripetibilità, sito per sito: lo stesso fatto può essere ripetuto su un sito e venire da una sessione manuale
  // (fatta una volta) su un altro.
  const manualSessions = validSessions.filter((s) => s.manual);
  if (reps > 1 || manualSessions.length) {
    const hostOf = (u: string) => new URL(u).hostname;
    const rawKeys = (subset: SessionResult[]) => {
      const comp = declared.flatMap((d) => compareDeclared(d.site, subset.filter((s) => s.site === d.site), d));
      const ctx = { config, sessions: subset, blocked: blockedSessions, declared, comparison: comp, exit, discovery };
      return new Set(evaluateRules(ctx, norms, { merge: false }).map((f) => `${f.key}@${hostOf(f.site)}`));
    };
    const seen = new Map<string, number>();
    if (reps > 1) {
      for (let r = 1; r <= reps; r++) for (const k of rawKeys(validSessions.filter((s) => s.repeat === r))) seen.set(k, (seen.get(k) ?? 0) + 1);
    } else {
      for (const k of rawKeys(validSessions.filter((s) => !s.manual))) seen.set(k, 1);
    }
    const manualKeys = manualSessions.length ? rawKeys(manualSessions) : new Set<string>();
    for (const f of findings) {
      if (!f.key) continue;
      const perSite = [...new Set(f.sites.map(hostOf))].map((host) => {
        const n = seen.get(`${f.key}@${host}`) ?? 0;
        // non visto nelle sessioni automatiche: viene da una sessione manuale, fatta una volta sola
        return n === 0 && manualKeys.has(`${f.key}@${host}`) ? { host, seen: 1, of: 1, manual: true } : { host, seen: Math.max(1, n), of: reps };
      });
      const best = perSite.filter((p) => !p.manual).sort((a, b) => b.seen - a.seen)[0];
      if (!best && perSite.length) f.repeats = { seen: 1, of: 1, manual: true, perSite };
      else if (best && reps > 1) f.repeats = { seen: best.seen, of: reps, perSite };
      else if (best && perSite.some((p) => p.manual)) f.repeats = { seen: 1, of: 1, perSite };
    }
  }
  if (config.report.harCompressi) compressHars(runDir, [...sessions, ...discarded], findings, config.report.harContenuti);

  // Ordine delle schede: gravità, poi forza della prova e ripetibilità
  findings.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || findingScore(b) - findingScore(a));
  findings.forEach((f, i) => (f.id = `C-${String(i + 1).padStart(3, '0')}`));
  linkEvidenceToFindings(runDir, findings);

  const evidenceFiles = await hashFiles(runDir, listFiles(join(runDir, 'evidenze')).map((p) => join('evidenze', p)));
  const endedAt = new Date().toISOString();

  writeFileSync(join(runDir, 'dati.json'), JSON.stringify({ discovery, sessions, sessioniScartate: discarded, declared, comparison, findings }, null, 2));
  const csvs = writeCsvs(runDir, sessions, comparison, findings);
  // Riepilogo leggero per l'interfaccia (l'elenco delle esecuzioni non deve leggere dati.json, che può essere grande)
  const unreachableSites = [...new Set(sessions.filter((s) => s.unreachable).map((s) => s.site))].filter((site) =>
    sessions.filter((s) => s.site === site).every((s) => s.unreachable || s.blocked),
  );
  writeFileSync(
    join(runDir, 'riepilogo.json'),
    JSON.stringify(
      {
        cliente: config.cliente,
        configurazione: basename(loaded.path),
        siti: config.siti.map((s) => s.url),
        sitiSenzaDati: unreachableSites,
        sessioniNonValide: sessions.filter((s) => s.unreachable || s.blocked).length,
        gravita: Object.fromEntries((['alta', 'media', 'bassa', 'informativa'] as const).map((g) => [g, findings.filter((f) => f.severity === g).length])),
        criticita: findings.length,
        durataSec: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
      },
      null,
      2,
    ),
  );
  // Modulo per la revisione manuale delle schede (con i giudizi già dati nell'esecuzione precedente, se ci sono)
  const rev = writeReviewTemplate(runDir, findings, config.cliente);
  if (rev.prefilled) log(`Revisione: ${rev.prefilled} schede precompilate dalla revisione di ${rev.from}`);
  const html = renderHtml({
    configFile: basename(loaded.path),
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
    sitiEseguiti: config.siti.map((s) => s.url),
    sessioni: sessions.length,
    criticita: findings.length,
    csv: csvs,
    file: allFiles,
  };
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(runDir, 'manifest.json.sha256'), `${await sha256File(join(runDir, 'manifest.json'))}  manifest.json\n`);
  progress.phase('fine');
  log(`\nCompletato: ${sessions.length} sessioni, ${findings.length} criticità. Report: ${join(runDir, 'report.html')}`);
  return { runDir, findings, sessions };
}
