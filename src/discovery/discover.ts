import type { Browser, Page } from 'playwright';
import type { AuditConfig, SiteConfig } from '../config/schema.js';
import { closeSafely, withTimeout } from '../util/misc.js';
import { registrableDomain } from '../util/domains.js';
import { isRevokeUrl } from '../cmp/revoke.js';
import { exploreByClicks } from './explore.js';

export interface SampledPage {
  url: string;
  type: string;
  source: 'home' | 'extra' | 'sitemap' | 'link' | 'esplorazione';
}

export interface DiscoveryResult {
  site: string;
  sitemapUrls: string[];
  found: number;
  byType: Record<string, number>;
  sample: SampledPage[];
  notes: string[];
  /** Pagine dedicate alla gestione dei cookie trovate tra le URL scoperte (es. /preferenze-cookies). */
  revokePages?: string[];
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
/** Primo segmento del percorso (saltando il prefisso lingua), per le URL con almeno due livelli: sono le "sezioni". */
export function sectionsOf(urls: string[]): Set<string> {
  const out = new Set<string>();
  for (const u of urls) {
    try {
      const all = new URL(u).pathname.split('/').filter(Boolean);
      const segs = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(all[0] ?? '') ? all.slice(1) : all;
      if (segs.length > 1) out.add(segs[0].toLowerCase());
    } catch {
      // URL non valida
    }
  }
  return out;
}

/**
 * Tipo di pagina. Con `sections` (le sezioni che hanno sottopagine), le pagine a un solo livello che non sono
 * l'indice di una sezione si raggruppano in "pagina": senza, siti con indirizzi piatti avrebbero un tipo per pagina.
 */
export function pageType(url: string, patterns: Record<string, string>, sections?: Set<string>): string {
  const u = new URL(url);
  // Instradamento nel frammento (#/offerte): il percorso vero è nel frammento.
  const hashRoute = /^#!?\//.test(u.hash) ? u.hash.replace(/^#!?/, '') : '';
  const path = (u.pathname.replace(/\/+$/, '') + hashRoute).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  if (path === '/' || /^\/(?:index\.\w+|[a-z]{2}(?:-[a-z]{2})?)$/i.test(path)) return 'home';
  for (const [name, re] of Object.entries(patterns)) {
    if (new RegExp(re, 'i').test(u.pathname)) return name;
  }
  const all = path.split('/').filter(Boolean);
  // Salta il prefisso lingua (/it/, /en-gb/)
  const segs = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(all[0] ?? '') ? all.slice(1) : all;
  const first = segs[0];
  if (!first) return 'altro';
  // Più livelli: il primo è la sezione (/blog/…, /prodotti/…)
  if (segs.length > 1) return first.toLowerCase().slice(0, 40);
  // Un solo livello con numeri o estensione (es. PrestaShop /10-nome.html, /16-categoria):
  // si raggruppa per forma, altrimenti ogni prodotto diventerebbe un tipo a sé.
  const ext = /\.[a-z0-9]{2,5}$/i.exec(first)?.[0].toLowerCase() ?? '';
  if (ext || /\d/.test(first)) return `${/\d/.test(first) ? 'numerata' : 'pagina'}${ext}`;
  // Pagina con nome pulito (chi-siamo, contatti): tipo a sé se è l'indice di una sezione, altrimenti "pagina"
  if (sections && !sections.has(first.toLowerCase())) return 'pagina';
  return first.toLowerCase().slice(0, 40);
}

function normalize(url: string, base: string): string | null {
  try {
    const u = new URL(url, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    // Le applicazioni con instradamento nel frammento (/#/preventivo) hanno pagine distinte nel frammento:
    // lo si tiene solo per gli indirizzi che finiscono con "/" (o index.html), dove vive questo tipo di applicazione.
    if (!(/^#!?\//.test(u.hash) && /(\/|\/index\.\w+)$/.test(u.pathname))) u.hash = '';
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
  const sections = sectionsOf(urls.map((u) => u.url));
  const out: SampledPage[] = [{ url: homeUrl, type: 'home', source: 'home' }];
  const seen = new Set([homeUrl]);
  for (const e of extras) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push({ url: e, type: pageType(e, cfg.tipi, sections), source: 'extra' });
  }
  const groups = new Map<string, { url: string; source: SampledPage['source'] }[]>();
  for (const u of urls) {
    if (seen.has(u.url)) continue;
    const t = pageType(u.url, cfg.tipi, sections);
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
    // Si preparano più pagine di perTipo: servono a completare il campione se i tipi sono pochi.
    const n = Math.min(cfg.maxPagine, list.length);
    const step = list.length / n;
    picked.set(
      type,
      Array.from({ length: n }, (_, i) => ({ ...list[Math.floor(i * step)], type })),
    );
  }
  // Round-robin tra i tipi, così il campione resta vario: prima fino a perTipo pagine per tipo,
  // poi, se i tipi sono pochi, si completa fino a maxPagine.
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

const STUB_PATH = '/__scookie_stub__';

/**
 * Scarica un file di testo passando dal browser, così valgono proxy e impostazioni di rete della configurazione
 * (il client HTTP di Node non li userebbe). La pagina viene portata sull'origine del file con un documento
 * fittizio servito localmente da Playwright (nessuna richiesta al sito), poi il file si legge con fetch().
 * Così non si caricano pagine di errore HTML, che su alcuni siti bloccano la chiusura della pagina.
 */
async function fetchText(page: Page, url: string): Promise<string | null> {
  try {
    const origin = new URL(url).origin;
    if (new URL(page.url()).origin !== origin) {
      await page.route(`${origin}${STUB_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>scookie</title>' }));
      await page.goto(`${origin}${STUB_PATH}`, { timeout: 10000 });
    }
    return await withTimeout(
      page.evaluate(async (u) => {
        const res = await fetch(u, { redirect: 'follow', credentials: 'omit' });
        return res.ok ? await res.text() : null;
      }, url),
      25000,
      `lettura ${url}`,
    );
  } catch {
    return null;
  }
}

/**
 * Regole Allow/Disallow di robots.txt per tutti i crawler (User-agent: *), con * e $ come in Google.
 * Ritorna una funzione che dice se un path è escluso. Vince la regola più lunga; a parità, Allow.
 */
export function robotsDisallows(robots: string): (path: string) => boolean {
  const rules: { allow: boolean; re: RegExp; len: number }[] = [];
  let groupAgents: string[] = [];
  let inRules = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (inRules) groupAgents = [];
      inRules = false;
      groupAgents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (!groupAgents.includes('*') || !value) continue;
      // Il "$" finale non viene sottoposto a escape: resta l'ancora di fine path, come nelle specifiche.
      const body = value.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      rules.push({ allow: key === 'allow', re: new RegExp(`^${body}`), len: value.length });
    }
  }
  return (path: string) => {
    const hits = rules.filter((r) => r.re.test(path)).sort((a, b) => b.len - a.len || Number(b.allow) - Number(a.allow));
    return hits.length > 0 && !hits[0].allow;
  };
}

async function readSitemaps(req: Page, origin: string, max: number, notes: string[], robots: string) {
  const declared = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  // Sitemap dello stesso host dichiarate con un altro protocollo (es. http:// su un sito https): si usa quello del sito.
  const sameScheme = (u: string) => {
    try {
      const x = new URL(u);
      if (x.hostname === new URL(origin).hostname) x.protocol = new URL(origin).protocol;
      return x.toString();
    } catch {
      return u;
    }
  };
  const queue = (declared.length ? declared : [`${origin}/sitemap.xml`]).map(sameScheme);
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
    if (isIndex) queue.push(...locs.map(sameScheme));
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
  // Link interni scritti con un protocollo diverso (es. http:// su un sito https): si usa quello del sito.
  const sameScheme = (u: string) => {
    const x = new URL(u);
    if (x.hostname === host && x.protocol !== new URL(home).protocol) x.protocol = new URL(home).protocol;
    return x.toString();
  };
  const extras = site.pagineExtra.map((p) => normalize(p, home)).filter((u): u is string => !!u);
  const exclude = site.escludi.map((e) => new RegExp(e, 'i'));
  // Pagine escluse da robots.txt: non entrano nel campione automatico (le pagine extra sì, sono una scelta esplicita).
  let disallowed: (path: string) => boolean = () => false;
  let robotsExcluded = 0;
  const keep = (u: string) => {
    const parsed = new URL(u);
    if (parsed.hostname !== host || SKIP_EXT.test(parsed.pathname) || exclude.some((re) => re.test(parsed.pathname))) return false;
    if (disallowed(parsed.pathname + parsed.search)) {
      robotsExcluded++;
      return false;
    }
    return true;
  };

  const candidates: { url: string; source: SampledPage['source'] }[] = [];
  let sitemapUrls: string[] = [];

  if (!site.soloPagineExtra) {
    const ctx = await browser.newContext({ userAgent, locale: cfg.browser.locale, ignoreHTTPSErrors: false });
    try {
      const smPage = await ctx.newPage();
      const robots = (await fetchText(smPage, `${origin}/robots.txt`)) ?? '';
      if (site.rispettaRobots) {
        disallowed = robotsDisallows(robots);
      }
      if (site.sitemap) {
        const sm = await readSitemaps(smPage, origin, cfg.campionamento.maxUrlSitemap, notes, robots);
        sitemapUrls = sm.sitemapUrls;
        for (const p of sm.pages) {
          const n = normalize(p, home);
          if (n && keep(n)) candidates.push({ url: sameScheme(n), source: 'sitemap' });
        }
        notes.push(`URL da sitemap sullo stesso host: ${candidates.length}`);
      }
      await closeSafely(smPage, 15000);
      if (site.seguiLink) {
        // Contesto separato da quelli di audit: i cookie scritti qui non influenzano gli scenari.
        const page = await ctx.newPage();
        try {
          await page.goto(home, { waitUntil: 'domcontentloaded', timeout: cfg.protocollo.timeoutNavigazione });
          await page.waitForTimeout(1500);
          const hrefs = await withTimeout(
            page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).href)),
            20000,
            'lettura dei link della home',
          );
          let n = 0;
          for (const h of hrefs) {
            const norm = normalize(h, home);
            const u = norm && keep(norm) ? sameScheme(norm) : null;
            if (u && !candidates.some((c) => c.url === u)) {
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
      const err = await closeSafely(ctx, 30000, 'chiusura contesto di scoperta');
      if (err) notes.push(err);
    }
  }

  const ex = cfg.campionamento.esplorazione;
  // In automatico solo se la scoperta era attiva: chi ha disattivato sitemap e link ha scelto le pagine a mano.
  const autoExplore = site.esplora === 'auto' && !site.soloPagineExtra && (site.sitemap || site.seguiLink) && candidates.length < ex.sePaginaMeno;
  if (site.esplora === 'sempre' || autoExplore) {
    const n = candidates.length;
    const why =
      site.esplora === 'sempre'
        ? 'richiesta dalla configurazione'
        : `${n === 0 ? 'nessuna pagina trovata' : n === 1 ? 'trovata una sola pagina' : `trovate solo ${n} pagine`} con sitemap e link`;
    try {
      const r = await exploreByClicks(browser, [home, ...extras], {
        userAgent,
        locale: cfg.browser.locale,
        depth: ex.profondita,
        maxClicks: ex.maxClic,
        maxPages: ex.maxPagine,
        perPage: 15,
        navTimeout: cfg.protocollo.timeoutNavigazione,
        budgetMs: ex.maxSecondi * 1000,
        keep,
        // Si può passare per gli altri sottodomini dello stesso dominio (es. dal sito principale all'area preventivo),
        // ma nel campione entrano solo le pagine di questo sito.
        traverse: (u) => {
          const h = new URL(u).hostname;
          return h !== host && registrableDomain(h) === registrableDomain(host);
        },
        normalize: (u) => {
          const n = normalize(u, home);
          return n ? sameScheme(n) : null;
        },
      });
      let added = 0;
      for (const u of r.urls) {
        if (u === home || extras.includes(u) || candidates.some((c) => c.url === u)) continue;
        candidates.push({ url: u, source: 'esplorazione' });
        added++;
      }
      notes.push(`Esplorazione con clic (${why}): ${r.clicks} clic, ${added} pagine nuove`, ...r.notes);
    } catch (e) {
      notes.push(`Esplorazione con clic non riuscita: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  if (robotsExcluded) notes.push(`URL escluse perché vietate da robots.txt: ${robotsExcluded}`);
  if (!candidates.length && !site.soloPagineExtra && !extras.length) {
    notes.push('Nessuna pagina scoperta automaticamente (es. applicazione web o pagina di accesso): indicare le pagine chiave in "Pagine da includere sempre" (pagineExtra).');
  }
  const s = sample(candidates, home, extras, cfg.campionamento);
  const byType: Record<string, number> = {};
  for (const c of candidates) {
    const t = pageType(c.url, cfg.campionamento.tipi, sectionsOf(candidates.map((x) => x.url)));
    byType[t] = (byType[t] ?? 0) + 1;
  }
  const revokePages = candidates.map((c) => c.url).filter(isRevokeUrl).slice(0, 5);
  if (revokePages.length) notes.push(`Pagina di gestione dei cookie trovata: ${revokePages[0]}`);
  return { site: origin, sitemapUrls, found: candidates.length, byType, sample: s, notes, revokePages };
}
