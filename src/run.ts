import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { trimHar } from './browser/har.js';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type LaunchOptions, type Page } from 'playwright';
import { Classifier, type TrackerEntry } from './classify/classifier.js';
import { loadConfigText, type LoadedConfig } from './config/load.js';
import type { AuditConfig } from './config/schema.js';
import { compareDeclared } from './declared/compare.js';
import { loadDeclaredFile } from './declared/declared.js';
import { readPolicyDeclared } from './declared/policy.js';
import { findPolicy } from './declared/find.js';
import { CLAIM_LABEL, extractTextual } from './declared/textual.js';
import { discoverSite, type DiscoveryResult } from './discovery/discover.js';
import { detectExit, type ExitInfo } from './browser/exit.js';
import { runSession, type SessionPlan } from './browser/session.js';
import { renderHtml } from './report/html.js';
import { writeCsvs } from './report/csv.js';
import { REVIEW_FILE, writeReviewTemplate } from './report/review.js';
import { DEFAULT_NORMS_FILE, evaluateRules, loadNorms, resolveRefs } from './rules/engine.js';
import type { ComparisonRow, DeclaredSet, Finding, ScenarioName, SessionResult } from './types.js';
import { closeSafely, sha256, sha256File, sleep, slug, timestampForPath } from './util/misc.js';
import { TOOL_COMMIT, TOOL_VERSION } from './version.js';
import { ProgressTracker, type Progress } from './progress.js';
import { registerTypedValue, setTestData, typedTestData } from './util/pii.js';
import { keepAwake } from './util/awake.js';
import { hasSecretStep, recordedFills, type RecordedPath } from './browser/replay.js';
import { findingScore } from './report/summary.js';
import { attributeByHost, checkDeclared } from './report/attribution.js';
import { attributeToEmbeds, enrichRequests, reclassify } from './classify/enrich.js';
import { COOKIE_STATE_LABEL, isMatomo, matomoCookieMode, probesFromHar } from './classify/firstparty.js';
import { reattributeFromHar } from './browser/har-frames.js';
import { nWords, plural } from './util/text.js';

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
  /**
   * Arresto forzato (pulsante "Interrompi" dell'interfaccia): chiude subito i browser, così ogni attesa in corso
   * finisce, e l'audit termina con {@link AuditStopped} senza rapporto. I dati parziali non sono una rilevazione valida.
   */
  signal?: AbortSignal;
}

/** Audit fermato dall'operatore: la cartella resta, incompleta e senza rapporto. */
export class AuditStopped extends Error {
  constructor(readonly runDir: string | null) {
    super(`Audit interrotto dall'operatore${runDir ? `: la cartella ${runDir} è incompleta e non produce un rapporto` : ''}.`);
    this.name = 'AuditStopped';
  }
}

/** File scritto nella cartella di un audit interrotto, per chi la apre in seguito. */
export const STOPPED_FILE = 'INTERROTTO.txt';

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
    // I contenuti incorporati di prova sono serviti anche in HTTPS con un certificato autofirmato (test/fixtures/tls).
    args.push(`--host-resolver-rules=${cfg.browser.hostResolverRules}`, '--disable-features=LocalNetworkAccessChecks', '--ignore-certificate-errors');
  }
  // Esecuzione di controllo: navigator.webdriver resta false, come in un browser comune
  if (cfg.browser.uaNormale) args.push('--disable-blink-features=AutomationControlled');
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
async function waitOnline(browser: Browser, url: string, log: (m: string) => void, signal?: AbortSignal): Promise<boolean> {
  const ctx = await browser.newContext();
  try {
    for (let k = 0; k < 30 && !signal?.aborted; k++) {
      const ok = await ctx.request
        .get(url, { timeout: 10000, maxRedirects: 5 })
        .then(() => true)
        .catch(() => false);
      if (ok) return true;
      await sleep(10000);
    }
    if (signal?.aborted) return false;
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
    const choiceScenarios = (['rifiuta', 'accetta', 'personalizza', 'revoca', 'chiudi'] as const).filter((s) => active.has(s));
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
    const start = manualStart(m.partenza, discovery.site, sample[0].url);
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
        manual: { instructions: m.istruzioni, maxMs: m.maxMinuti * 60000, siteHost: host },
      });
    }
  }
  return plans;
}

/**
 * Host di un sito come compare nei rilievi: di solito un indirizzo (https://www.esempio.it/), ma alcune regole
 * riguardano un intero dominio e riportano solo quello (esempio.it).
 */
export function siteHost(site: string): string {
  try {
    return new URL(site).hostname;
  } catch {
    return site;
  }
}

/** File del percorso registrato di un sito, accanto alla configurazione (cartella percorsi/). */
export function recordingFile(configPath: string, siteUrl: string): string {
  const name = basename(configPath).replace(/\.ya?ml$/i, '');
  return join(dirname(configPath), 'percorsi', `${name}_${new URL(siteUrl).hostname}.json`);
}
const recordingPath = (loaded: LoadedConfig, siteUrl: string) => recordingFile(loaded.path, siteUrl);

