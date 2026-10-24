import type { Page, Response } from 'playwright';

export interface BotBlock {
  /** Sistema che ha bloccato la navigazione (es. Cloudflare). */
  provider: string;
  /** Segnale che lo ha rivelato, da riportare nel report. */
  signal: string;
  url: string;
}

const TITLE_RE =
  /^(just a moment|un momento|attention required|access denied|request unsuccessful|pardon our interruption|please verify you are a human|are you a robot|checking your browser|verifica.{0,30}(umano|browser))/i;

/**
 * Riconosce le pagine di verifica dei sistemi anti-bot (Cloudflare, Imperva, Akamai, DataDome, PerimeterX).
 * Si usano segnali propri della pagina di verifica, non la semplice presenza del fornitore:
 * un widget Turnstile in un modulo di contatto, per esempio, non è un blocco.
 */
export async function detectBotChallenge(page: Page, response: Response | null): Promise<BotBlock | null> {
  const url = page.url();
  const headers = response ? await response.allHeaders().catch(() => ({}) as Record<string, string>) : {};
  if ((headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge') {
    return { provider: 'Cloudflare', signal: 'intestazione cf-mitigated: challenge', url };
  }
  const info = await page
    .evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const q = (s: string) => !!document.querySelector(s);
      const body = (document.body?.innerText ?? '').slice(0, 2000);
      return {
        title: document.title.trim(),
        cfChallenge: !!w._cf_chl_opt || q('#challenge-form') || q('#cf-challenge-running') || q('script[src*="/cdn-cgi/challenge-platform/h/"]'),
        imperva: q('iframe[src*="_Incapsula_Resource"]') || /Incapsula incident ID/i.test(body),
        datadome: q('iframe[src*="captcha-delivery.com"]'),
        perimeterx: q('#px-captcha') || !!w._pxAppId && /press\s*&\s*hold/i.test(body),
        akamai: /Reference\s+#\d+\.[0-9a-f]+/i.test(body) && /access denied/i.test(document.title + body),
      };
    })
    .catch(() => null);
  if (!info) return null;
  if (info.cfChallenge) return { provider: 'Cloudflare', signal: 'pagina di verifica Cloudflare (challenge-platform)', url };
  if (info.imperva) return { provider: 'Imperva', signal: 'pagina di verifica Imperva/Incapsula', url };
  if (info.datadome) return { provider: 'DataDome', signal: 'captcha DataDome', url };
  if (info.perimeterx) return { provider: 'HUMAN (PerimeterX)', signal: 'captcha "Press & Hold"', url };
  if (info.akamai) return { provider: 'Akamai', signal: 'pagina "Access Denied" con codice di riferimento', url };
  const status = response?.status() ?? 0;
  if (TITLE_RE.test(info.title) && (status >= 400 || headers['cf-ray'] || headers['x-iinfo'] || /akamai/i.test(headers.server ?? ''))) {
    return { provider: headers['cf-ray'] ? 'Cloudflare' : headers['x-iinfo'] ? 'Imperva' : /akamai/i.test(headers.server ?? '') ? 'Akamai' : 'sconosciuto', signal: `titolo "${info.title}" (HTTP ${status})`, url };
  }
  return null;
}
