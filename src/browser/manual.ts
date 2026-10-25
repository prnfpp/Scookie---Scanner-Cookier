import type { Page } from 'playwright';
import type { Collector } from './collector.js';

export interface ManualPlan {
  /** Istruzioni mostrate all'operatore (es. "compila il preventivo con la targa di prova AB123CD"). */
  instructions: string;
  maxMs: number;
}

export interface ManualOutcome {
  instructions: string;
  /** Pagine visitate dall'operatore, nell'ordine. */
  pages: string[];
  endedBy: 'operatore' | 'tempo' | 'pagina-chiusa';
  seconds: number;
}

/** Riquadro con le istruzioni e il pulsante "Ho finito", in shadow DOM per non interferire con la pagina. */
const OVERLAY = (instructions: string) => `(() => {
  const mount = () => {
    if (document.getElementById('scookie-operatore') || !document.body) return;
    const host = document.createElement('div');
    host.id = 'scookie-operatore';
    host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div style="font:14px/1.4 sans-serif;background:#1d1d1f;color:#fff;padding:12px 14px;border-radius:8px;max-width:340px;box-shadow:0 4px 16px rgba(0,0,0,.3)">' +
      '<strong>Scookie: navigazione manuale</strong><p style="margin:6px 0">' + ${JSON.stringify(instructions)}.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]) + '</p>' +
      '<p style="margin:6px 0;color:#bbb">Non toccare il banner dei cookie. Tutto ciò che accade viene registrato.</p>' +
      '<button id="fatto" style="font:inherit;background:#34c759;color:#000;border:0;border-radius:6px;padding:6px 14px;cursor:pointer">Ho finito</button></div>';
    root.getElementById('fatto').addEventListener('click', () => window.__scookieFatto && window.__scookieFatto());
    document.body.appendChild(host);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})()`;

/**
 * Navigazione manuale: l'operatore percorre a mano un flusso che il tool non sa ripercorrere (es. un preventivo
 * con moduli), nella finestra del browser. La raccolta continua come nelle sessioni automatiche; la sessione
 * finisce quando l'operatore preme "Ho finito" o allo scadere del tempo massimo.
 * `driver` (solo test) simula l'operatore.
 */
export async function manualJourney(page: Page, collector: Collector, plan: ManualPlan, driver?: (page: Page) => Promise<void>): Promise<ManualOutcome> {
  const started = Date.now();
  const pages: string[] = [page.url()];
  let finish: (by: ManualOutcome['endedBy']) => void = () => {};
  const done = new Promise<ManualOutcome['endedBy']>((r) => (finish = r));

  await page.exposeBinding('__scookieFatto', () => finish('operatore')).catch(() => {});
  await page.context().addInitScript(OVERLAY(plan.instructions));
  await page.evaluate(OVERLAY(plan.instructions)).catch(() => {});

  const onNav = (frame: import('playwright').Frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    collector.currentUrl = url;
    if (pages[pages.length - 1] !== url) pages.push(url);
  };
  page.on('framenavigated', onNav);
  page.once('close', () => finish('pagina-chiusa'));
  // Fotografia periodica di cookie e storage, come dopo ogni pagina nelle sessioni automatiche
  const timer = setInterval(() => void collector.snapshot(page).catch(() => {}), 3000);
  const limit = setTimeout(() => finish('tempo'), plan.maxMs);
  if (driver) void driver(page).catch(() => {});

  const endedBy = await done;
  clearInterval(timer);
  clearTimeout(limit);
  page.off('framenavigated', onNav);
  await page.evaluate(() => document.getElementById('scookie-operatore')?.remove()).catch(() => {});
  if (endedBy !== 'pagina-chiusa') await collector.snapshot(page).catch(() => {});
  return { instructions: plan.instructions, pages, endedBy, seconds: Math.round((Date.now() - started) / 1000) };
}
