import type { Locator, Page } from 'playwright';
import type { BannerConfig } from '../config/schema.js';
import { describeElement, findVisible, waitFor } from './dom.js';
import type { Choice, ChoiceResult } from './types.js';

async function locate(page: Page, banner: BannerConfig, selector: string): Promise<Locator | null> {
  if (banner.frame) {
    const loc = page.frameLocator(banner.frame).locator(selector).first();
    return (await loc.isVisible().catch(() => false)) ? loc : null;
  }
  return findVisible(page, selector);
}

export function hasManual(banner: BannerConfig | undefined, choice: Choice): banner is BannerConfig {
  if (!banner) return false;
  return choice === 'accetta' ? !!banner.accetta : !!(banner.rifiuta || (banner.preferenze && banner.rifiutaNellePreferenze));
}

export async function manualBannerVisible(page: Page, banner: BannerConfig): Promise<boolean> {
  const sel = banner.contenitore ?? banner.rifiuta ?? banner.accetta;
  return sel ? !!(await locate(page, banner, sel)) : false;
}

/** Scelta con i selettori indicati nella configurazione del sito. */
export async function manualChoose(page: Page, banner: BannerConfig, choice: Choice): Promise<ChoiceResult> {
  const clicked: string[] = [];
  const click = async (sel: string) => {
    const el = await locate(page, banner, sel);
    if (!el) return false;
    clicked.push(`${await describeElement(el)} (${sel})`);
    await el.click({ timeout: 5000 }).catch(() => el.click({ timeout: 5000, force: true }));
    return true;
  };
  if (choice === 'accetta') {
    return (await click(banner.accetta!))
      ? { ok: true, layer: 'primo-livello', via: 'click', detail: `click su ${clicked.join(', poi su ')} (selettore da configurazione)`, clicked }
      : { ok: false, layer: null, via: null, detail: `selettore "accetta" non trovato: ${banner.accetta}` };
  }
  if (banner.rifiuta && (await click(banner.rifiuta))) {
    return { ok: true, layer: 'primo-livello', via: 'click', detail: `click su ${clicked.join(', poi su ')} (selettore da configurazione)`, clicked };
  }
  if (banner.preferenze && banner.rifiutaNellePreferenze && (await click(banner.preferenze))) {
    const ok = await waitFor(() => click(banner.rifiutaNellePreferenze!), 5000, 400);
    if (ok) {
      return {
        ok: true,
        layer: 'secondo-livello',
        via: 'click',
        detail: `click su ${clicked.join(', poi su ')} (selettori da configurazione)`,
        clicked,
      };
    }
  }
  return { ok: false, layer: null, via: null, detail: 'selettori di rifiuto della configurazione non trovati' };
}
