import type { Browser } from 'playwright';
import { normalizeDeclaredCategory } from '../classify/classifier.js';
import type { DeclaredItem } from '../types.js';
import { closeSafely } from '../util/misc.js';

interface RawRow {
  name: string;
  category: string;
  domain: string;
}

/**
 * Legge l'elenco dei cookie dichiarati dalle tabelle della pagina di cookie policy.
 * Riconosce la colonna del nome (nome, cookie, name) e quella della categoria (categoria, tipologia, finalità…);
 * se manca, usa il titolo della sezione che precede la tabella (es. le dichiarazioni generate dai CMP).
 */
/** Un "nome" che è in realtà una durata: segno di colonne slittate (celle unite) o di una riga descrittiva. */
const DURATION = /^(sessione|session|persistent[ei]?|\d+\s*(anni|anno|mesi|mese|settimane|settimana|giorni|giorno|ore|ora|minuti|minuto|secondi|years?|months?|days?|hours?|minutes?))$/i;

export async function readPolicyDeclared(
  browser: Browser,
  url: string,
  userAgent: string,
  locale: string,
): Promise<{ items: DeclaredItem[]; skipped: string[]; text?: { full: string; section: { title: string; text: string } | null } }> {
  const ctx = await browser.newContext({ userAgent, locale });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    // Le dichiarazioni dei CMP (Cookiebot, OneTrust…) sono generate da script dopo il caricamento.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const { out: rows, skipped } = await page.evaluate((durationSrc) => {
      const DURATION_SRC = new RegExp(durationSrc, 'i');
      const out: { name: string; category: string; domain: string }[] = [];
      const skipped: string[] = [];
      const norm = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
      const headingBefore = (el: Element): string => {
        let n: Element | null = el;
        for (let depth = 0; n && depth < 6; depth++, n = n.parentElement) {
          let p = n.previousElementSibling;
          for (let k = 0; p && k < 6; k++, p = p.previousElementSibling) {
            const h = p.matches('h1,h2,h3,h4,h5,strong,b,[role="heading"]') ? p : p.querySelector('h1,h2,h3,h4,h5,[role="heading"]');
            if (h && norm(h.textContent)) return norm(h.textContent).slice(0, 80);
          }
        }
        return '';
      };
      for (const table of Array.from(document.querySelectorAll('table'))) {
        // Griglia con le celle unite (rowspan/colspan) ripetute: senza, le righe successive a una cella unita
        // hanno meno celle e le colonne slittano (la durata finisce nel nome, la descrizione nella categoria).
        const grid: string[][] = [];
        Array.from(table.rows).forEach((r, ri) => {
          grid[ri] ??= [];
          let ci = 0;
          for (const c of Array.from(r.cells)) {
            while (grid[ri][ci] !== undefined) ci++;
            const text = norm(c.textContent);
            for (let dr = 0; dr < Math.max(1, c.rowSpan || 1); dr++) for (let dc = 0; dc < Math.max(1, c.colSpan || 1); dc++) (grid[ri + dr] ??= [])[ci + dc] = text;
            ci += Math.max(1, c.colSpan || 1);
          }
        });
        if (grid.length < 2) continue;
        const head = grid[0].map((c) => (c ?? '').toLowerCase());
        const iName = head.findIndex((h) => /^(nome|name|cookie|nome del cookie|cookie name|denominazione)$/.test(h) || /^nome\b/.test(h));
        if (iName < 0) continue;
        // una colonna "Categoria" vale più di una colonna con la finalità descritta ("Scopo", "Finalità")
        const iCatStrict = head.findIndex((h) => /(categoria|category|tipologia|tipo di cookie)/.test(h));
        const iCat = iCatStrict >= 0 ? iCatStrict : head.findIndex((h) => /(finalit|purpose|scopo)/.test(h));
        const iDom = head.findIndex((h) => /(dominio|domain|host|fornitore|provider|terza parte)/.test(h));
        const section = headingBefore(table);
        for (const cells of grid.slice(1)) {
          const name = cells[iName] ?? '';
          if (!name) continue;
          // un nome con spazi lunghi, una durata o una frase non è il nome di un cookie: riga non letta, segnalata
          if (name.length > 80 || DURATION_SRC.test(name) || name.split(' ').length > 4) {
            skipped.push(name.slice(0, 40));
            continue;
          }
          const cat = iCat >= 0 ? (cells[iCat] ?? '') : '';
          // una "categoria" lunga è una descrizione della finalità: vale il titolo della sezione
          out.push({ name, category: (cat && cat.length <= 60 ? cat : '') || section || cat, domain: iDom >= 0 ? (cells[iDom] ?? '') : '' });
        }
      }
      return { out, skipped };
    }, DURATION.source);
    // Testo della pagina e sezione sui cookie (titolo con "cookie" e ciò che segue fino al titolo successivo dello
    // stesso livello): serve alla dichiarazione testuale quando non ci sono tabelle leggibili
    const text = await page
      .evaluate(() => {
        const norm = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
        const full = (document.body?.innerText ?? '').slice(0, 300000);
        const level = (el: Element) => (/^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : 7);
        const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter((h) => /cookie/i.test(h.textContent ?? '') && norm(h.textContent).length < 150);
        for (const h of heads) {
          const parts: string[] = [];
          for (let n = h.nextElementSibling; n; n = n.nextElementSibling) {
            if (/^H[1-6]$/.test(n.tagName) && level(n) <= level(h)) break;
            parts.push(norm((n as HTMLElement).innerText ?? n.textContent));
          }
          const t = parts.filter(Boolean).join('\n');
          if (t.length > 20) return { full, section: { title: norm(h.textContent), text: t.slice(0, 50000) } };
        }
        // senza un titolo sui cookie: i paragrafi che ne parlano
        const ps = Array.from(document.querySelectorAll('p, li')).map((p) => norm(p.textContent)).filter((t) => /cookie/i.test(t));
        return { full, section: ps.length ? { title: '', text: ps.join('\n').slice(0, 50000) } : null };
      })
      .catch(() => undefined);
    // con le celle unite lo stesso cookie può comparire su più righe (una per finalità o durata)
    const unique = [...new Map((rows as RawRow[]).map((r) => [`${r.name}|${r.category}`, r])).values()];
    const items = unique.map(
      (r): DeclaredItem => ({
        kind: 'cookie',
        name: r.name,
        domain: /^[\w.-]+\.[a-z]{2,}$/i.test(r.domain) ? r.domain : undefined,
        declaredCategory: r.category,
        category: normalizeDeclaredCategory(r.category),
        alwaysActive: normalizeDeclaredCategory(r.category) === 'tecnico',
        source: `cookie policy (${url})`,
      }),
    );
    return { items, skipped, ...(text ? { text } : {}) };
  } finally {
    await closeSafely(ctx, 15000);
  }
}
