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
export async function readPolicyDeclared(browser: Browser, url: string, userAgent: string, locale: string): Promise<DeclaredItem[]> {
  const ctx = await browser.newContext({ userAgent, locale });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    // Le dichiarazioni dei CMP (Cookiebot, OneTrust…) sono generate da script dopo il caricamento.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const rows = await page.evaluate(() => {
      const out: { name: string; category: string; domain: string }[] = [];
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
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length < 2) continue;
        const head = Array.from(rows[0].querySelectorAll('th,td')).map((c) => norm(c.textContent).toLowerCase());
        const iName = head.findIndex((h) => /^(nome|name|cookie|nome del cookie|cookie name|denominazione)$/.test(h) || /^nome\b/.test(h));
        if (iName < 0) continue;
        const iCat = head.findIndex((h) => /(categoria|category|tipologia|tipo di cookie|finalit|purpose|scopo)/.test(h));
        const iDom = head.findIndex((h) => /(dominio|domain|host|fornitore|provider|terza parte)/.test(h));
        const section = headingBefore(table);
        for (const r of rows.slice(1)) {
          const cells = Array.from(r.querySelectorAll('th,td')).map((c) => norm(c.textContent));
          const name = cells[iName];
          if (!name || name.length > 80) continue;
          out.push({ name, category: (iCat >= 0 ? cells[iCat] : '') || section, domain: iDom >= 0 ? (cells[iDom] ?? '') : '' });
        }
      }
      return out;
    });
    return (rows as RawRow[]).map(
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
  } finally {
    await closeSafely(ctx, 15000);
  }
}
