import { join } from 'node:path';
import type { Browser, Page, Response } from 'playwright';
import type { Classifier } from '../classify/classifier.js';
import type { AuditConfig, SiteConfig } from '../config/schema.js';
import { analyzeBanner } from '../cmp/analysis.js';
import { bannerVisible, detectCmps, observeBanner, performChoice, performClose, performPersonalize, performRevocation } from '../cmp/interact.js';
import { manualIncomplete, NON_TECHNICAL, type StatsProbe, type BannerAnalysis, type DeclaredItem, type Evidence, type InteractionReport, type ScenarioName, type SessionResult } from '../types.js';
import { PartyResolver, registrableDomain } from '../util/domains.js';
import { closeSafely, slug, withTimeout } from '../util/misc.js';
import { detectBotChallenge, type BotBlock } from './antibot.js';
import { Collector } from './collector.js';
import { findRevokeInPage } from '../cmp/revoke.js';
import { assembleHar } from './har.js';
import { mkdirSync, rmSync } from 'node:fs';
import { maskPii } from '../util/pii.js';
import { manualJourney, type ManualPlan } from './manual.js';
import { replayJourney, type RecordedPath } from './replay.js';

export interface SessionPlan {
  id: string;
  site: string;
  siteConfig: SiteConfig;
  scenario: ScenarioName;
  pageType: string;
  pages: string[];
  /** Se true, a fine sessione si analizza la struttura del banner (prima sessione "nessuna azione" del sito). */
  analyzeBanner?: boolean;
  /** Scenario "revoca": pagina di gestione dei cookie trovata nella sitemap, se c'è. */
  revokePage?: string;
  /** Navigazione manuale dell'operatore al posto delle pagine successive. */
  manual?: ManualPlan;
  /** Percorso registrato in una navigazione manuale precedente, da rigiocare in automatico dopo la scelta. */
  replay?: RecordedPath;
  /** Numero della ripetizione (1 se lo scenario si esegue una sola volta). */
  repeat?: number;
  /** Moltiplica il tetto di durata (ripetizione di una sessione fermata dal tetto). */
  timeoutFactor?: number;
}

/**
 * Tetto di durata di una sessione: mai meno di `timeoutSessione`, e abbastanza per tutte le visite previste dal
 * percorso (una pagina lenta non deve tagliare le pagine dopo la scelta o dopo la revoca).
 */
export function sessionBudgetMs(plan: Pick<SessionPlan, 'scenario' | 'pages' | 'manual' | 'replay' | 'timeoutFactor'>, p: AuditConfig['protocollo'], bannerWait: number): number {
  if (plan.manual) return Math.max(p.timeoutSessione, plan.manual.maxMs + 120000);
  const journey = plan.pages.length;
  // prima pagina, poi lo stesso percorso dopo la scelta e, per la revoca, una terza volta
  const visits = plan.scenario === 'nessuna-azione' ? 1 : plan.scenario === 'revoca' ? 2 + 2 * journey : 1 + journey;
  // per visita: caricamento tipico (un terzo del tempo massimo), attese del protocollo, scroll e lettura dello stato
  const perVisit = Math.round(p.timeoutNavigazione / 3) + 5000 + p.attesaDopoCaricamento + (p.scroll ? 6000 + p.attesaDopoScroll : 0) + 3000;
  const choice = plan.scenario === 'nessuna-azione' ? bannerWait + 30000 : (plan.scenario === 'revoca' ? 2 : 1) * (bannerWait + p.attesaDopoScelta + 30000);
  // percorso registrato: fino a 20 s per passo (ricerca dell'elemento e attese)
  const replay = plan.replay ? plan.replay.steps.length * 20000 : 0;
  return Math.round(Math.max(p.timeoutSessione, visits * perVisit + choice + replay) * (plan.timeoutFactor ?? 1));
}