/** Valori inseriti dall'operatore nei campi (ultimo valore per campo), da mostrare come promemoria. */
function typedValues(steps: RecordedPath['steps']): string[] {
  const byField = new Map<string, string>();
  for (const st of steps) if (st.type === 'fill' && !st.secret && st.value?.trim()) byField.set(st.css, `${st.text && st.text !== st.value ? `${st.text}: ` : ''}${st.value.trim()}`);
  return [...byField.values()].slice(0, 8);
}

/** Almeno una delle pagine è sul sito (stesso host, con o senza www)? */
export function entersSite(urls: string[], siteUrl: string): boolean {
  const bare = (h: string) => h.replace(/^www\./, '');
  const own = bare(new URL(siteUrl).hostname);
  return urls.some((u) => {
    try {
      return bare(new URL(u).hostname) === own;
    } catch {
      return false;
    }
  });
}

/** Pagina di partenza della navigazione manuale, come indirizzo completo. */
export function manualStart(partenza: string | undefined, site: string, fallback: string): string {
  // "www.esempio.it/preventivo" senza https:// è un indirizzo, non un percorso del sito
  const p = partenza && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(partenza) ? `https://${partenza}` : partenza;
  return p ? new URL(p, site).toString() : fallback;
}

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

/** Copia le evidenze di ogni rilievo con il numero del rilievo nel nome. */
function linkEvidenceToFindings(runDir: string, findings: Finding[]) {
  const dir = join(runDir, 'evidenze', 'rilievi');
  // una rigenerazione rinumera i rilievi: le copie precedenti non devono restare
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of findings) {
    f.evidence = f.evidence.map((e) => {
      if (!e.file.endsWith('.png')) return e;
      const rel = `evidenze/rilievi/${f.id}_${basename(e.file)}`;
      try {
        copyFileSync(join(runDir, e.file), join(runDir, rel));
        return { ...e, file: rel };
      } catch {
        return e;
      }
    });
    if (f.requestExcerpt) {
      const rel = `evidenze/rilievi/${f.id}_estratto-richiesta.json`;
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
    // stessa sessione divisa tra due siti (attribuzione per host): il file è già stato compresso
    if (renamed.has(s.har)) {
      s.har = renamed.get(s.har)!;
      continue;
    }
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
  if (opts.signal?.aborted) throw new AuditStopped(runDir);
  const browser = await chromium.launch(launchOptions(config, headless));
  let manualBrowser: Browser | null = null;
  // Arresto forzato: chiudendo i browser ogni comando in attesa (pagina, frame, navigazione manuale) termina con un
  // errore, e i controlli tra un passo e l'altro fermano l'audit
  const stopped = () => !!opts.signal?.aborted;
  const checkStop = () => {
    if (stopped()) throw new AuditStopped(runDir);
  };
  const onAbort = () => {
    log('\nInterruzione richiesta: chiusura del browser…');
    void closeSafely(browser, 15000);
    if (manualBrowser) void closeSafely(manualBrowser, 15000);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
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
      checkStop();
      let d = await discoverSite(browser, site, config, userAgent);
      checkStop();
      if (d.notes.some((n) => NETWORK_ERROR.test(n))) {
        // Connessione caduta durante la scoperta (es. computer in stop): si aspetta che torni e si ripete una volta
        log('  connessione assente durante la scoperta: attesa del ripristino…');
        progress.wait('connessione');
        const back = await waitOnline(browser, site.url, log, opts.signal);
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
      let recording = site.navigazioneManuale ? readRecording(recordingPath(loaded, site.url)) : null;
      // Percorso registrato che non entra mai nel sito (es. registrato da una navigazione rimasta su www): descriverebbe
      // un altro sito, non si rigioca e si torna alla navigazione manuale.
      if (recording && !entersSite([recording.start, ...recording.steps.map((x) => x.url)], site.url)) {
        log(`  percorso registrato ignorato: non entra mai in ${new URL(site.url).hostname}; la navigazione manuale va rifatta`);
        d.notes.push(`Percorso registrato in precedenza ignorato: non entrava mai in ${new URL(site.url).hostname}.`);
        recording = null;
      }
      // Percorso con un campo riservato (password e simili): il valore non è registrato, quindi non si può rigiocare
      if (recording && hasSecretStep(recording.steps)) {
        log('  percorso registrato ignorato: contiene un campo riservato (password o simile); la navigazione manuale va rifatta');
        d.notes.push('Percorso registrato in precedenza ignorato: contiene un campo riservato (password o simile), che non si registra.');
        recording = null;
      }
      // I valori del percorso registrato sono i dati di prova di questa esecuzione: vanno riconosciuti nelle richieste
      // già durante la raccolta, come quelli digitati in una navigazione manuale
      if (recording) for (const f of recordedFills(recording.steps)) registerTypedValue(f.value, f.hint);
      if (site.navigazioneManuale && !recording) {
        const start = manualStart(site.navigazioneManuale.partenza, site.url, site.url);
        if (!entersSite([start], site.url)) {
          const warn = `La navigazione manuale parte da ${new URL(start).hostname}, fuori da ${new URL(site.url).hostname}: i fatti osservati su quelle pagine saranno attribuiti a ${new URL(start).hostname}. Il percorso deve arrivare su ${new URL(site.url).hostname}.`;
          log(`  ATTENZIONE: ${warn}`);
          d.notes.push(warn);
        }
      }
      const plans = planSessions(config, d, i, nextId, recording);
      nextId += plans.length;
      jobs.push({ i, site, d, decl, plans, manual: [] });
    }
    for (const j of jobs) progress.plan(j.d.site, j.plans.filter((p) => !p.manual).length, j.plans.filter((p) => p.manual).length);

    const exec = async (job: (typeof jobs)[number], plan: SessionPlan) => {
      checkStop();
      const { decl } = job;
      log(`  ${plan.id} (${plan.pages.length} pagine)…`);
      const t0 = Date.now();
      progress.start(`${new URL(plan.site).hostname} · ${plan.scenario}${plan.manual ? ' (navigazione manuale)' : ''}${plan.repeat ? ` · ripetizione ${plan.repeat}` : ''}`);
      if (plan.manual) progress.wait('manuale');
      if (plan.manual && !opts.manualDriver && headless && !manualBrowser) manualBrowser = await chromium.launch(launchOptions(config, false));
      checkStop();
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
      checkStop();
      const i2 = res.interaction;
      log(`    banner: ${i2.bannerVisibleBefore ? 'sì' : 'no'}; metodo: ${i2.method}; esito: ${i2.outcome}; verifica: ${i2.verification}; cookie: ${res.cookies.length}; richieste: ${res.requests.length}`);
      // Sessione fermata dal tetto di durata: va detto subito, perché i dati raccolti sono parziali
      const capped = res.truncated ? res.errors.find((e) => e.includes('sessione interrotta')) : undefined;
      if (capped) log(`    ATTENZIONE: ${capped}`);
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
        // Le navigazioni successive alla prima riusano gli stessi dati: il riquadro li ricorda all'operatore
        let previous: string[] = [];
        for (const { j, p } of manualPlans) {
          const plan = previous.length && p.manual ? { ...p, manual: { ...p.manual, hint: `Usa gli stessi dati della navigazione precedente: ${previous.join('; ')}.` } } : p;
          const res = await exec(j, plan);
          j.manual.push(res);
          const typed = typedValues(res.manual?.steps ?? []);
          if (typed.length) previous = typed;
        }
      } finally {
        // assegnato dentro exec: TypeScript non lo vede
        await (manualBrowser as Browser | null)?.close().catch(() => {});
        manualBrowser = null;
      }
      log('\nNavigazioni manuali concluse: da qui l\'audit prosegue da solo. Il computer deve restare acceso, sveglio e collegato a internet.');
      // La navigazione più completa di ogni sito diventa il percorso registrato: dalla prossima esecuzione si
      // rigioca in automatico, in ogni ripetizione, senza operatore.
      for (const j of jobs) {
        const best = j.manual.filter((r) => r.manual?.endedBy === 'operatore' && r.manual.steps?.length && entersSite(r.manual.pages, j.site.url)).sort((a, b) => b.manual!.steps!.length - a.manual!.steps!.length)[0];
        if (!best) {
          if (j.manual.some((r) => r.manual?.steps?.length)) log(`Percorso di ${new URL(j.site.url).hostname} non salvato: la navigazione manuale non è entrata nel sito.`);
          continue;
        }
        if (hasSecretStep(best.manual!.steps!)) {
          log(`Percorso di ${new URL(j.site.url).hostname} non salvato: contiene un campo riservato (password o simile), il cui valore non si registra. La navigazione manuale andrà ripetuta a ogni audit.`);
          j.d.notes.push('Percorso della navigazione manuale non registrato per le esecuzioni successive: contiene un campo riservato (password o simile).');
          continue;
        }
        const rec: RecordedPath = { site: j.site.url, start: j.plans.find((p) => p.manual)!.pages[0], savedAt: new Date().toISOString(), fromSession: best.id, steps: best.manual!.steps! };
        const path = recordingPath(loaded, j.site.url);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(rec, null, 2));
        log(`Percorso registrato (${rec.steps.length} passi) salvato in ${path}: dalla prossima esecuzione si rigioca in automatico.`);
      }
    }

    checkStop();
    progress.phase('automatiche');
    for (const job of jobs) {
      const { site, d, decl } = job;
      const plans = job.plans.filter((p) => !p.manual);
      log(`\n[${site.url}] sessioni automatiche…`);
      const siteResults: SessionResult[] = [];
      // Prima tutte le sessioni "nessuna azione": dicono se il sito ha un banner. Senza banner in nessuna di esse (e
      // con l'opzione attiva) gli scenari con scelta non si eseguono: ripeterebbero "nessuna azione" su più pagine.
      const valid0 = (s: SessionResult) => !s.blocked && !s.unreachable;
      const hasBanner = (s: SessionResult) => s.interaction.bannerVisibleBefore || s.interaction.detectedCmps.length > 0;
      const results = new Map<SessionPlan, SessionResult>();
      for (const plan of plans.filter((p) => p.scenario === 'nessuna-azione')) results.set(plan, await exec(job, plan));
      const choicePlans = plans.filter((p) => p.scenario !== 'nessuna-azione');
      if (config.scenari.saltaSenzaBanner && choicePlans.length) {
        let base = [...results.values()].filter(valid0);
        // Una sola sessione valida senza banner: se ne fa una di conferma, perché lo script del gestore può non essersi
        // caricato per un errore di rete (in quel caso la sessione senza banner è sostituita, come le altre ripetizioni)
        if (base.length === 1 && !hasBanner(base[0])) {
          const first = base[0];
          const plan = [...results].find(([, r]) => r === first)![0];
          log(`    nessun banner nell'unica sessione "nessuna azione": sessione di conferma di ${first.id}`);
          progress.extra(d.site);
          const confirm = await exec(job, { ...plan, id: `${plan.id}_conferma` });
          if (hasBanner(confirm) && valid0(confirm)) {
            confirm.retryOf = first.id;
            confirm.errors.unshift(`Ripetizione di ${first.id}: in quella sessione il banner non è comparso${failedHosts(first) ? `; richieste senza risposta verso ${failedHosts(first)}` : ''}.`);
            discarded.push(first);
            results.set(plan, confirm);
          } else {
            // conferma senza banner: è una sessione valida in più, con le sue prove
            confirm.errors.unshift(`Sessione di conferma di ${first.id}: nessun banner, come nella prima; gli scenari con scelta non si eseguono.`);
            siteResults.push(confirm);
          }
          base = [...results.values(), ...siteResults].filter(valid0);
        }
        // un banner visto nelle navigazioni manuali dello stesso sito basta per eseguire tutti gli scenari
        if (base.length && !base.some(hasBanner) && !job.manual.some((s) => valid0(s) && hasBanner(s))) {
          const skipped = [...new Set(choicePlans.map((p) => p.scenario))];
          d.skippedChoice = { scenarios: skipped, sessions: base.length };
          log(`    nessun banner in ${nWords(base.length, 'sessione', 'sessioni')} "nessuna azione": scenari con scelta non eseguiti (${skipped.join(', ')})`);
          progress.skip(d.site, choicePlans.length);
          choicePlans.length = 0;
        }
      }
      for (const plan of choicePlans) results.set(plan, await exec(job, plan));
      // nell'ordine del piano (le sessioni di conferma senza banner in coda)
      siteResults.unshift(...plans.filter((p) => results.has(p)).map((p) => results.get(p)!));

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
        const plan = plans.find((p) => p.id === first.id);
        if (!plan) continue;
        progress.extra(d.site);
        const retry = await exec(job, { ...plan, id: `${plan.id}_ripetuta` });
        retry.retryOf = first.id;
        retry.errors.unshift(`Ripetizione di ${first.id}: sessione fallita per mancanza di connessione (${first.unreachable}).`);
        discarded.push(first);
        siteResults[k] = retry;
      }

      // Sessioni fermate dal tetto di durata (sito lento): si ripetono una volta con un tetto doppio, al massimo due per
      // sito. La sessione più completa resta tra i dati; l'altra tra quelle scartate.
      let slowRetries = 0;
      for (let k = 0; k < siteResults.length && slowRetries < 2; k++) {
        const first = siteResults[k];
        if (!first.truncated || first.blocked || first.unreachable || first.retryOf) continue;
        const plan = plans.find((p) => p.id === first.id.replace(/_(ripetuta|conferma)$/, ''));
        if (!plan) continue;
        slowRetries++;
        log(`    ${first.id}: fermata dal tetto di durata (${first.truncated}); ripetizione con un tetto doppio`);
        progress.extra(d.site);
        const retry = await exec(job, { ...plan, id: `${plan.id}_ripetuta`, timeoutFactor: 2 });
        const note = `sessione fermata dal tetto di durata (passo in corso: ${first.truncated})`;
        if (retry.blocked || retry.unreachable) {
          retry.errors.unshift(`Ripetizione di ${first.id} (${note}) non riuscita: resta la prima sessione, incompleta.`);
          discarded.push(retry);
          continue;
        }
        retry.retryOf = first.id;
        retry.errors.unshift(`Ripetizione di ${first.id}: ${note}; ripetuta con un tetto doppio${retry.truncated ? ', fermata di nuovo: i dati sono parziali' : ''}.`);
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
          const plan = plans.find((p) => p.id === first.id.replace(/_(ripetuta|conferma)$/, ''));
          if (!plan) continue;
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
      if (blockedCount) log(`    ${nWords(blockedCount, 'sessione', 'sessioni')} su ${siteResults.length} ${plural(blockedCount, 'bloccata', 'bloccate')} da un sistema anti-bot: ${plural(blockedCount, 'esclusa', 'escluse')} dalle regole`);
      const unreachableCount = siteResults.filter((s) => s.unreachable).length;
      if (unreachableCount) log(`    ${nWords(unreachableCount, 'sessione', 'sessioni')} su ${siteResults.length} senza accesso al sito: ${plural(unreachableCount, 'esclusa', 'escluse')} dalle regole`);
      sessions.push(...siteResults);
      if (!decl.source) {
        // Ultima fonte: la cookie policy. Indirizzo configurato; altrimenti la ricerca: link nel banner, pagina "cookie"
        // scoperta, link nella pagina (piè di pagina, menu, rel="privacy-policy"), percorsi comuni, URL della sitemap,
        // con lo stato HTTP reale. Si leggono le tabelle; senza tabelle, la dichiarazione testuale.
        const fromBanner = siteResults.find((s) => s.bannerAnalysis?.policyLink?.href)?.bannerAnalysis?.policyLink?.href;
        const fromSample = d.sample.find((p) => /cookie/i.test(new URL(p.url).pathname))?.url;
        let policyUrl: string | undefined;
        let how = '';
        if (site.cookiePolicy) {
          policyUrl = new URL(site.cookiePolicy, site.url).toString();
          how = 'indirizzo nella configurazione';
          decl.policy = { url: policyUrl, how, tried: [{ url: policyUrl, how, status: null, note: 'non verificato: indicato nella configurazione' }] };
        } else if (siteResults.some((s) => !s.blocked && !s.unreachable)) {
          const known = [
            ...(fromBanner && /cookie/i.test(fromBanner) ? [{ url: new URL(fromBanner, site.url).toString(), how: 'link nel banner' }] : []),
            ...(fromSample ? [{ url: fromSample, how: 'pagina "cookie" tra quelle scoperte' }] : []),
            ...(fromBanner ? [{ url: new URL(fromBanner, site.url).toString(), how: 'link nel banner' }] : []),
          ];
          log('  ricerca della cookie policy o dell\'informativa…');
          const found = await findPolicy(browser, {
            site: d.site,
            known,
            sitemap: d.policyPages ?? [],
            userAgent,
            locale: config.browser.locale,
            runDir,
            shotName: slug(new URL(d.site).hostname, 40),
          }).catch((e: Error) => {
            log(`    ricerca non riuscita: ${e.message.split('\n')[0]}`);
            return null;
          });
          if (found) {
            decl.policy = found;
            if (found.url) {
              policyUrl = found.url;
              how = found.how ?? '';
              log(`    trovata: ${found.url} (${how})`);
            } else log(`    nessuna pagina di informativa raggiungibile (${found.tried.length} indirizzi provati)`);
          }
        }
        if (policyUrl) {
          log(`  lettura dell'elenco dichiarato dalla cookie policy: ${policyUrl}`);
          const { items, skipped, text } = await readPolicyDeclared(browser, policyUrl, userAgent, config.browser.locale).catch((e: Error) => {
            log(`    non riuscita: ${e.message.split('\n')[0]}`);
            return { items: [], skipped: [] as string[], text: undefined };
          });
          if (items.length) {
            decl.items = items;
            decl.source = `cookie policy (${policyUrl})`;
            decl.note =
              'Elenco ricavato dalle tabelle della cookie policy: va verificato a vista, la struttura delle pagine varia.' +
              (skipped.length ? ` ${skipped.length} righe non lette perché la prima colonna non contiene un nome di cookie (es. "${skipped.slice(0, 3).join('", "')}"): per un confronto completo fornire l'elenco a mano (file dei dichiarati).` : '');
          } else if (text) {
            const t = extractTextual(policyUrl, how, text, classifier.vendorNames());
            if (t) {
              decl.textual = t;
              decl.note = `Informativa senza tabelle leggibili (${policyUrl}, trovata come ${how}): dichiarazione testuale, con ${t.vendors.length === 1 ? '1 fornitore citato' : `${t.vendors.length} fornitori citati`}${t.claims.length ? ` e le affermazioni ${t.claims.map((c) => `"${CLAIM_LABEL[c.claim]}"`).join(', ')}` : ''}. Il confronto è per fornitore, meno preciso di quello per nome di cookie.`;
            }
          }
        }
      }
      if (!decl.source && !decl.textual) decl.note = 'Nessun elenco leggibile dal CMP, dalla cookie policy o da un file configurato: confronto con i dichiarati non eseguito.';
    }
    checkStop();
  } catch (e) {
    // Dopo l'arresto i comandi del browser falliscono con errori qualsiasi: conta l'arresto, non l'errore
    if (stopped()) throw markStopped(runDir, log);
    throw e;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await closeSafely(browser, 30000);
    if (manualBrowser && stopped()) await closeSafely(manualBrowser, 15000);
  }

  // I dati raccolti vanno su disco prima di regole e rapporto: un errore in quella fase non deve far perdere
  // la raccolta (si rigenera con il comando "rigenera").
  const collected: Collected = {
    configurazione: { file: loaded.path, contenuto: loaded.raw },
    startedAt,
    userAgent,
    browserVersion,
    exit,
    discovery,
    sessions,
    discarded,
    declared,
  };
  writeFileSync(join(runDir, COLLECTED_FILE), JSON.stringify(collected));
  return finishRun(loaded, config, runDir, collected, { pdf: opts.pdf, log, progress });
}

