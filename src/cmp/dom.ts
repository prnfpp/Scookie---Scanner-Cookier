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

/**
 * Descrizione leggibile di un elemento, da riportare nel report così com'è:
 * es. pulsante "Rifiuta tutti", link "Continua senza accettare", X di chiusura (etichetta "Chiudi").
 */
export async function describeElement(el: Locator): Promise<string> {
  const info = await el
    .evaluate((n) => {
      const e = n as HTMLElement;
      const text = (e.innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        tag: e.tagName.toLowerCase(),
        role: e.getAttribute('role') ?? '',
        text: text || (e as HTMLInputElement).value || '',
        aria: e.getAttribute('aria-label') ?? e.getAttribute('title') ?? '',
        cls: typeof e.className === 'string' ? e.className : '',
        id: e.id,
      };
    })
    .catch(() => null);
  if (!info) return 'elemento non più presente nella pagina';
  const quoted = (t: string) => `"${t.length > 80 ? `${t.slice(0, 80)}…` : t}"`;
  const isClose = /^(×|✕|✖|x)?$/i.test(info.text) && (/(close|chiud|dismiss)/i.test(`${info.aria} ${info.cls} ${info.id}`) || /^(×|✕|✖|x)$/i.test(info.text));
  if (isClose) return `X di chiusura${info.aria ? ` (etichetta ${quoted(info.aria)})` : ' (senza etichetta)'}`;
  const kind = info.tag === 'a' || info.role === 'link' ? 'link' : 'pulsante';
  if (info.text) return `${kind} ${quoted(info.text)}`;
  return info.aria ? `${kind} senza testo, con etichetta ${quoted(info.aria)}` : `${kind} senza testo né etichetta`;
}

export interface ClickedElement {
  selector: string;
  /** Descrizione dell'elemento cliccato (testo visibile, tipo). */
  label: string;
}

/** Clicca il primo elemento visibile tra i selettori; ritorna selettore e descrizione dell'elemento. */
export async function clickFirst(page: Page, selectors: string[]): Promise<ClickedElement | null> {
  for (const s of selectors) {
    const el = await findVisible(page, s);
    if (el) {
      const label = await describeElement(el);
      try {
        await el.click({ timeout: 5000 });
      } catch {
        // elementi coperti da overlay: il click forzato riproduce comunque l'azione dell'utente sul pulsante
        await el.click({ timeout: 5000, force: true });
      }
      return { selector: s, label };
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
