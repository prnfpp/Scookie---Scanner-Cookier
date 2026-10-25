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
import { manualJourney, type ManualPlan } from './manual.js';

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

  const shot = async (label: string) => {
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
    collector.currentUrl = url;
    let response: Response | null = null;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: p.timeoutNavigazione });
    } catch (e) {
      errors.push(`navigazione non riuscita su ${url}: ${(e as Error).message.split('\n')[0]}`);
      return false;
    }
    collector.currentUrl = page.url();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(p.attesaDopoCaricamento);
    // Una pagina di verifica anti-bot non è il sito: la sessione non è valida e non si prosegue.
    blocked ??= await detectBotChallenge(page, response);
    if (blocked) {
      errors.push(`accesso bloccato da ${blocked.provider} (${blocked.signal}) su ${blocked.url}: sessione non valida`);
      return false;
    }
    return true;
  };

  const settle = async () => {
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
  const runManual = async () => {
    env.log?.(`    NAVIGAZIONE MANUALE: nella finestra del browser segui le istruzioni e premi "Ho finito" (massimo ${Math.round(plan.manual!.maxMs / 60000)} minuti).`);
    manual = await manualJourney(page, collector, plan.manual!, env.manualDriver);
    await shot('3-fine');
  };
  const banner = plan.siteConfig.banner;
  const bannerWait = banner?.attesa ?? DEFAULT_BANNER_WAIT;

  const flow = async () => {
    const [first, ...rest] = plan.pages;
    const firstOk = await visit(first);
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
        await settle();
        await shot('3-fine');
        if (plan.analyzeBanner && obs.visible) {
          collector.pause();
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
        await settle();
        for (const url of rest) {
          if (await visit(url)) await settle();
          else if (blocked) break;
        }
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
            if (await visit(first)) await settle();
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
    errors.push(`errore durante la sessione: ${(e as Error).message.split('\n')[0]}`);
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
  };
}
