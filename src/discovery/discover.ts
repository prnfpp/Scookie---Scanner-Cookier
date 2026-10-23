import type { Browser, Page } from 'playwright';
import type { AuditConfig, SiteConfig } from '../config/schema.js';

export interface SampledPage {
  url: string;
  type: string;
  source: 'home' | 'extra' | 'sitemap' | 'link';
}

export interface DiscoveryResult {
  site: string;
  sitemapUrls: string[];
  found: number;
  byType: Record<string, number>;
  sample: SampledPage[];
  notes: string[];
}

const LOC_RE = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
const SKIP_EXT = /\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mp3|xml|txt|css|js)$/i;

/** Estrae le <loc> da una sitemap; distingue sitemap indice e sitemap di pagine. */
export function parseSitemap(xml: string): { isIndex: boolean; locs: string[] } {
  const locs = [...xml.matchAll(LOC_RE)].map((m) => m[1].replace(/&amp;/g, '&'));
  return { isIndex: /<sitemapindex[\s>]/i.test(xml), locs };
}

/**
 * Tipo di pagina: prima i pattern della configurazione, poi il primo segmento del path.
 * La home è sempre "home".
 */
export function pageType(url: string, patterns: Record<string, string>): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || /^\/(?:index\.\w+|[a-z]{2}(?:-[a-z]{2})?)$/i.test(path)) return 'home';
  for (const [name, re] of Object.entries(patterns)) {
    if (new RegExp(re, 'i').test(u.pathname)) return name;
  }
  const segs = path.split('/').filter(Boolean);
  // Salta il prefisso lingua (/it/, /en-gb/)
  const first = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segs[0] ?? '') ? segs[1] : segs[0];
  return first ? first.toLowerCase().slice(0, 40) : 'altro';
}