/** Annota l'arresto nella cartella dell'audit e nel registro. */
function markStopped(runDir: string, log: (m: string) => void): AuditStopped {
  try {
    writeFileSync(
      join(runDir, STOPPED_FILE),
      `Audit interrotto dall'operatore il ${new Date().toLocaleString('it-IT')}.\n` +
        'I dati in questa cartella sono parziali: non sono una rilevazione valida e non producono un rapporto. Ripetere l\'audit.\n',
    );
  } catch {
    // cartella non scrivibile: resta l'annotazione nel registro
  }
  log(`Audit interrotto. La cartella ${runDir} resta incompleta (vedi ${STOPPED_FILE}): l'audit va ripetuto.`);
  return new AuditStopped(runDir);
}

/** Dati raccolti dalle sessioni, salvati prima di regole e rapporto. */
export const COLLECTED_FILE = 'raccolta.json';
export interface Collected {
  configurazione: { file: string; contenuto: string };
  startedAt: string;
  userAgent: string;
  browserVersion: string;
  exit: ExitInfo;
  discovery: DiscoveryResult[];
  sessions: SessionResult[];
  discarded: SessionResult[];
  declared: DeclaredSet[];
}

/**
 * Regole, rapporto, CSV, PDF e manifest a partire dai dati raccolti. Usata a fine audit e dal comando "rigenera".
 */