export interface SessionEnv {
  config: AuditConfig;
  runDir: string;
  classifier: Classifier;
  userAgent: string;
  /** Se definita, la sessione legge l'elenco dichiarato dal CMP e lo passa qui. */
  onDeclared?: (items: DeclaredItem[], cmp: string) => void;
  /** Solo test: simula l'operatore nelle sessioni con navigazione manuale. */
  manualDriver?: (page: Page) => Promise<void>;
  /** Riceve la funzione che chiude la navigazione manuale in corso (null quando non ce n'è una). */
  onManualFinisher?: (finish: (() => void) | null) => void;
  /** Avvisa l'operatore che una sessione manuale sta per iniziare. */
  log?: (msg: string) => void;
}

const DEFAULT_BANNER_WAIT = 6000;

/**
 * Scorre la pagina a passi come un visitatore: movimento del mouse e rotella reali (eventi mousemove e wheel),
 * non solo lo scroll via script, che genera solo l'evento scroll. Alcuni siti caricano gli script alla prima
 * interazione e li attivano anche con la rotella (es. plugin di ottimizzazione che ritardano gli script). Se la rotella non
 * sposta la pagina (cursore su un riquadro scorrevole, scroll bloccato) si scorre via script. Alla fine torna in cima.
 */
async function scrollPage(page: Page, onFirstInteraction: () => void) {
  const vp = page.viewportSize() ?? { width: 1366, height: 900 };
  try {
    // Nella parte alta del contenuto, lontano dal fondo dove stanno di solito i banner; il mouse non clicca nulla.
    // Il primo movimento porta il cursore sopra la pagina, come per un visitatore qualsiasi: non è un'interazione e
    // ciò che ne deriva resta "al caricamento". L'interazione inizia con il movimento successivo e la rotella.
    await page.mouse.move(vp.width * 0.3, vp.height * 0.3);
    await page.waitForTimeout(250);
    onFirstInteraction();
    await page.mouse.move(vp.width * 0.6, vp.height * 0.4, { steps: 8 });
    const step = Math.max(200, Math.floor(vp.height * 0.8));
    for (let i = 0; i < 12; i++) {
      const before = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, step);
      await page.waitForTimeout(300);
      const atBottom = await page.evaluate(
        ([prev, s]) => {
          if (window.scrollY === prev) window.scrollBy(0, s);
          return window.innerHeight + window.scrollY >= document.body.scrollHeight - 5;
        },
        [before, step] as const,
      );
      if (atBottom) break;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch {
    // pagina cambiata o chiusa durante lo scroll: si prosegue con quanto raccolto
  }
}

export async function runSession(browser: Browser, plan: SessionPlan, env: SessionEnv): Promise<SessionResult> {
  const { config } = env;
  const p = config.protocollo;
  const harRel = `evidenze/${plan.id}.har`;
  // Il traffico si registra con i corpi in file separati, in una cartella temporanea: a fine sessione si compone il
  // file HAR con i soli corpi che servono (vedi assembleHar). Un video scaricato dalla pagina non passa dalla memoria.
  const harTmp = join(env.runDir, 'evidenze', `.har-${plan.id}`);
  mkdirSync(harTmp, { recursive: true });
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const screenshots: Evidence[] = [];
  const domain = registrableDomain(new URL(plan.site).hostname);

  const context = await browser.newContext({
    userAgent: env.userAgent,
    locale: config.browser.locale,
    timezoneId: config.browser.timezone,
    viewport: config.browser.viewport,
    extraHTTPHeaders: { 'Accept-Language': `${config.browser.locale},${config.browser.locale.split('-')[0]};q=0.9` },
    recordHar: { path: join(harTmp, `${plan.id}.har`), mode: 'full', content: 'attach' },
  });
  context.setDefaultTimeout(15000);
  const collector = new Collector(context, new PartyResolver(domain, config.dominiPropri), env.classifier);
  const page = await context.newPage();
  /** Scheda fotografata: nelle navigazioni manuali può essere un'altra scheda aperta dal sito. */
  let shotPage = page;

  /** Passo in corso: se la sessione si blocca, l'anomalia dice dove. */
  let stage = 'apertura del browser';
  const shot = async (label: string) => {
    stage = `screenshot "${label}" di ${maskPii(collector.currentUrl)}`;
    const rel = `evidenze/${plan.id}_${slug(label)}.png`;
    try {
      await (shotPage.isClosed() ? page : shotPage).screenshot({ path: join(env.runDir, rel), timeout: 15000 });
      screenshots.push({ label, file: rel });
    } catch (e) {
      errors.push(`screenshot "${label}" non riuscito: ${(e as Error).message.split('\n')[0]}`);
    }
  };

  let blocked: BotBlock | null = null;
  const visit = async (url: string): Promise<boolean> => {
    stage = `caricamento di ${maskPii(url)}`;
    collector.beginNavigation(url);
    let response: Response | null = null;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: p.timeoutNavigazione });
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      const hint = /ERR_NETWORK_IO_SUSPENDED/.test(msg) ? ' — il computer è andato in stop durante l\'audit' : /ERR_INTERNET_DISCONNECTED/.test(msg) ? ' — connessione a internet assente' : '';
      errors.push(`navigazione non riuscita su ${url}: ${msg}${hint}`);
      collector.endNavigation();
      return false;
    }
    collector.currentUrl = page.url();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(p.attesaDopoCaricamento);
    // Pagina che rimanda altrove, anche dopo il caricamento (es. passo del preventivo aperto direttamente che porta alla pagina di errore)
    const strip = (u: string) => {
      try {
        const x = new URL(u);
        return x.origin + x.pathname.replace(/\/+$/, '');
      } catch {
        return u;
      }
    };
    if (strip(page.url()) !== strip(url)) {
      collector.currentUrl = maskPii(page.url());
      const note = `la pagina ${url} ha portato a ${maskPii(page.url())} (reindirizzamento)`;
      if (!errors.includes(note)) errors.push(note);
    }
    // Una pagina di verifica anti-bot non è il sito: la sessione non è valida e non si prosegue.
    blocked ??= await detectBotChallenge(page, response);
    if (blocked) {
      errors.push(`accesso bloccato da ${blocked.provider} (${blocked.signal}) su ${blocked.url}: sessione non valida`);
      return false;
    }
    return true;
  };

  const settle = async () => {
    stage = `attesa e scroll su ${maskPii(collector.currentUrl)}`;
    if (p.scroll) {
      // Lo scroll è un'azione dell'utente: ciò che compare da qui in poi, su questa pagina, non è più "al caricamento".
      await scrollPage(page, () => collector.markScroll());
      await page.waitForTimeout(p.attesaDopoScroll);
    }
    await collector.snapshot(page);
    await readStatsProbe();
  };

  /**
   * Configurazione di Matomo/Piwik ospitato sul sito, a fine pagina: comandi _paq scritti nella pagina (il tracker
   * sostituisce l'array _paq dopo averlo letto, quindi si leggono anche gli script in linea) e hasCookies() del tracker.
   */
  const statsProbe: StatsProbe[] = [];
  const readStatsProbe = async () => {
    const r = await withTimeout(
      page.evaluate(() => {
        const w = window as unknown as { _paq?: unknown; Matomo?: { getAsyncTrackers?: () => unknown[] }; Piwik?: { getAsyncTrackers?: () => unknown[] } };
        const cmds = new Set<string>();
        if (Array.isArray(w._paq)) for (const c of w._paq) if (Array.isArray(c) && typeof c[0] === 'string') cmds.add(c[0]);
        for (const sc of Array.from(document.scripts)) {
          if (sc.src || !sc.textContent?.includes('_paq')) continue;
          for (const m of sc.textContent.matchAll(/_paq\.push\(\s*\[\s*['"]([A-Za-z]+)['"]/g)) cmds.add(m[1]);
        }
        let hasCookies: boolean | null = null;
        let consentRequired: boolean | null = null;
        try {
          const t = (w.Matomo ?? w.Piwik)?.getAsyncTrackers?.()[0] as { hasCookies?: () => boolean; isConsentRequired?: () => boolean } | undefined;
          if (t && typeof t.hasCookies === 'function') hasCookies = !!t.hasCookies();
          if (t && typeof t.isConsentRequired === 'function') consentRequired = !!t.isConsentRequired();
        } catch {
          // tracker non leggibile
        }
        return cmds.size || hasCookies !== null ? { url: location.href, paq: [...cmds], hasCookies, consentRequired } : null;
      }),
      5000,
      'lettura della configurazione di Matomo',
    ).catch(() => null);
    if (r) statsProbe.push({ ...r, url: maskPii(r.url), source: 'pagina' });
  };

  let interaction: InteractionReport = {
    method: 'nessuno',
    detectedCmps: [],
    outcome: 'non-applicabile',
    layer: null,
    via: null,
    detail: 'scenario senza interazione',
    verification: 'non-applicabile',
    verificationDetail: '',
    bannerVisibleBefore: false,
    bannerVisibleAfter: null,
  };
  let choiceAt: string | null = null;
  let bannerAnalysis: BannerAnalysis | undefined;
  let revocation: SessionResult['revocation'];
  let revokeAfterChoice: SessionResult['revokeAfterChoice'];
  let manual: SessionResult['manual'];
  let unreachable: string | undefined;
  let truncated: string | undefined;
  let replay: SessionResult['replay'];
  const runReplay = async () => {
    stage = `percorso registrato su ${maskPii(collector.currentUrl)}`;
    const { lastPage, ...r } = await replayJourney(page, collector, plan.replay!);
    shotPage = lastPage;
    replay = { ...r, recordedAt: plan.replay!.savedAt, fromSession: plan.replay!.fromSession };
    env.log?.(`    percorso registrato: ${r.stepsDone}/${r.stepsTotal} passi${r.stoppedAt ? `; interrotto al ${r.stoppedAt}` : ''}`);
    if (r.stoppedAt) errors.push(`percorso registrato interrotto al ${r.stoppedAt}: il sito può essere cambiato, va registrato di nuovo`);
    await shot('3-fine');
  };
  const runManual = async () => {
    env.log?.(`    NAVIGAZIONE MANUALE: nella finestra del browser segui le istruzioni e premi "Ho finito" (massimo ${Math.round(plan.manual!.maxMs / 60000)} minuti).`);
    const { lastPage, ...m } = await manualJourney(page, collector, plan.manual!, env.manualDriver, env.onManualFinisher);
    manual = m;
    shotPage = lastPage;
    env.log?.(`    navigazione manuale conclusa (${manual.endedBy === 'operatore' ? 'premuto "Ho finito"' : manual.endedBy === 'tempo' ? 'tempo scaduto' : 'finestra chiusa'})`);
    if (manual.errorPages?.length) errors.push(`navigazione manuale: ${manual.errorPages.length === 1 ? 'una pagina ha' : `${manual.errorPages.length} pagine hanno`} risposto con un errore (${manual.errorPages.slice(0, 3).map((e) => `${e.status} su ${e.url}`).join('; ')}); le pagine restano nel percorso, i fatti osservati lì valgono come quelli delle altre pagine`);
    if (manualIncomplete(manual)) {
      const note = `navigazione manuale probabilmente incompleta: conclusa dopo ${manual.seconds} s con ${manual.pages.length === 1 ? 'una sola pagina' : `${manual.pages.length} pagine`} visitate; va rifatta`;
      errors.push(note);
      env.log?.(`    ATTENZIONE: ${note}`);
    }
    await shot('3-fine');
  };
  const banner = plan.siteConfig.banner;
  const bannerWait = banner?.attesa ?? DEFAULT_BANNER_WAIT;

  const flow = async () => {
    const [first, ...rest] = plan.pages;
    const firstOk = await visit(first);
    // Prima pagina non caricata (e non per un blocco anti-bot): nessun dato sul sito, la sessione non è valida
    if (!firstOk && !blocked) unreachable = errors[errors.length - 1] ?? 'prima pagina non raggiungibile';
    if (blocked) {
      await shot('1-banner');
      interaction = { ...interaction, outcome: 'non-applicabile', detail: `accesso bloccato da ${blocked.provider}: ${blocked.signal}` };
    }
    if (firstOk) {
      // Prima pagina: banner, stato iniziale, poi (eventuale) scelta. Lo scroll avviene dopo la scelta,
      // per non confondere l'effetto dello scroll con quello del click.
      const obs = await observeBanner(page, banner, bannerWait);
      await shot('1-banner');
      await collector.snapshot(page);
      // L'elenco dichiarato si legge solo dal gestore mostrato sul sito stesso: una navigazione manuale che parte da
      // un altro sito (es. www per un preventivo su app) mostra il gestore di quell'altro sito.
      const bare = (h: string) => h.replace(/^www\./, '');
      const onSite = (() => {
        try {
          return bare(new URL(page.url()).hostname) === bare(new URL(plan.site).hostname);
        } catch {
          return false;
        }
      })();
      if (env.onDeclared && onSite) {
        for (const a of obs.adapters) {
          const items = a.declared ? await a.declared(page).catch(() => null) : null;
          if (items?.length) {
            env.onDeclared(items, a.name);
            break;
          }
        }
      }
      if (plan.scenario === 'nessuna-azione') {
        interaction = {
          ...interaction,
          detectedCmps: obs.adapters.map((a) => a.name),
          detail: obs.visible ? 'banner visibile, nessuna scelta effettuata' : 'nessun banner visibile',
          consentStateBefore: obs.states,
          bannerVisibleBefore: obs.visible,
        };
        if (plan.manual) {
          await runManual();
          return;
        }
        if (plan.replay) {
          await runReplay();
          return;
        }
        await settle();
        await shot('3-fine');
        if (plan.analyzeBanner && obs.visible) {
          collector.pause();
          stage = `analisi del banner su ${maskPii(collector.currentUrl)}`;
          bannerAnalysis = await analyzeBanner(page, obs.adapters, shot).catch((e) => {
            errors.push(`analisi del banner non riuscita: ${(e as Error).message.split('\n')[0]}`);
            return undefined;
          });
        }
      } else {
        const mark = () => collector.markChoice();
        interaction =
          plan.scenario === 'personalizza'
            ? await performPersonalize(page, banner, p.attesaDopoScelta, bannerWait, mark)
            : plan.scenario === 'chiudi'
              ? await performClose(page, banner, p.attesaDopoScelta, bannerWait, mark)
              : await performChoice(page, plan.scenario === 'rifiuta' ? 'rifiuta' : 'accetta', banner, p.attesaDopoScelta, bannerWait, mark);
        if (interaction.outcome === 'eseguito') {
          choiceAt = new Date(collector.choiceEpoch!).toISOString();
          await shot('2-dopo-scelta');
        } else {
          collector.undoChoice();
        }
        if (plan.manual) {
          await runManual();
          return;
        }
        if (plan.replay) {
          await runReplay();
          return;
        }
        await settle();
        // Stesso percorso in tutti gli scenari con scelta: si ricarica la pagina di partenza e si visitano le stesse
        // pagine nello stesso ordine. Così "dopo il rifiuto", "dopo l'accettazione" e "dopo la revoca" confrontano le stesse pagine.
        const journey = async () => {
          for (const [k, url] of [first, ...rest].entries()) {
            if (await visit(url)) {
              // Dopo la scelta (o la X): il banner ricompare alla pagina successiva? Stessa funzione di visibilità
              // usata prima e dopo la scelta, dopo il caricamento e l'attesa standard della pagina
              if (k === 0 && interaction.outcome === 'eseguito' && interaction.bannerOnNextPage === undefined) {
                const again = await bannerVisible(page, await detectCmps(page), banner).catch(() => false);
                interaction = { ...interaction, bannerOnNextPage: again };
                // Comando per rivedere la scelta: molti gestori lo mostrano solo dopo la scelta
                const rev = await findRevokeInPage(page).catch(() => null);
                if (rev) revokeAfterChoice = { text: rev.text, how: rev.how, url: maskPii(page.url()) };
              }
              await settle();
            } else if (blocked) break;
          }
        };
        await journey();
        await shot('3-fine');
        // Scenario "revoca": dopo aver navigato con il consenso, lo si revoca e si torna sulla prima pagina.
        if (plan.scenario === 'revoca' && interaction.outcome === 'eseguito' && !blocked) {
          collector.markRevoke();
          const rev = await performRevocation(page, banner, p.attesaDopoScelta, bannerWait, plan.revokePage);
          await shot('4-dopo-revoca');
          const remaining = (await context.cookies())
            .filter((c) => NON_TECHNICAL.has(env.classifier.classifyName(c.name, c.domain).category))
            .map((c) => `${c.name} (${c.domain})`);
          revocation = { ...rev, remaining };
          if (rev.outcome === 'eseguita') {
            await settle();
            // Dopo la revoca, lo stesso percorso: ciò che parte qui è nuova raccolta, non l'invio residuo della pagina corrente
            collector.markRevokeNav();
            await journey();
            await shot('5-fine-revoca');
          }
        }
      }
    }
  };

  try {
    // Tetto di durata: una pagina che non risponde non deve bloccare l'intera esecuzione.
    // Le sessioni manuali durano quanto serve all'operatore, entro il loro tempo massimo
    await withTimeout(flow(), sessionBudgetMs(plan, p, bannerWait), 'sessione interrotta');
  } catch (e) {
    const msg = (e as Error).message.split('\n')[0];
    if (msg.startsWith('sessione interrotta')) truncated = stage;
    errors.push(`errore durante la sessione: ${msg}${msg.startsWith('sessione interrotta') ? ` (passo in corso: ${stage})` : ''}`);
  } finally {
    // La chiusura salva il file HAR: se non avviene, la sessione resta senza HAR e lo si annota.
    const err = await closeSafely(context, 90000, 'chiusura contesto (salvataggio HAR)');
    if (err) errors.push(err);
    try {
      assembleHar(harTmp, `${plan.id}.har`, join(env.runDir, harRel), config.report.harContenuti);
    } catch (e) {
      // dopo una chiusura non riuscita il file può mancare: l'anomalia della chiusura è già annotata
      if (!err) errors.push(`file HAR non composto: ${(e as Error).message.split('\n')[0]}`);
      rmSync(harTmp, { recursive: true, force: true });
    }
  }

  const { cookies, storage, requests, visits } = collector.results();
  return {
    id: plan.id,
    site: plan.site,
    registrableDomain: domain,
    scenario: plan.scenario,
    pageType: plan.pageType,
    pages: manual ? manual.pages : plan.pages,
    startedAt,
    endedAt: new Date().toISOString(),
    choiceAt,
    interaction,
    cookies,
    storage,
    requests,
    screenshots,
    har: harRel,
    errors,
    visits,
    ...(statsProbe.length ? { statsProbe } : {}),
    ...(blocked ? { blocked } : {}),
    ...(bannerAnalysis ? { bannerAnalysis } : {}),
    ...(revocation ? { revocation } : {}),
    ...(revokeAfterChoice ? { revokeAfterChoice } : {}),
    ...(manual ? { manual } : {}),
    ...(replay ? { replay, pages: replay.pages } : {}),
    ...(unreachable ? { unreachable } : {}),
    ...(truncated ? { truncated } : {}),
    ...(plan.repeat ? { repeat: plan.repeat } : {}),
  };
}
