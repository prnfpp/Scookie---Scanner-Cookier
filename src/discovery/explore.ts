import type { Browser, Page, Response } from 'playwright';
import { detectBotChallenge } from '../browser/antibot.js';
import { closeSafely, withTimeout } from '../util/misc.js';

export interface ExploreOptions {
  userAgent: string;
  locale: string;
  /** Livelli di clic a partire dalle pagine di partenza. */
  depth: number;
  /** Clic massimi in totale. */
  maxClicks: number;
  /** Pagine visitate al massimo. */
  maxPages: number;
  /** Elementi cliccati al massimo per pagina. */
  perPage: number;
  navTimeout: number;
  /** Tempo massimo complessivo, in ms. */
  budgetMs: number;
  /** Filtro delle URL trovate (stesso host, esclusioni, robots). */
  keep: (url: string) => boolean;
  /** Indirizzi da attraversare senza aggiungerli al campione (es. altri sottodomini dello stesso dominio). */
  traverse?: (url: string) => boolean;
  normalize: (url: string) => string | null;
}

export interface ExploreResult {
  urls: string[];
  clicks: number;
  notes: string[];
}

// Elementi da non cliccare: azioni con effetti (invio di moduli, pagamenti, uscita, cancellazioni) e scelte sul banner.
const DANGER =
  /(esci|logout|log out|sign out|disconnett|elimina|cancella|rimuovi|delete|remove|paga|pagamento|acquista|compra|checkout|ordina|buy|pay|purchase|invia|send|submit|conferma|confirm|abbonati|subscribe|iscriviti|registrati|sign up|annulla|unsubscribe|rifiut|accett|acconsent|consenti|accept|reject|decline|allow|deny|cookie|chiudi|close)/i;
const CONSENT_CONTAINERS =
  '[id*="onetrust"],[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="cmp" i],[class*="iubenda"],[id*="didomi"],[id*="usercentrics"],#cc_div,#cc-main,[aria-modal="true"][aria-label*="cookie" i]';

interface Clickable {
  key: string;
  text: string;
}

/**
 * Esplorazione con clic, per i siti le cui pagine non sono raggiungibili da sitemap e link (applicazioni web):
 * visita le pagine di partenza, clicca pulsanti, schede e voci di menu dello stesso sito e registra gli indirizzi
 * che compaiono (anche quelli cambiati senza ricaricare la pagina e quelli aperti in una nuova scheda).
 * Deterministica: stesso ordine di visita e di clic a ogni esecuzione. Non compila né invia moduli.
 * Usa un contesto separato, poi chiuso: nulla di quanto avviene qui entra nei dati dell'audit.
 */
