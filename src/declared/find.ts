import { join } from 'node:path';
import type { Browser } from 'playwright';
import { POLICY_WORDS } from '../discovery/discover.js';
import type { PolicySearch } from '../types.js';
import { registrableDomain } from '../util/domains.js';
import { closeSafely } from '../util/misc.js';

/** Percorsi comuni delle informative (WordPress e temi diffusi), provati quando nessun link porta a una pagina valida. */
export const COMMON_POLICY_PATHS = ['/privacy-policy/', '/cookie-policy/', '/privacy/', '/informativa-privacy/', '/informativa-cookie/', '/cookie/'];

export interface PolicyCandidate {
  url: string;
  how: string;
}

/**
 * Cerca la pagina di informativa (cookie policy o privacy policy) di un sito, dopo le fonti già note (configurazione,
 * link nel banner): link nella pagina iniziale (footer e menu) con testo o indirizzo che contiene "cookie", "privacy",
 * "informativa" o "note legali" e link con rel="privacy-policy" (WordPress lo genera); poi i percorsi comuni; poi le
 * URL della sitemap con quelle parole. Ogni candidato si verifica con lo stato HTTP reale: vale solo una risposta 200
 * sullo stesso sito (alcuni temi rispondono 404 con una pagina completa, con il footer). Registra tutti i tentativi,
 * con lo stato, e fotografa il piè di pagina della pagina iniziale.
 */
export async function findPolicy(
  browser: Browser,
  o: { site: string; known: PolicyCandidate[]; sitemap: string[]; userAgent: string; locale: string; runDir: string; shotName: string },
): Promise<PolicySearch> {
  const ctx = await browser.newContext({ userAgent: o.userAgent, locale: o.locale });
  const tried: PolicySearch['tried'] = [];
  const domain = registrableDomain(new URL(o.site).hostname);
  const sameSite = (u: string) => {
    try {
      return registrableDomain(new URL(u).hostname) === domain;
    } catch {
      return false;
    }
  };
  let footerShot: string | undefined;
  try {
    // link nella pagina iniziale: footer, menu e qualsiasi altro collegamento con le parole dell'informativa
    const links: PolicyCandidate[] = [];
    try {
      const page = await ctx.newPage();
      await page.goto(o.site, { waitUntil: 'load', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      const found = await page.evaluate((src) => {
        const re = new RegExp(src, 'i');
        return Array.from(document.querySelectorAll('a[href]'))
          .map((a) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), rel: a.getAttribute('rel') ?? '', footer: !!a.closest('footer, [role="contentinfo"], #footer, .footer') }))
          .filter((l) => /^https?:/.test(l.href) && (/\bprivacy-policy\b/.test(l.rel) || re.test(l.text) || re.test(new URL(l.href).pathname)));
      }, POLICY_WORDS.source);
      // prima i collegamenti sulla cookie policy, poi rel="privacy-policy", poi gli altri
      const rank = (l: (typeof found)[number]) => (/cookie/i.test(l.text + l.href) ? 0 : /\bprivacy-policy\b/.test(l.rel) ? 1 : 2);
      for (const l of found.sort((a, b) => rank(a) - rank(b))) {
        const how = /\bprivacy-policy\b/.test(l.rel) ? 'link con rel="privacy-policy"' : `link "${l.text || l.href}"${l.footer ? ' nel piè di pagina' : ' nella pagina'}`;
        if (!links.some((x) => x.url === l.href.split('#')[0])) links.push({ url: l.href.split('#')[0], how });
      }
      // piè di pagina fotografato: prova di cosa c'è (o non c'è) in fondo alla pagina
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(300);
      const rel = `evidenze/${o.shotName}_pie-di-pagina.png`;
      await page.screenshot({ path: join(o.runDir, rel), timeout: 15000 }).then(() => (footerShot = rel)).catch(() => {});
    } catch {
      // pagina iniziale non caricata: restano gli altri candidati
    }
    const candidates: PolicyCandidate[] = [
      ...o.known,
      ...links,
      ...COMMON_POLICY_PATHS.map((p) => ({ url: new URL(p, o.site).toString(), how: 'percorso comune' })),
      ...o.sitemap.map((u) => ({ url: u, how: 'URL della sitemap o dei link del sito' })),
    ];
    const seen = new Set<string>();
    // stato reale letto dal browser (stesse regole di rete delle sessioni), senza eseguire la pagina oltre il necessario
    const probe = await ctx.newPage();
    for (const c of candidates) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      if (!sameSite(c.url)) {
        tried.push({ url: c.url, how: c.how, status: null, note: 'su un altro sito: non usata' });
        continue;
      }
      const res = await probe.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: Error) => e);
      if (res instanceof Error || !res) {
        tried.push({ url: c.url, how: c.how, status: null, note: res ? res.message.split('\n')[0].slice(0, 120) : 'nessuna risposta' });
        continue;
      }
      const final = probe.url();
      tried.push({ url: c.url, how: c.how, status: res.status(), ...(final !== c.url ? { note: `reindirizzata a ${final}` } : {}) });
      if (res.status() === 200 && sameSite(final) && /html/i.test(res.headers()['content-type'] ?? 'text/html')) {
        return { url: final, how: c.how, tried, ...(footerShot ? { footerShot } : {}) };
      }
    }
    return { url: null, how: null, tried, ...(footerShot ? { footerShot } : {}) };
  } finally {
    await closeSafely(ctx, 15000);
  }
}