function normalize(url: string, base: string): string | null {
  try {
    const u = new URL(url, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Campione deterministico: per ogni tipo, prende pagine equidistanti nell'elenco ordinato.
 * La stessa configurazione e lo stesso sito producono sempre lo stesso campione.
 */
export function sample(
  urls: { url: string; source: SampledPage['source'] }[],
  homeUrl: string,
  extras: string[],
  cfg: { perTipo: number; maxPagine: number; tipi: Record<string, string> },
): SampledPage[] {
  const out: SampledPage[] = [{ url: homeUrl, type: 'home', source: 'home' }];
  const seen = new Set([homeUrl]);
  for (const e of extras) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push({ url: e, type: pageType(e, cfg.tipi), source: 'extra' });
  }
  const groups = new Map<string, { url: string; source: SampledPage['source'] }[]>();
  for (const u of urls) {
    if (seen.has(u.url)) continue;
    const t = pageType(u.url, cfg.tipi);
    if (t === 'home') continue;
    const g = groups.get(t) ?? [];
    if (!g.some((x) => x.url === u.url)) g.push(u);
    groups.set(t, g);
  }
  // Tipi più popolosi prima; poi alfabetico per stabilità.
  const types = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const picked = new Map<string, SampledPage[]>();
  for (const [type, list] of types) {
    list.sort((a, b) => a.url.localeCompare(b.url));
    const n = Math.min(cfg.perTipo, list.length);
    const step = list.length / n;
    picked.set(
      type,
      Array.from({ length: n }, (_, i) => ({ ...list[Math.floor(i * step)], type })),
    );
  }
  // Round-robin tra i tipi finché non si raggiunge il massimo, così il campione resta vario.
  for (let round = 0; out.length < cfg.maxPagine; round++) {
    let added = false;
    for (const [, list] of picked) {
      if (out.length >= cfg.maxPagine) break;
      const p = list[round];
      if (p) {
        out.push(p);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

/**
 * Scarica un file passando dal browser, così valgono proxy e impostazioni di rete della configurazione
 * (il client HTTP di Node non li userebbe).
 */
async function fetchText(page: Page, url: string): Promise<string | null> {
  try {
    const res = await page.goto(url, { timeout: 20000, waitUntil: 'commit' });
    if (!res || !res.ok()) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function readSitemaps(req: Page, origin: string, max: number, notes: string[]) {
  const robots = (await fetchText(req, `${origin}/robots.txt`)) ?? '';
  const declared = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const queue = declared.length ? declared : [`${origin}/sitemap.xml`];
  notes.push(declared.length ? `Sitemap da robots.txt: ${declared.join(', ')}` : 'Nessuna sitemap in robots.txt, provata /sitemap.xml');
  const visited = new Set<string>();
  const pages: string[] = [];
  while (queue.length && visited.size < 50 && pages.length < max) {
    const sm = queue.shift()!;
    if (visited.has(sm)) continue;
    visited.add(sm);
    const xml = await fetchText(req, sm);
    if (!xml) {
      notes.push(`Sitemap non leggibile: ${sm}`);
      continue;
    }
    const { isIndex, locs } = parseSitemap(xml);
    if (isIndex) queue.push(...locs);
    else pages.push(...locs.slice(0, max - pages.length));
  }
  return { sitemapUrls: [...visited], pages };
}

export async function discoverSite(
  browser: Browser,
  site: SiteConfig,
  cfg: AuditConfig,
  userAgent: string,
): Promise<DiscoveryResult> {
  const home = new URL(site.url).toString();
  const origin = new URL(home).origin;
  const host = new URL(home).hostname;
  const notes: string[] = [];
  const extras = site.pagineExtra.map((p) => normalize(p, home)).filter((u): u is string => !!u);
  const exclude = site.escludi.map((e) => new RegExp(e, 'i'));
  const keep = (u: string) => {
    const parsed = new URL(u);
    return parsed.hostname === host && !SKIP_EXT.test(parsed.pathname) && !exclude.some((re) => re.test(parsed.pathname));
  };

  const candidates: { url: string; source: SampledPage['source'] }[] = [];
  let sitemapUrls: string[] = [];

  if (!site.soloPagineExtra) {
    const ctx = await browser.newContext({ userAgent, locale: cfg.browser.locale, ignoreHTTPSErrors: false });
    try {
      if (site.sitemap) {
        const smPage = await ctx.newPage();
        const sm = await readSitemaps(smPage, origin, cfg.campionamento.maxUrlSitemap, notes);
        await smPage.close();
        sitemapUrls = sm.sitemapUrls;
        for (const p of sm.pages) {
          const n = normalize(p, home);
          if (n && keep(n)) candidates.push({ url: n, source: 'sitemap' });
        }
        notes.push(`URL da sitemap sullo stesso host: ${candidates.length}`);
      }
      if (site.seguiLink) {
        // Contesto separato da quelli di audit: i cookie scritti qui non influenzano gli scenari.
        const page = await ctx.newPage();
        try {
          await page.goto(home, { waitUntil: 'domcontentloaded', timeout: cfg.protocollo.timeoutNavigazione });
          await page.waitForTimeout(1500);
          const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).href));
          let n = 0;
          for (const h of hrefs) {
            const u = normalize(h, home);
            if (u && keep(u) && !candidates.some((c) => c.url === u)) {
              candidates.push({ url: u, source: 'link' });
              n++;
            }
          }
          notes.push(`URL da link interni della home: ${n}`);
        } catch (e) {
          notes.push(`Home non raggiungibile per la lettura dei link: ${(e as Error).message.split('\n')[0]}`);
        }
      }
    } finally {
      await ctx.close();
    }
  }

  const s = sample(candidates, home, extras, cfg.campionamento);
  const byType: Record<string, number> = {};
  for (const c of candidates) {
    const t = pageType(c.url, cfg.campionamento.tipi);
    byType[t] = (byType[t] ?? 0) + 1;
  }
  return { site: origin, sitemapUrls, found: candidates.length, byType, sample: s, notes };
}