export async function exploreByClicks(browser: Browser, seeds: string[], opts: ExploreOptions): Promise<ExploreResult> {
  const started = Date.now();
  const found = new Set<string>();
  const visited = new Set<string>();
  const notes: string[] = [];
  const unreachable: string[] = [];
  let clicks = 0;
  let stopped = false;
  const outOfBudget = () => stopped || clicks >= opts.maxClicks || visited.size >= opts.maxPages || Date.now() - started > opts.budgetMs;

  const ctx = await browser.newContext({ userAgent: opts.userAgent, locale: opts.locale });
  const page = await ctx.newPage();
  // Le nuove schede aperte da un clic: si registra l'indirizzo e si chiudono.
  ctx.on('page', (p) => {
    if (p === page) return;
    p.waitForLoadState('domcontentloaded', { timeout: 10000 })
      .catch(() => {})
      .then(() => {
        record(p.url());
        return closeSafely(p, 5000);
      })
      .catch(() => {});
  });
  /**
   * Registra un indirizzo: se è nel perimetro entra tra quelli trovati. Restituisce l'indirizzo se si può visitare
   * (nel perimetro o attraversabile), altrimenti null.
   */
  const kept = new Map<string, boolean>();
  const record = (u: string) => {
    const n = opts.normalize(u);
    if (!n) return null;
    // Una sola valutazione per indirizzo (il filtro conta le esclusioni da robots.txt).
    if (!kept.has(n)) kept.set(n, opts.keep(n));
    if (kept.get(n)) {
      found.add(n);
      return n;
    }
    return opts.traverse?.(n) ? n : null;
  };

  try {
    let level = seeds.map((s) => opts.normalize(s)).filter((u): u is string => !!u);
    for (let d = 0; d <= opts.depth && level.length && !outOfBudget(); d++) {
      const next: string[] = [];
      for (const url of level) {
        if (outOfBudget()) break;
        if (visited.has(url)) continue;
        visited.add(url);
        const { error: err, response } = await load(page, url, opts.navTimeout);
        if (err) {
          unreachable.push(`${url} (${err})`);
          continue;
        }
        // Verifica anti-bot: ci si ferma, insistere peggiorerebbe il blocco (anche per l'audit che segue).
        const block = await detectBotChallenge(page, response);
        if (block) {
          notes.push(`Esplorazione fermata: verifica anti-bot ${block.provider} su ${block.url} (${block.signal})`);
          stopped = true;
          break;
        }
        const landed = record(page.url());
        // Rimandati a un altro sito (es. accesso esterno): se ne leggono i link verso il sito, ma non si clicca.
        if (!landed) {
          for (const h of await links(page)) {
            const n = record(h);
            if (n && !visited.has(n)) next.push(n);
          }
          continue;
        }
        if (landed !== url) visited.add(landed);
        for (const h of await links(page)) {
          const n = record(h);
          if (n && !visited.has(n)) next.push(n);
        }
        if (d === opts.depth) continue;
        const items = (await scan(page)).slice(0, opts.perPage);
        for (const item of items) {
          if (outOfBudget()) break;
          // Ogni clic parte dalla pagina appena caricata, così lo stato lasciato dal clic precedente non conta.
          if (opts.normalize(page.url()) !== landed && (await load(page, url, opts.navTimeout)).error) break;
          const target = (await scan(page)).find((c) => c.text === item.text);
          if (!target) continue;
          clicks++;
          const before = page.url();
          await page
            .evaluate((k) => (document.querySelector(`[data-scookie-x="${k}"]`) as HTMLElement | null)?.click(), target.key)
            .catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(1200);
          const after = page.url();
          if (after !== before) {
            const n = record(after);
            if (n && !visited.has(n)) next.push(n);
          }
          // Un menu o una scheda aperti dal clic possono mostrare nuovi link.
          for (const h of await links(page)) {
            const n = record(h);
            if (n && !visited.has(n)) next.push(n);
          }
        }
      }
      // Anche i link trovati nelle pagine di questo livello si visitano al livello successivo.
      // prima le pagine del sito in esame, poi quelle dei sottodomini da attraversare; a parità, in ordine alfabetico
      level = [...new Set([...next, ...[...found].filter((u) => !visited.has(u))])].sort(
        (a, b) => Number(!kept.get(a)) - Number(!kept.get(b)) || a.localeCompare(b),
      );
    }
  } finally {
    await closeSafely(ctx, 20000, 'chiusura contesto di esplorazione');
  }
  if (unreachable.length) notes.push(`Esplorazione: ${unreachable.length} pagine non raggiungibili, es. ${unreachable[0]}`);
  if (outOfBudget() && !stopped) notes.push(`Esplorazione fermata al limite (${clicks} clic, ${visited.size} pagine, ${Math.round((Date.now() - started) / 1000)} s)`);
  return { urls: [...found].sort(), clicks, notes };
}

/** Apre la pagina; in caso di errore ne restituisce il motivo. */
async function load(page: Page, url: string, timeout: number): Promise<{ error: string | null; response: Response | null }> {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    return { error: null, response };
  } catch (e) {
    return { error: (e as Error).message.split('\n')[0], response: null };
  }
}

async function links(page: Page): Promise<string[]> {
  return withTimeout(
    page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).href)),
    10000,
    'lettura dei link',
  ).catch(() => []);
}

/** Elementi cliccabili visibili, fuori dal banner dei cookie, senza effetti pericolosi; marcati per poterli cliccare. */
async function scan(page: Page): Promise<Clickable[]> {
  return page
    .evaluate(
      ({ danger, containers }) => {
        const re = new RegExp(danger, 'i');
        for (const old of Array.from(document.querySelectorAll('[data-scookie-x]'))) old.removeAttribute('data-scookie-x');
        const out: { key: string; text: string }[] = [];
        const seen = new Set<string>();
        const els = Array.from(
          document.querySelectorAll(
            'button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick], a:not([href]), a[href="#"], a[href^="javascript:"], summary',
          ),
        );
        let i = 0;
        for (const el of els) {
          const h = el as HTMLElement;
          if (h.closest(containers)) continue;
          if (h.closest('form') && (h.matches('[type="submit"]') || (h.tagName === 'BUTTON' && !h.getAttribute('type')))) continue;
          if ((h as HTMLButtonElement).disabled || h.getAttribute('aria-disabled') === 'true') continue;
          const r = h.getBoundingClientRect();
          const s = getComputedStyle(h);
          if (r.width < 2 || r.height < 2 || s.visibility === 'hidden' || s.display === 'none') continue;
          const text = (h.innerText || h.getAttribute('aria-label') || h.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 60 || re.test(text) || seen.has(text)) continue;
          seen.add(text);
          const key = String(i++);
          h.setAttribute('data-scookie-x', key);
          out.push({ key, text });
        }
        return out;
      },
      { danger: DANGER.source, containers: CONSENT_CONTAINERS },
    )
    .catch(() => []);
}
