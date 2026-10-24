import type { Frame, Page } from 'playwright';
import type { ChoiceLayer } from '../types.js';
import { frames, waitFor } from './dom.js';
import type { Choice, ChoiceResult } from './types.js';

// Testi dei pulsanti (italiano e inglese). Il confronto avviene sul testo intero, normalizzato.
export const TEXTS = {
  reject:
    /^(rifiut[ao]( tutt[ioe])?( i cookie)?|rifiuto|nega( tutt[ioe])?|non accetto|non acconsento|solo (i )?(cookie )?(necessari|tecnici|essenziali)|accetta solo (i )?(cookie )?(necessari|tecnici|essenziali)|usa solo (i )?(cookie )?(necessari|tecnici)|continua senza accettare|prosegui senza accettare|reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|refuse( all)?|only (necessary|essential)( cookies)?|(use )?necessary( cookies)? only|continue without accepting)$/i,
  accept:
    /^(accett[ao]( tutt[ioe])?( i cookie)?( e chiudi| e continua| e prosegui)?|acconsento|consenti( tutt[ioe])?|ok|va bene|ho capito|accept( all)?( cookies)?|allow( all)?( cookies)?|agree( and close)?|i agree|got it)$/i,
  preferences:
    /(personalizza|impostazion|preferenz|gestisci|gestione|maggiori opzioni|altre opzioni|scopri di più|customi[sz]e|settings|manage|more options|options)/i,
  preferencesReject: /^(rifiut[ao]( tutt[ioe])?|nega( tutt[ioe])?|reject( all)?|deny( all)?|decline( all)?)$/i,
  preferencesSave:
    /^(salva( e chiudi| e esci)?( le)?( mie)?( preferenze| scelte| impostazioni| selezion[ei])?|conferma( le)?( mie)?( scelte| selezion[ei]| preferenze)?|save( and close| and exit)?( my)?( preferences| settings| choices)?|confirm( my)?( choices| selection)?)$/i,
  close: /^(×|✕|✖|x|chiudi|close|dismiss)$/i,
};

export interface Candidate {
  index: number;
  text: string;
  frame: Frame;
}

const SCAN_ATTR = 'data-scookie-c';

/**
 * Cerca i banner visibili nella pagina (anche dentro iframe e shadow DOM) e i loro elementi cliccabili.
 * Gli elementi trovati vengono marcati con un attributo data-* per poterli cliccare;
 * l'attributo non altera il comportamento della pagina.
 */
async function scanFrame(frame: Frame, isMain: boolean): Promise<{ banner: boolean; candidates: Candidate[] }> {
  try {
    const res = await frame.evaluate(
      ({ attr, isMain }) => {
        const all: Element[] = [];
        const walk = (root: Document | ShadowRoot) => {
          for (const el of Array.from(root.querySelectorAll('*'))) {
            all.push(el);
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(document);
        // I marcatori di una scansione precedente renderebbero ambigui gli indici.
        for (const el of all) el.removeAttribute(attr);
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
        };
        const kw = /cookie|consenso|consent|tracciament|privacy/i;
        const textOf = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
        let banners = all.filter((el) => {
          const s = getComputedStyle(el);
          const overlay =
            s.position === 'fixed' || s.position === 'sticky' || el.getAttribute('role') === 'dialog' ||
            el.getAttribute('aria-modal') === 'true' || el.tagName === 'DIALOG';
          if (!overlay || !visible(el)) return false;
          const t = textOf(el);
          return t.length < 5000 && kw.test(t);
        });
        // In un iframe dedicato al consenso il banner è l'intero documento.
        if (!banners.length && !isMain && document.body && kw.test(textOf(document.body)) && visible(document.body)) banners = [document.body];
        const out: { index: number; text: string }[] = [];
        let i = 0;
        const seen = new Set<Element>();
        for (const b of banners) {
          const inner: Element[] = [];
          const collect = (root: Element | ShadowRoot) => {
            for (const el of Array.from(root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))) inner.push(el);
            for (const el of Array.from(root.querySelectorAll('*'))) if (el.shadowRoot) collect(el.shadowRoot);
          };
          collect(b);
          if (b.shadowRoot) collect(b.shadowRoot);
          for (const el of inner) {
            if (seen.has(el) || !visible(el)) continue;
            seen.add(el);
            const raw = textOf(el) || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('title') || '';
            const text = raw.replace(/\s+/g, ' ').replace(/[›»→>]+$/, '').trim();
            if (!text || text.length > 80) continue;
            el.setAttribute(attr, String(i));
            out.push({ index: i++, text });
            const aria = el.getAttribute('aria-label');
            if (aria && aria.trim() !== text) out.push({ index: i - 1, text: aria.trim() });
          }
        }
        return { banner: banners.length > 0, candidates: out };
      },
      { attr: SCAN_ATTR, isMain },
    );
    return { banner: res.banner, candidates: res.candidates.map((c) => ({ ...c, frame })) };
  } catch {
    return { banner: false, candidates: [] };
  }
}

