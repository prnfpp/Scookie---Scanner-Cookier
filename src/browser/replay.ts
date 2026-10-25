import type { Frame, Locator, Page } from 'playwright';
import { maskPii } from '../util/pii.js';
import type { Collector } from './collector.js';

/** Un'azione dell'operatore durante la navigazione manuale, registrata per poterla rigiocare. */
export interface RecordedStep {
  type: 'click' | 'fill' | 'select' | 'check';
  /** Selettore CSS dell'elemento, il più stabile trovato (id, name, data-testid, aria-label, percorso). */
  css: string;
  /** Testo visibile dell'elemento: serve se il selettore non funziona più. */
  text: string;
  tag: string;
  value?: string;
  checked?: boolean;
  /** Pagina in cui è avvenuta l'azione. */
  url: string;
}

export interface RecordedPath {
  site: string;
  start: string;
  savedAt: string;
  fromSession: string;
  steps: RecordedStep[];
}

export interface ReplayOutcome {
  pages: string[];
  stepsDone: number;
  stepsTotal: number;
  /** Motivo dell'interruzione, se il percorso non è stato completato. */
  stoppedAt?: string;
  seconds: number;
}

/**
 * Registratore iniettato nelle pagine della navigazione manuale. Ignora il riquadro di Scookie e i banner dei
 * gestori del consenso (la scelta sul banner la fa il tool). Le azioni arrivano a __scookieRec.
 */
export const RECORDER = `(() => {
  if (window.__scookieRecOn) return;
  window.__scookieRecOn = true;
  const CONSENT = '#scookie-operatore, #onetrust-banner-sdk, #onetrust-pc-sdk, #onetrust-consent-sdk, #hs-eu-cookie-confirmation, #hs-banner-parent, #hs-modal, #CybotCookiebotDialog, #didomi-host, #usercentrics-root, #iubenda-cs-banner, #cc-main, #cmplz-cookiebanner-container, .cky-consent-container, .cky-preference-center';
  const ACTIONABLE = 'a, button, input, select, textarea, label, summary, [role="button"], [role="option"], [role="radio"], [role="checkbox"], [role="tab"], [role="link"], [onclick]';
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v.replace(/[^\\w-]/g, '\\\\$&'));
  const stable = (v) => v && !/\\d{4,}|[a-f0-9]{8,}|^(ember|react|mui|radix|headlessui|ng-)/i.test(v);
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } };
  const selector = (el) => {
    if (el.id && stable(el.id) && unique('#' + esc(el.id))) return '#' + esc(el.id);
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa', 'name', 'aria-label', 'placeholder', 'title']) {
      const v = el.getAttribute(a);
      if (v && v.length < 80) {
        const s = el.tagName.toLowerCase() + '[' + a + '="' + v.replace(/"/g, '\\\\"') + '"]';
        if (unique(s)) return s;
      }
    }
    if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox') && el.name) {
      const s = 'input[name="' + el.name + '"][value="' + (el.value || '').replace(/"/g, '\\\\"') + '"]';
      if (unique(s)) return s;
    }
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && parts.length < 6; n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id && stable(n.id)) { parts.unshift('#' + esc(n.id)); break; }
      const sib = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [];
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')';
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const send = (type, el, extra) => {
    if (!el || el.closest(CONSENT)) return;
    try {
      window.__scookieRec && window.__scookieRec(Object.assign({ type, css: selector(el), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80), tag: el.tagName.toLowerCase(), url: location.href }, extra || {}));
    } catch (e) {}
  };
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest(ACTIONABLE) || e.target : null;
    if (!t || !e.isTrusted) return;
    // i campi si registrano col loro valore (evento change), non col click
    if (t.matches('input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, select')) return;
    if (t.matches('input[type=checkbox], input[type=radio]')) return;
    send('click', t);
  }, true);
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !e.isTrusted) return;
    if (t.matches('select')) send('select', t, { value: t.value });
    else if (t.matches('input[type=checkbox], input[type=radio]')) send('check', t, { checked: t.checked });
    else if (t.matches('input, textarea')) send('fill', t, { value: t.value });
  }, true);
})()`;

/** Cerca l'elemento di un passo: prima il selettore, poi il testo visibile. */
async function locate(page: Page, step: RecordedStep, timeout: number): Promise<Locator | null> {
  const frames: (Page | Frame)[] = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const f of frames) {
      const byCss = f.locator(step.css).first();
      if (await byCss.isVisible().catch(() => false)) return byCss;
      if (step.type === 'click' && step.text) {
        const byText = f.getByText(step.text, { exact: true }).first();
        if (await byText.isVisible().catch(() => false)) return byText;
      }
    }
    await page.waitForTimeout(500);
  }
  // ultimo tentativo: elemento presente ma non visibile (es. casella nascosta dietro un'etichetta grafica)
  const hidden = page.locator(step.css).first();
  return (await hidden.count().catch(() => 0)) ? hidden : null;
}

const describe = (s: RecordedStep, i: number) => `passo ${i + 1} (${s.type} su ${s.text ? `"${s.text}"` : s.css})`;

/**
 * Rigioca un percorso registrato dall'operatore, dopo la scelta sul banner: stessi clic e stessi valori nei campi
 * (i dati di prova). Così il flusso con i moduli diventa una sessione automatica, ripetibile in ogni esecuzione.
 */
export async function replayJourney(page: Page, collector: Collector, path: RecordedPath): Promise<ReplayOutcome> {
  const started = Date.now();
  const pages: string[] = [maskPii(page.url())];
  const onNav = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    const url = maskPii(frame.url());
    collector.currentUrl = url;
    if (pages[pages.length - 1] !== url) pages.push(url);
  };
  page.on('framenavigated', onNav);
  let done = 0;
  let stoppedAt: string | undefined;
  try {
    for (const [i, step] of path.steps.entries()) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      const el = await locate(page, step, 15000);
      if (!el) {
        stoppedAt = `${describe(step, i)}: elemento non trovato`;
        break;
      }
      try {
        if (step.type === 'click') await el.click({ timeout: 10000 }).catch(() => el.click({ timeout: 5000, force: true }));
        else if (step.type === 'fill') await el.fill(step.value ?? '', { timeout: 10000 });
        else if (step.type === 'select') await el.selectOption(step.value ?? '', { timeout: 10000 });
        else await el.setChecked(!!step.checked, { timeout: 10000, force: true });
      } catch (e) {
        stoppedAt = `${describe(step, i)}: ${(e as Error).message.split('\n')[0]}`;
        break;
      }
      done++;
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(700);
      await collector.snapshot(page).catch(() => {});
    }
    // l'ultima pagina del percorso resta aperta qualche secondo, come farebbe una persona
    await page.waitForTimeout(3000);
    await collector.snapshot(page).catch(() => {});
  } finally {
    page.off('framenavigated', onNav);
  }
  return { pages, stepsDone: done, stepsTotal: path.steps.length, ...(stoppedAt ? { stoppedAt } : {}), seconds: Math.round((Date.now() - started) / 1000) };
}
