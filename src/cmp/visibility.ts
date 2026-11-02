import type { Locator, Page } from 'playwright';
import { frames } from './dom.js';

/**
 * Visibilità reale di un elemento, non la sola presenza nel DOM: molti gestori del consenso, dopo la scelta,
 * lasciano il banner nella pagina e lo tolgono di vista con una classe (opacità 0, spostato fuori dallo schermo,
 * aria-hidden). Un elemento è visibile se ha un'area, è almeno in parte dentro la finestra, non è trasparente
 * e né lui né un suo antenato (anche attraverso lo shadow DOM) è nascosto.
 * Funzione autosufficiente: viene eseguita nella pagina.
 */
export function shownInPage(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
  let opacity = 1;
  for (let n: Element | null = el; n; ) {
    const s = getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    if (n.getAttribute('aria-hidden') === 'true') return false;
    opacity *= Number(s.opacity);
    if (opacity <= 0.05) return false;
    n = n.parentElement ?? (((n.getRootNode() as ShadowRoot).host as Element | undefined) || null);
  }
  return true;
}

/** Elemento visibile secondo Playwright e secondo il controllo geometrico e di stile di `shownInPage`. */
export async function isShown(loc: Locator): Promise<boolean> {
  if (!(await loc.isVisible().catch(() => false))) return false;
  return loc.evaluate(shownInPage).catch(() => false);
}

/** Primo elemento davvero visibile per uno dei selettori, cercato in tutti i frame. */
export async function anyShown(page: Page, selectors: string[]): Promise<boolean> {
  for (const s of selectors) {
    for (const f of frames(page)) {
      try {
        const loc = f.locator(s);
        const n = Math.min(await loc.count(), 10);
        for (let i = 0; i < n; i++) if (await isShown(loc.nth(i))) return true;
      } catch {
        // frame staccato o selettore non valido in quel contesto
      }
    }
  }
  return false;
}
