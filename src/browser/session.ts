import { join } from 'node:path';
import type { Browser, Page, Response } from 'playwright';
import type { Classifier } from '../classify/classifier.js';
import type { AuditConfig, SiteConfig } from '../config/schema.js';
import { analyzeBanner } from '../cmp/analysis.js';
import { observeBanner, performChoice, performPersonalize, performRevocation } from '../cmp/interact.js';
import { NON_TECHNICAL, type BannerAnalysis, type DeclaredItem, type Evidence, type InteractionReport, type ScenarioName, type SessionResult } from '../types.js';
import { PartyResolver, registrableDomain } from '../util/domains.js';
import { closeSafely, slug, withTimeout } from '../util/misc.js';
import { detectBotChallenge, type BotBlock } from './antibot.js';
import { Collector } from './collector.js';
import { trimHar } from './har.js';
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

/** Scorre la pagina a passi, per attivare i contenuti caricati allo scroll, e torna in cima. */
async function scrollPage(page: Page) {
  await page
    .evaluate(async () => {
      const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
      for (let i = 0; i < 12; i++) {
        window.scrollBy(0, step);
        await new Promise((r) => setTimeout(r, 300));
        if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 5) break;
      }
      window.scrollTo(0, 0);
    })
    .catch(() => {});
}

export async function runSession(browser: Browser, plan: SessionPlan, env: SessionEnv): Promise<SessionResult> {
  const { config } = env;
  const p = config.protocollo;
  const harRel = `evidenze/${plan.id}.har`;
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
    recordHar: { path: join(env.runDir, harRel), mode: 'full', content: 'embed' },
  });
  context.setDefaultTimeout(15000);
  const collector = new Collector(context, new PartyResolver(domain, config.dominiPropri), env.classifier);
  const page = await context.newPage();

  /** Passo in corso: se la sessione si blocca, l'anomalia dice dove. */
  let stage = 'apertura del browser';
  const shot = async (label: string) => {
    stage = `screenshot "${label}" di ${maskPii(collector.currentUrl)}`;
    const rel = `evidenze/${plan.id}_${slug(label)}.png`;
    try {
      await page.screenshot({ path: join(env.runDir, rel), timeout: 15000 });
      screenshots.push({ label, file: rel });
    } catch (e) {
      errors.push(`screenshot "${label}" non riuscito: ${(e as Error).message.split('\n')[0]}`);
    }
  };

  let blocked: BotBlock | null = null;
  const visit = async (url: string): Promise<boolean> => {
    stage = `caricamento di ${maskPii(url)}`;
    collector.currentUrl = url;
    let response: Response | null = null;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: p.timeoutNavigazione });
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      const hint = /ERR_NETWORK_IO_SUSPENDED/.test(msg) ? ' — il computer è andato in stop durante l\'audit' : /ERR_INTERNET_DISCONNECTED/.test(msg) ? ' — connessione a internet assente' : '';
      errors.push(`navigazione non riuscita su ${url}: ${msg}${hint}`);
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
      // Lo scroll è un'azione dell'utente: ciò che compare da qui in poi non è più "al caricamento".
      collector.markScroll();
      await scrollPage(page);
      await page.waitForTimeout(p.attesaDopoScroll);
    }
    await collector.snapshot(page);
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
  let manual: SessionResult['manual'];
  let unreachable: string | undefined;
  let replay: SessionResult['replay'];
  const runReplay = async () => {
    stage = `percorso registrato su ${maskPii(collector.currentUrl)}`;
    const r = await replayJourney(page, collector, plan.replay!);
    replay = { ...r, recordedAt: plan.replay!.savedAt, fromSession: plan.replay!.fromSession };
    env.log?.(`    percorso registrato: ${r.stepsDone}/${r.stepsTotal} passi${r.stoppedAt ? `; interrotto al ${r.stoppedAt}` : ''}`);
    if (r.stoppedAt) errors.push(`percorso registrato interrotto al ${r.stoppedAt}: il sito può essere cambiato, va registrato di nuovo`);
    await shot('3-fine');
  };
  const runManual = async () => {
    env.log?.(`    NAVIGAZIONE MANUALE: nella finestra del browser segui le istruzioni e premi "Ho finito" (massimo ${Math.round(plan.manual!.maxMs / 60000)} minuti).`);
    manual = await manualJourney(page, collector, plan.manual!, env.manualDriver, env.onManualFinisher);
    env.log?.(`    navigazione manuale conclusa (${manual.endedBy === 'operatore' ? 'premuto "Ho finito"' : manual.endedBy === 'tempo' ? 'tempo scaduto' : 'finestra chiusa'})`);
    if (manual.pages.length <= 1 || manual.seconds < 60) {
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
      if (env.onDeclared) {
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
          for (const url of [first, ...rest]) {
            if (await visit(url)) await settle();
            else if (blocked) break;
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
    await withTimeout(flow(), plan.manual ? Math.max(p.timeoutSessione, plan.manual.maxMs + 120000) : p.timeoutSessione, 'sessione interrotta');
  } catch (e) {
    const msg = (e as Error).message.split('\n')[0];
    errors.push(`errore durante la sessione: ${msg}${msg.startsWith('sessione interrotta') ? ` (passo in corso: ${stage})` : ''}`);
  } finally {
    // La chiusura salva il file HAR: se non avviene, la sessione resta senza HAR e lo si annota.
    const err = await closeSafely(context, 90000, 'chiusura contesto (salvataggio HAR)');
    if (err) errors.push(err);
    else {
      try {
        trimHar(join(env.runDir, harRel), config.report.harContenuti);
      } catch (e) {
        errors.push(`riduzione del file HAR non riuscita: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }

  const { cookies, storage, requests } = collector.results();
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
    ...(blocked ? { blocked } : {}),
    ...(bannerAnalysis ? { bannerAnalysis } : {}),
    ...(revocation ? { revocation } : {}),
    ...(manual ? { manual } : {}),
    ...(replay ? { replay, pages: replay.pages } : {}),
    ...(unreachable ? { unreachable } : {}),
    ...(plan.repeat ? { repeat: plan.repeat } : {}),
  };
}