async function finishRun(
  loaded: LoadedConfig,
  config: AuditConfig,
  runDir: string,
  collected: Collected,
  o: { pdf?: boolean; log: (m: string) => void; progress?: ProgressTracker; regeneratedAt?: string },
): Promise<RunResult> {
  const { startedAt, userAgent, browserVersion, exit, discovery, discarded } = collected;
  // I valori digitati dall'operatore nelle navigazioni manuali valgono come dati di prova, anche se in configurazione
  // ne erano stati dichiarati altri: vengono riconosciuti e riportati in chiaro.
  for (const s of [...collected.sessions, ...collected.discarded]) {
    for (const st of s.manual?.steps ?? []) if (st.type === 'fill' && !st.secret && st.value) registerTypedValue(st.value, `${st.css} ${st.text}`);
    // percorsi rigiocati: i valori inseriti sono quelli del percorso registrato
    for (const f of s.replay?.fills ?? []) registerTypedValue(f.value, f.hint);
  }
  // un solo classificatore per tutta la fase finale (elenchi letti e compilati una volta)
  let finalClassifier: Classifier | null = null;
  try {
    const extraTrackers: TrackerEntry[] = config.trackerExtra ? Classifier.loadExtraTrackers(loaded.resolvePath(config.trackerExtra)) : [];
    finalClassifier = new Classifier(extraTrackers);
    reclassify(collected.sessions, finalClassifier);
  } catch (e) {
    o.log(`Classificazioni non aggiornate (${(e as Error).message.split('\n')[0]}): restano quelle della rilevazione.`);
  }
  enrichRequests(collected.sessions);
  // Configurazione di Matomo/Piwik dalle pagine salvate nel HAR, per le sessioni senza la lettura a fine pagina
  // (rilevazioni precedenti alla 0.1.2): prova accessoria dello stato dei cookie
  try {
    const n = probesFromHar(runDir, collected.sessions);
    if (n && o.regeneratedAt) o.log(`Configurazione di Matomo letta dal file HAR in ${n === 1 ? '1 sessione' : `${n} sessioni`}.`);
  } catch (e) {
    o.log(`Configurazione di Matomo non letta dal file HAR (${(e as Error).message.split('\n')[0]}).`);
  }
  // Rilevazioni raccolte prima della 0.1.1: le richieste degli iframe partite all'uscita da una pagina si riattribuiscono
  // alla pagina che li ospitava, con il frame di origine registrato nel file HAR
  if (o.regeneratedAt) {
    try {
      const moved = reattributeFromHar(runDir, collected.sessions);
      const total = [...moved.values()].reduce((a, b) => a + b, 0);
      if (total) o.log(`Attribuzione dal file HAR: ${total === 1 ? '1 richiesta di un iframe riattribuita' : `${total} richieste di iframe riattribuite`} alla pagina che li ospitava (inviate all'uscita), in ${moved.size === 1 ? '1 sessione' : `${moved.size} sessioni`}.`);
    } catch (e) {
      o.log(`Attribuzione dal file HAR non eseguita (${(e as Error).message.split('\n')[0]}): restano le pagine della rilevazione.`);
    }
  }
  // richieste partite da un contenuto incorporato: a quale contenuto appartengono (dopo il frame ricostruito dal HAR)
  try {
    if (!finalClassifier) throw new Error('classificatore non disponibile');
    attributeToEmbeds(collected.sessions, finalClassifier);
  } catch {
    // senza attribuzione ai contenuti incorporati le richieste restano del fornitore del dominio
  }
  // Ogni fatto appartiene al sito della pagina in cui avviene (es. navigazione manuale partita da www che prosegue
  // su app): le parti delle sessioni su altri host diventano sessioni di quei siti. L'elenco dichiarato letto dal
  // gestore di un'altra pagina non vale per il sito.
  const attributed = attributeByHost(collected.sessions);
  const sessions = attributed.sessions;
  const checked = checkDeclared(collected.declared, sessions);
  const declared = checked.declared;
  const attributionNotes = [...attributed.notes, ...checked.notes];
  for (const n of attributionNotes) o.log(`Attribuzione: ${n}`);
  const log = o.log;
  const progress = o.progress ?? new ProgressTracker(() => {}, 0);
  const opts = { pdf: o.pdf };
  const normsPath = config.norme ? loaded.resolvePath(config.norme) : DEFAULT_NORMS_FILE;
  const norms = loadNorms(normsPath);

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
  // Arricchimento del rapporto: un errore qui non deve far perdere la rilevazione (dati e prove sono già raccolti)
  if (reps > 1 || manualSessions.length) {
    try {
      const hostOf = siteHost;
      const rawKeys = (subset: SessionResult[]) => {
        const comp = declared.flatMap((d) => compareDeclared(d.site, subset.filter((s) => s.site === d.site), d));
        const ctx = { config, sessions: subset, blocked: blockedSessions, declared, comparison: comp, exit, discovery };
        return new Set(evaluateRules(ctx, norms, { merge: false }).map((f) => `${f.key}@${hostOf(f.site)}`));
      };
      const seen = new Map<string, number>();
      if (reps > 1) {
        // Uno scenario con scelta in cui il banner non è comparso non ha eseguito la scelta: non conta tra le ripetizioni
        const counted = (s: SessionResult) => s.scenario === 'nessuna-azione' || s.interaction.outcome === 'eseguito' || s.interaction.bannerVisibleBefore;
        for (let r = 1; r <= reps; r++) for (const k of rawKeys(validSessions.filter((s) => s.repeat === r && counted(s)))) seen.set(k, (seen.get(k) ?? 0) + 1);
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
    } catch (e) {
      for (const f of findings) delete f.repeats;
      log(`Ripetibilità non calcolata (${(e as Error).message}): il rapporto è completo, senza l'indicazione "osservato in k su N".`);
    }
  }
  if (config.report.harCompressi) compressHars(runDir, [...sessions, ...discarded], findings, config.report.harContenuti);

  // Ordine delle schede: gravità, poi forza della prova e ripetibilità
  findings.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || findingScore(b) - findingScore(a));
  findings.forEach((f, i) => (f.id = `R-${String(i + 1).padStart(3, '0')}`));
  // rimandi tra rilievi ("vedi R-004"): con i numeri definitivi
  findings.splice(0, findings.length, ...resolveRefs(findings));
  linkEvidenceToFindings(runDir, findings);

  const evidenceFiles = await hashFiles(runDir, listFiles(join(runDir, 'evidenze')).map((p) => join('evidenze', p)));
  const endedAt = new Date().toISOString();

  // Stato dei cookie degli strumenti di statistica ospitati sul sito (Matomo/Piwik), per sito
  const statoCookie = [...new Set(validSessions.map((s) => s.site))]
    .filter((site) => validSessions.some((s) => s.site === site && s.requests.some((r) => r.party === 'prima' && r.tracker && isMatomo(r.tracker.company))))
    .map((site) => {
      const m = matomoCookieMode(validSessions.filter((s) => s.site === site));
      return { sito: site, strumento: 'Matomo', stato: COOKIE_STATE_LABEL[m.state], fatti: m.facts, datiUtente: m.userData };
    });
  writeFileSync(join(runDir, 'dati.json'), JSON.stringify({ statoCookie, discovery, sessions, sessioniScartate: discarded, declared, comparison, findings, noteAttribuzione: attributionNotes, datiDigitati: typedTestData() }, null, 2));
  const csvs = writeCsvs(runDir, sessions, comparison, findings, declared);
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
        sessioniIncomplete: sessions.filter((s) => s.truncated).map((s) => s.id),
        // dati per l'elenco delle esecuzioni dell'interfaccia, che così non legge manifest.json
        inizio: startedAt,
        fine: endedAt,
        sessioni: sessions.length,
        uscita: { paese: exit.verified ? exit.country : null, dichiarato: exit.declared, coincide: exit.verified && exit.matches },
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
    regeneratedAt: o.regeneratedAt,
    configFile: basename(loaded.path),
    configSha256: sha256(loaded.raw),
    toolCommit: TOOL_COMMIT,
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
    attributionNotes,
    typedData: typedTestData(),
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
    strumento: { nome: 'scookie', versione: TOOL_VERSION, commit: TOOL_COMMIT },
    ...(o.regeneratedAt ? { rigenerato: o.regeneratedAt } : {}),
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
  log(`\nCompletato: ${sessions.length} sessioni, ${findings.length} rilievi. Rapporto: ${join(runDir, 'report.html')}`);
  return { runDir, findings, sessions };
}

