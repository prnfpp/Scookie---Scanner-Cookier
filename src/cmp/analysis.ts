import type { Page } from 'playwright';
import type { BannerAnalysis } from '../types.js';
import { frames, waitFor } from './dom.js';
import { TEXTS, clickCandidate, scan, type Candidate } from './heuristic.js';
import type { CmpAdapter } from './types.js';

const POLICY_TEXT = /cookie|privacy|informativa|policy|trattamento dei dati/i;
const CLOSE_LIKE = /^(×|✕|✖|x|chiudi|close|dismiss)$/i;

// Link o pulsanti per riaprire le preferenze dopo la scelta (di solito nel footer).
const REVOKE_TEXT =
  /((preferenze|impostazioni|gestisci|gestione|modifica|personalizza)\s.{0,25}cookie|cookie\s.{0,20}(preferenze|impostazioni|settings|preferences)|revoca.{0,30}consenso|privacy (settings|choices)|cookie settings|manage cookies|le tue scelte)/i;
const REVOKE_SELECTORS = [
  '.ot-sdk-show-settings',
  '#ot-sdk-btn',
  'a[href*="Cookiebot.renew"]',
  'a[href*="CookieConsent.renew"]',
  '.iubenda-cs-preferences-link',
  'a[href*="Didomi.preferences.show"]',
  '[data-cc="c-settings"]',
  '[data-cc="show-preferencesModal"]',
  '.cky-btn-revisit',
  '#cmplz-manage-consent',
  '#hs-eu-cookie-settings-button',
];

/** Classifica i pulsanti del primo livello del banner per funzione. */
function classify(candidates: Candidate[]) {
  const pick = (re: RegExp) => [...new Set(candidates.filter((c) => re.test(c.text)).map((c) => c.text))];
  return {
    accept: pick(TEXTS.accept),
    reject: pick(TEXTS.reject),
    preferences: pick(TEXTS.preferences),
    close: pick(CLOSE_LIKE),
    all: [...new Set(candidates.map((c) => c.text))],
  };
}

/**
 * Analisi della struttura del banner, oltre al comportamento: pulsanti al primo livello, link alla cookie policy,
 * categorie pre-attivate nel secondo livello, presenza di un modo per riaprire le preferenze.
 * Da eseguire a fine sessione, dopo aver fermato la raccolta: aprire le preferenze non deve alterare i dati.
 */
export async function analyzeBanner(page: Page, adapters: CmpAdapter[], shot: (label: string) => Promise<void>): Promise<BannerAnalysis> {
  const { banner, candidates } = await scan(page);
  const firstLayer = classify(candidates);
  const policy = candidates.find((c) => c.href && POLICY_TEXT.test(c.text));

  // Modo per riaprire le preferenze nella pagina, fuori dal banner (gli elementi del banner sono marcati dallo scan).
  let revoke: BannerAnalysis['revokeLink'] = null;
  for (const f of frames(page)) {
    const found = await f
      .evaluate(
        ({ selectors, source }) => {
          const re = new RegExp(source, 'i');
          const inBanner = (el: Element) => !!el.closest('[data-scookie-c]') || el.hasAttribute('data-scookie-c');
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && !inBanner(el)) return { text: ((el as HTMLElement).innerText || el.getAttribute('aria-label') || sel).trim().slice(0, 80), how: `elemento ${sel}` };
          }
          for (const el of Array.from(document.querySelectorAll('a, button, [role="button"]'))) {
            const t = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            if (t && t.length < 80 && re.test(t) && !inBanner(el)) return { text: t, how: 'testo del link' };
          }
          return null;
        },
        { selectors: REVOKE_SELECTORS, source: REVOKE_TEXT.source },
      )
      .catch(() => null);
    if (found) {
      revoke = found;
      break;
    }
  }

  // Secondo livello: si apre "Preferenze/Personalizza" e si leggono gli interruttori delle categorie, senza salvare.
  let preferences: BannerAnalysis['preferences'] = null;
  const prefsButton = candidates.find((c) => TEXTS.preferences.test(c.text));
  if (banner && prefsButton) {
    try {
      const opened = await clickCandidate(prefsButton);
      await page.waitForTimeout(1500);
      let toggles: { label: string; checked: boolean; disabled: boolean }[] = [];
      await waitFor(
        async () => {
          toggles = [];
          for (const f of frames(page)) toggles.push(...(await readToggles(f).catch(() => [])));
          return toggles.length > 0;
        },
        4000,
        500,
      );
      await shot('4-preferenze');
      preferences = { opened: true, via: opened, toggles };
    } catch (e) {
      preferences = { opened: false, via: (e as Error).message.split('\n')[0], toggles: [] };
    }
  }

  return {
    bannerVisible: banner,
    cmp: adapters.filter((a) => a.id !== 'tcf').map((a) => a.name),
    firstLayer,
    policyLink: policy ? { text: policy.text, href: policy.href ?? '' } : null,
    revokeLink: revoke,
    preferences,
  };
}

/** Interruttori e caselle delle categorie visibili (anche in shadow DOM), con etichetta, stato e blocco. */
async function readToggles(frame: import('playwright').Frame) {
  return frame.evaluate(() => {
    const all: Element[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of Array.from(root.querySelectorAll('input[type="checkbox"], [role="switch"], [role="checkbox"]'))) all.push(el);
      for (const el of Array.from(root.querySelectorAll('*'))) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    const visible = (el: Element) => {
      // Le caselle "vere" sono spesso nascoste dietro un interruttore grafico: si guarda anche il contenitore.
      const target = (el as HTMLInputElement).labels?.[0] ?? el.parentElement ?? el;
      const r = target.getBoundingClientRect();
      const s = getComputedStyle(target);
      return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const labelOf = (el: Element): string => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        if (t) return t;
      }
      const lab = (el as HTMLInputElement).labels?.[0]?.textContent?.trim();
      if (lab) return lab;
      // testo del contenitore più vicino che abbia un titolo
      let p: Element | null = el.parentElement;
      for (let i = 0; p && i < 4; i++, p = p.parentElement) {
        const h = p.querySelector('h3, h4, h5, strong, [class*="title"], [class*="name"]');
        if (h?.textContent?.trim()) return h.textContent.trim();
      }
      return '(senza etichetta)';
    };
    return all.filter(visible).map((el) => {
      const input = el as HTMLInputElement;
      const checked = input.type === 'checkbox' ? input.checked : el.getAttribute('aria-checked') === 'true';
      const disabled = input.disabled || el.getAttribute('aria-disabled') === 'true';
      return { label: labelOf(el).replace(/\s+/g, ' ').slice(0, 80), checked, disabled };
    });
  });
}
