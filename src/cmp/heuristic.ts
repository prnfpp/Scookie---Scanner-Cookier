import type { Frame, Page } from 'playwright';
import type { ChoiceLayer } from '../types.js';
import { CMP_CONTAINERS, CMP_FRAME_URL } from './containers.js';
import { describeElement, frames, waitFor } from './dom.js';
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
  // anche le etichette per l'accessibilità, es. "Dismiss cookie banner", "Chiudi il banner dei cookie"
  close: /^(×|✕|✖|✗|x|chiudi|close|dismiss)$|^(chiudi|close|dismiss)\b.{0,40}\b(banner|cookies?|avviso|messaggio|finestra|dialog(o|ue)?|popup|notice)$/i,
};

export interface Candidate {
  index: number;
  text: string;
  /** Indirizzo, se l'elemento è un link. */
  href?: string | null;
  frame: Frame;
}

const SCAN_ATTR = 'data-scookie-c';

/**
 * Ruolo di un frame per l'analisi del banner:
 * - main: la pagina;
 * - cmp: iframe del gestore del consenso (indirizzo di un CMP noto, oppure iframe sovrapposto alla pagina come un
 *   banner): il documento intero è interfaccia di consenso;
 * - other: contenuto del sito incorporato in linea (video, mappe, calendari). Non fa parte del banner: vi si cerca
 *   un banner solo se il documento del frame ne contiene uno sovrapposto.
 */
export type FrameRole = 'main' | 'cmp' | 'other';

export async function frameRole(frame: Frame): Promise<FrameRole> {
  if (frame === frame.page().mainFrame()) return 'main';
  let path = frame.url();
  try {
    const u = new URL(path);
    path = u.hostname + u.pathname;
  } catch {
    // about:blank, srcdoc
  }
  if (CMP_FRAME_URL.test(path)) return 'cmp';
  const el = await frame.frameElement().catch(() => null);
  if (!el) return 'other';
  const overlay = await el
    .evaluate((e) => {
      for (let n: Element | null = e as Element; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.position === 'fixed' || s.position === 'sticky' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true' || n.tagName === 'DIALOG') return true;
      }
      return false;
    })
    .catch(() => false);
  await el.dispose().catch(() => {});
  return overlay ? 'cmp' : 'other';
}

/**
 * Cerca i banner visibili nella pagina (anche dentro iframe e shadow DOM) e i loro elementi cliccabili.
 * Se è visibile il contenitore di un gestore noto, il banner è quel contenitore e nient'altro; altrimenti sono gli
 * elementi sovrapposti alla pagina con un testo sul consenso. Gli elementi trovati vengono marcati con un attributo
 * data-* per poterli cliccare; l'attributo non altera il comportamento della pagina.
 */
async function scanFrame(frame: Frame, role: FrameRole): Promise<{ banner: boolean; candidates: Candidate[] }> {
  try {
    const res = await frame.evaluate(
      ({ attr, wholeDocument, known }) => {
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
        // Contenitori dei gestori noti visibili: solo i più esterni
        const knownShown = known.flatMap((sel) => Array.from(document.querySelectorAll(sel))).filter(visible);
        let banners = knownShown.filter((el) => !knownShown.some((o) => o !== el && o.contains(el)));
        if (!banners.length) {
          banners = all.filter((el) => {
            const s = getComputedStyle(el);
            const overlay =
              s.position === 'fixed' || s.position === 'sticky' || el.getAttribute('role') === 'dialog' ||
              el.getAttribute('aria-modal') === 'true' || el.tagName === 'DIALOG';
            if (!overlay || !visible(el)) return false;
            // un singolo pulsante fluttuante (es. "Gestisci consenso" dopo la scelta) non è un banner
            if (el.matches('button, a, [role="button"], input')) return false;
            const t = textOf(el);
            return t.length < 5000 && kw.test(t);
          });
        }
        // In un iframe dedicato al consenso il banner è l'intero documento.
        if (!banners.length && wholeDocument && document.body && kw.test(textOf(document.body)) && visible(document.body)) banners = [document.body];
        const out: { index: number; text: string; href: string | null }[] = [];
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
            const href = el.tagName === 'A' ? (el as HTMLAnchorElement).href || null : null;
            out.push({ index: i++, text, href });
            const aria = el.getAttribute('aria-label');
            if (aria && aria.trim() !== text) out.push({ index: i - 1, text: aria.trim(), href });
          }
        }
        return { banner: banners.length > 0, candidates: out };
      },
      { attr: SCAN_ATTR, wholeDocument: role === 'cmp', known: CMP_CONTAINERS },
    );
    return { banner: res.banner, candidates: res.candidates.map((c) => ({ ...c, frame })) };
  } catch {
    return { banner: false, candidates: [] };
  }
}