/**
 * Rigenera regole e rapporto dai dati già raccolti, senza visitare di nuovo i siti: dopo un errore nella fase
 * finale (raccolta.json) oppure, con `copy`, per applicare le regole della versione attuale a una rilevazione
 * passata (es. per confrontarla a parità di strumento con una nuova). Con `copy` si lavora su una copia della
 * cartella: la rilevazione originale e il suo rapporto restano intatti.
 */
export async function regenerateRun(runDir: string, o: { copy?: boolean; pdf?: boolean; log?: (m: string) => void } = {}): Promise<RunResult> {
  const log = o.log ?? ((m: string) => console.log(m));
  let collected: Collected;
  if (existsSync(join(runDir, COLLECTED_FILE))) {
    collected = JSON.parse(readFileSync(join(runDir, COLLECTED_FILE), 'utf8')) as Collected;
  } else if (existsSync(join(runDir, 'dati.json')) && existsSync(join(runDir, 'manifest.json'))) {
    const d = JSON.parse(readFileSync(join(runDir, 'dati.json'), 'utf8')) as { discovery: DiscoveryResult[]; sessions: SessionResult[]; sessioniScartate?: SessionResult[]; declared: DeclaredSet[] };
    const m = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as {
      inizio: string;
      configurazione: { file: string; contenuto: string };
      ambiente: { browser: string; userAgent: string; uscita: ExitInfo };
    };
    collected = {
      configurazione: { file: m.configurazione.file, contenuto: m.configurazione.contenuto },
      startedAt: m.inizio,
      userAgent: m.ambiente.userAgent,
      browserVersion: m.ambiente.browser,
      exit: m.ambiente.uscita,
      discovery: d.discovery,
      sessions: d.sessions,
      discarded: d.sessioniScartate ?? [],
      declared: d.declared,
    };
  } else {
    throw new Error(`Nella cartella ${runDir} non ci sono dati raccolti (raccolta.json o dati.json): la rilevazione va ripetuta`);
  }
  let target = runDir;
  if (existsSync(join(runDir, 'report.html'))) {
    if (!o.copy) throw new Error('La rilevazione ha già un rapporto: per rigenerarlo senza toccare l\'originale usare l\'opzione --copia');
    // copia della cartella con le sole prove e i dati raccolti: rapporto, CSV e manifest si rifanno
    target = `${runDir.replace(/[\\/]+$/, '')}_rigenerato-${timestampForPath()}`;
    const derived = /^(report|report-rivisto)\.(html|pdf)$|^(dati|riepilogo|manifest|revisione-applicata)\.json$|^manifest\.json\.sha256$|\.csv$|^confronto-.*\.html$/;
    cpSync(runDir, target, { recursive: true, filter: (src) => !derived.test(basename(src)) && !src.includes(`${join('evidenze', 'rilievi')}`) });
  }
  if (!existsSync(join(target, COLLECTED_FILE))) writeFileSync(join(target, COLLECTED_FILE), JSON.stringify(collected));
  const loaded = loadConfigText(collected.configurazione.contenuto, collected.configurazione.file);
  setTestData(loaded.config.datiDiProva);
  log(`Rigenerazione del rapporto in ${target} (dati raccolti il ${collected.startedAt})…`);
  return finishRun(loaded, loaded.config, target, collected, { pdf: o.pdf, log, regeneratedAt: new Date().toISOString() });
}
