import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { Classifier } from '../classify/classifier.js';
import type { AuditConfig, SiteConfig } from '../config/schema.js';
import { observeBanner, performChoice } from '../cmp/interact.js';
import type { DeclaredItem, Evidence, InteractionReport, ScenarioName, SessionResult } from '../types.js';
import { PartyResolver, registrableDomain } from '../util/domains.js';
import { slug } from '../util/misc.js';
import { Collector } from './collector.js';

export interface SessionPlan {
  id: string;
  site: string;
  siteConfig: SiteConfig;
  scenario: ScenarioName;
  pageType: string;
  pages: string[];
}

export interface SessionEnv {
  config: AuditConfig;
  runDir: string;
  classifier: Classifier;
  userAgent: string;
  /** Se definita, la sessione legge l'elenco dichiarato dal CMP e lo passa qui. */
  onDeclared?: (items: DeclaredItem[], cmp: string) => void;
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

  const visit = async (url: string): Promise<boolean> => {
    collector.currentUrl = url;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: p.timeoutNavigazione });
    } catch (e) {
      errors.push(`navigazione non riuscita su ${url}: ${(e as Error).message.split('\n')[0]}`);
      return false;
    }
    collector.currentUrl = page.url();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(p.attesaDopoCaricamento);
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
  const banner = plan.siteConfig.banner;
  const bannerWait = banner?.attesa ?? DEFAULT_BANNER_WAIT;

  try {
    const [first, ...rest] = plan.pages;
    if (await visit(first)) {
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
        await settle();
        await shot('3-fine');
      } else {
        interaction = await performChoice(page, plan.scenario === 'rifiuta' ? 'rifiuta' : 'accetta', banner, p.attesaDopoScelta, bannerWait, () =>
          collector.markChoice(),
        );
        if (interaction.outcome === 'eseguito') {
          choiceAt = new Date(collector.choiceEpoch!).toISOString();
          await shot('2-dopo-scelta');
        } else {
          collector.undoChoice();
        }
        await settle();
        for (const url of rest) {
          if (await visit(url)) await settle();
        }
        await shot('3-fine');
      }
    }
  } catch (e) {
    errors.push(`errore durante la sessione: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    await context.close().catch((e) => errors.push(`chiusura contesto: ${String(e)}`));
  }

  const { cookies, storage, requests } = collector.results();
  return {
    id: plan.id,
    site: plan.site,
    registrableDomain: domain,
    scenario: plan.scenario,
    pageType: plan.pageType,
    pages: plan.pages,
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
  };
}