export async function scan(page: Page): Promise<{ banner: boolean; candidates: Candidate[] }> {
  let banner = false;
  const candidates: Candidate[] = [];
  for (const f of frames(page)) {
    const r = await scanFrame(f, await frameRole(f).catch(() => 'other' as const));
    banner ||= r.banner;
    candidates.push(...r.candidates);
  }
  return { banner, candidates };
}

/**
 * Frame da cui leggere gli interruttori delle categorie: la pagina (solo dentro l'interfaccia di consenso), gli
 * iframe del gestore (per intero) e gli altri iframe solo se contengono il banner trovato dalla scansione.
 */
export async function consentFrames(page: Page, candidates?: Candidate[]): Promise<{ frame: Frame; scoped: boolean }[]> {
  const out: { frame: Frame; scoped: boolean }[] = [];
  for (const f of frames(page)) {
    const role = await frameRole(f).catch(() => 'other' as const);
    if (role === 'main') out.push({ frame: f, scoped: true });
    else if (role === 'cmp') out.push({ frame: f, scoped: false });
    else if (candidates?.some((c) => c.frame === f)) out.push({ frame: f, scoped: true });
  }
  return out;
}

export async function heuristicBannerVisible(page: Page): Promise<boolean> {
  return (await scan(page)).banner;
}

/** Clicca un candidato e ritorna la descrizione dell'elemento cliccato. */
export async function clickCandidate(c: Candidate): Promise<string> {
  const loc = c.frame.locator(`[${SCAN_ATTR}="${c.index}"]`).first();
  const label = await describeElement(loc);
  try {
    await loc.click({ timeout: 5000 });
  } catch {
    await loc.click({ timeout: 5000, force: true });
  }
  return label;
}

function pick(candidates: Candidate[], re: RegExp): Candidate | undefined {
  return candidates.find((c) => re.test(c.text));
}

const done = (layer: ChoiceLayer, ...labels: string[]): ChoiceResult => ({
  ok: true,
  layer,
  via: 'click',
  detail: `click su ${labels.join(', poi su ')}`,
  clicked: labels,
});

export async function heuristicChoose(page: Page, choice: Choice): Promise<ChoiceResult> {
  const { banner, candidates } = await scan(page);
  if (!banner) return { ok: false, layer: null, via: null, detail: 'nessun banner riconosciuto (elemento sovrapposto con testo su cookie/consenso)' };
  const list = candidates.map((c) => `"${c.text}"`).join(', ');

  if (choice === 'accetta') {
    const c = pick(candidates, TEXTS.accept);
    if (!c) return { ok: false, layer: null, via: null, detail: `pulsante "Accetta" non trovato; pulsanti nel banner: ${list || 'nessuno'}` };
    return done('primo-livello', await clickCandidate(c));
  }

  const reject = pick(candidates, TEXTS.reject);
  if (reject) {
    return done('primo-livello', await clickCandidate(reject));
  }
  const close = pick(candidates, TEXTS.close);
  if (close) {
    return done('chiusura-x', await clickCandidate(close));
  }
  const prefs = pick(candidates, TEXTS.preferences);
  if (prefs) {
    const first = await clickCandidate(prefs);
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
      return done('secondo-livello', first, await clickCandidate(second));
    }
    return { ok: false, layer: null, via: null, detail: `aperte le preferenze con "${prefs.text}" ma nessun pulsante di rifiuto o salvataggio trovato` };
  }
  return { ok: false, layer: null, via: null, detail: `pulsante "Rifiuta" non trovato; pulsanti nel banner: ${list || 'nessuno'}` };
}
