import type { Frame, Locator, Page } from 'playwright';

/** Tutti i frame della pagina, principale per primo. */
export function frames(page: Page): Frame[] {
  const main = page.mainFrame();
  return [main, ...page.frames().filter((f) => f !== main && !f.isDetached())];
}

/** Primo elemento visibile per il selettore, cercato in tutti i frame (il CSS di Playwright attraversa lo shadow DOM aperto). */
export async function findVisible(page: Page, selector: string): Promise<Locator | null> {
  for (const f of frames(page)) {
    try {
      const loc = f.locator(selector);
      const n = Math.min(await loc.count(), 10);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.isVisible()) return el;
      }
    } catch {
      // frame staccato o selettore non valido in quel contesto
    }
  }
  return null;
}

export async function anyVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const s of selectors) if (await findVisible(page, s)) return true;
  return false;
}

/** Clicca il primo elemento visibile tra i selettori; ritorna il selettore usato. */
export async function clickFirst(page: Page, selectors: string[]): Promise<string | null> {
  for (const s of selectors) {
    const el = await findVisible(page, s);
    if (el) {
      try {
        await el.click({ timeout: 5000 });
      } catch {
        // elementi coperti da overlay: il click forzato riproduce comunque l'azione dell'utente sul pulsante
        await el.click({ timeout: 5000, force: true });
      }
      return s;
    }
  }
  return null;
}

/** Valuta un'espressione nella pagina principale senza propagare errori. */
export async function safeEval<T>(page: Page, fn: () => T | Promise<T>): Promise<T | null> {
  try {
    return (await page.evaluate(fn)) as T;
  } catch {
    return null;
  }
}

/** Attende che una condizione diventi vera (polling), entro un timeout. */
export async function waitFor(check: () => Promise<boolean>, timeout: number, interval = 250): Promise<boolean> {
  const end = Date.now() + timeout;
  do {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, interval));
  } while (Date.now() < end);
  return false;
}
