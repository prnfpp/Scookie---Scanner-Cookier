import type { Page } from 'playwright';
import { maskPii } from '../util/pii.js';
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

/**
 * Riquadro con le istruzioni e il pulsante "Ho finito", in shadow DOM per non interferire con la pagina.
 * Costruito con le API del DOM e stili impostati da script: le Content-Security-Policy dei siti bloccano gli
 * attributi style e innerHTML, e il riquadro comparirebbe senza formattazione o non comparirebbe. Dove possibile
 * sta nel top layer (popover), sopra i banner; con una finestra modale del sito aperta si sposta dentro di essa,
 * altrimenti non sarebbe cliccabile. Se la pagina lo rimuove, si rimonta.
 */
const OVERLAY = (instructions: string) => `(() => {
  const css = (el, st) => { for (const [k, v] of Object.entries(st)) el.style.setProperty(k, v, 'important'); return el; };
  const make = () => {
    const host = document.createElement('div');
    host.id = 'scookie-operatore';
    css(host, { position: 'fixed', left: '12px', bottom: '12px', 'z-index': '2147483647', margin: '0', padding: '0', border: '0', background: 'transparent', inset: 'auto auto 12px 12px', overflow: 'visible' });
    const root = host.attachShadow({ mode: 'open' });
    const box = css(document.createElement('div'), { font: '14px/1.4 -apple-system, system-ui, sans-serif', background: '#1d1d1f', color: '#fff', padding: '12px 14px', 'border-radius': '8px', 'max-width': '340px', 'box-shadow': '0 4px 16px rgba(0,0,0,.3)', 'text-align': 'left' });
    const title = css(document.createElement('strong'), { display: 'block', color: '#fff' });
    title.textContent = 'Scookie: navigazione manuale';
    const p1 = css(document.createElement('p'), { margin: '6px 0', color: '#fff' });
    p1.textContent = ${JSON.stringify(instructions)};
    const p2 = css(document.createElement('p'), { margin: '6px 0', color: '#bbb' });
    p2.textContent = 'Non toccare il banner dei cookie. Tutto ciò che accade viene registrato.';
    const btn = css(document.createElement('button'), { font: 'inherit', 'font-weight': '600', background: '#34c759', color: '#000', border: '0', 'border-radius': '6px', padding: '8px 16px', cursor: 'pointer', display: 'inline-block' });
    btn.type = 'button';
    btn.textContent = 'Ho finito';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.textContent = 'Chiusura…';
      if (window.__scookieFatto) window.__scookieFatto();
    }, true);
    box.append(title, p1, p2, btn);
    root.append(box);
    return host;
  };
  let host = null;
  const mount = () => {
    if (!document.body || window.__scookieStop) return;
    // una finestra modale del sito rende inerte il resto della pagina: il riquadro si sposta dentro di essa
    let modal = null;
    try { modal = document.querySelector('dialog:modal'); } catch {}
    const target = modal || document.body;
    if (!host) host = make();
    if (host.parentNode !== target) {
      target.appendChild(host);
      if (typeof host.showPopover === 'function') {
        try { host.popover = 'manual'; host.showPopover(); } catch {}
      }
    }
    host.removeAttribute('inert');
    host.removeAttribute('aria-hidden');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  setInterval(mount, 500);
})()`;

/**
 * Navigazione manuale: l'operatore percorre a mano un flusso che il tool non sa ripercorrere (es. un preventivo
 * con moduli), nella finestra del browser. La raccolta continua come nelle sessioni automatiche; la sessione
 * finisce quando l'operatore preme "Ho finito" o allo scadere del tempo massimo.
 * `driver` (solo test) simula l'operatore.
 */
export async function manualJourney(
  page: Page,
  collector: Collector,
  plan: ManualPlan,
  driver?: (page: Page) => Promise<void>,
  /** Riceve la funzione che chiude la sessione (pulsante "Ho finito" dell'interfaccia), poi null a sessione chiusa. */
  onFinisher?: (finish: (() => void) | null) => void,
): Promise<ManualOutcome> {
  const started = Date.now();
  const pages: string[] = [page.url()];
  let finish: (by: ManualOutcome['endedBy']) => void = () => {};
  const done = new Promise<ManualOutcome['endedBy']>((r) => (finish = r));

  // sul contesto, non sulla pagina: il pulsante funziona anche nelle schede aperte dal sito
  await page.context().exposeBinding('__scookieFatto', () => finish('operatore')).catch(() => {});
  onFinisher?.(() => finish('operatore'));
  await page.context().addInitScript(OVERLAY(plan.instructions));
  await page.evaluate(OVERLAY(plan.instructions)).catch(() => {});

  const onNav = (frame: import('playwright').Frame) => {
    if (frame !== page.mainFrame()) return;
    const url = maskPii(frame.url());
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
  onFinisher?.(null);
  clearInterval(timer);
  clearTimeout(limit);
  page.off('framenavigated', onNav);
  await page
    .evaluate(() => {
      (window as unknown as { __scookieStop: boolean }).__scookieStop = true;
      document.getElementById('scookie-operatore')?.remove();
    })
    .catch(() => {});
  if (endedBy !== 'pagina-chiusa') await collector.snapshot(page).catch(() => {});
  return { instructions: plan.instructions, pages, endedBy, seconds: Math.round((Date.now() - started) / 1000) };
}