export async function scan(page: Page): Promise<{ banner: boolean; candidates: Candidate[] }> {
  const main = page.mainFrame();
  let banner = false;
  const candidates: Candidate[] = [];
  for (const f of frames(page)) {
    const r = await scanFrame(f, f === main);
    banner ||= r.banner;
    candidates.push(...r.candidates);
  }
  return { banner, candidates };
}

export async function heuristicBannerVisible(page: Page): Promise<boolean> {
  return (await scan(page)).banner;
}

async function clickCandidate(c: Candidate): Promise<void> {
  const loc = c.frame.locator(`[${SCAN_ATTR}="${c.index}"]`).first();
  try {
    await loc.click({ timeout: 5000 });
  } catch {
    await loc.click({ timeout: 5000, force: true });
  }
}

function pick(candidates: Candidate[], re: RegExp): Candidate | undefined {
  return candidates.find((c) => re.test(c.text));
}

const done = (layer: ChoiceLayer, detail: string): ChoiceResult => ({ ok: true, layer, via: 'click', detail });

export async function heuristicChoose(page: Page, choice: Choice): Promise<ChoiceResult> {
  const { banner, candidates } = await scan(page);
  if (!banner) return { ok: false, layer: null, via: null, detail: 'nessun banner riconosciuto (elemento sovrapposto con testo su cookie/consenso)' };
  const list = candidates.map((c) => `"${c.text}"`).join(', ');

  if (choice === 'accetta') {
    const c = pick(candidates, TEXTS.accept);
    if (!c) return { ok: false, layer: null, via: null, detail: `pulsante "Accetta" non trovato; pulsanti nel banner: ${list || 'nessuno'}` };
    await clickCandidate(c);
    return done('primo-livello', `click sul pulsante "${c.text}"`);
  }

  const reject = pick(candidates, TEXTS.reject);
  if (reject) {
    await clickCandidate(reject);
    return done('primo-livello', `click sul pulsante "${reject.text}"`);
  }
  const close = pick(candidates, TEXTS.close);
  if (close) {
    await clickCandidate(close);
    return done('chiusura-x', `click sul pulsante di chiusura "${close.text}"`);
  }
  const prefs = pick(candidates, TEXTS.preferences);
  if (prefs) {
    await clickCandidate(prefs);
    let second: Candidate | undefined;
    await waitFor(
      async () => {
        const again = (await scan(page)).candidates;
        second = pick(again, TEXTS.preferencesReject) ?? pick(again, TEXTS.preferencesSave);
        return !!second;
      },
      5000,
      500,
    );
    if (second) {
      await clickCandidate(second);
      return done('secondo-livello', `click su "${prefs.text}" e poi su "${second.text}"`);
    }
    return { ok: false, layer: null, via: null, detail: `aperte le preferenze con "${prefs.text}" ma nessun pulsante di rifiuto o salvataggio trovato` };
  }
  return { ok: false, layer: null, via: null, detail: `pulsante "Rifiuta" non trovato; pulsanti nel banner: ${list || 'nessuno'}` };
}
