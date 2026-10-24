import type { Browser } from 'playwright';

/** Paesi UE + SEE: fuori da qui molti CMP non mostrano il banner o lo mostrano diverso. */
export const EU_EEA = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
]);

export interface ExitInfo {
  /** true se IP e paese sono stati rilevati. */
  verified: boolean;
  ip: string | null;
  country: string | null;
  declared: string;
  source: string;
  /** Paese rilevato uguale a quello dichiarato. */
  matches: boolean;
  inEu: boolean | null;
  note: string;
}

/** Interpreta la risposta in formato "chiave=valore" per riga (es. /cdn-cgi/trace di Cloudflare). */
export function parseTrace(text: string): { ip: string | null; country: string | null } {
  const kv = Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((l) => l.split('='))
      .filter((p) => p.length >= 2)
      .map(([k, ...v]) => [k.trim(), v.join('=').trim()]),
  );
  return { ip: kv.ip || null, country: kv.loc ? kv.loc.toUpperCase() : null };
}

/**
 * Rileva IP e paese di uscita passando dal browser di audit, quindi dallo stesso proxy
 * e dalle stesse impostazioni di rete delle sessioni.
 */
export async function detectExit(browser: Browser, url: string, declared: string): Promise<ExitInfo> {
  const base = { declared: declared.toUpperCase(), source: url };
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const res = await page.goto(url, { timeout: 15000, waitUntil: 'commit' });
    if (!res?.ok()) throw new Error(`risposta ${res?.status() ?? 'assente'}`);
    const { ip, country } = parseTrace(await res.text());
    if (!country) throw new Error('paese non presente nella risposta');
    const inEu = EU_EEA.has(country);
    const matches = country === base.declared;
    return {
      ...base,
      verified: true,
      ip,
      country,
      matches,
      inEu,
      note: matches
        ? `Paese di uscita verificato: ${country}.`
        : `Il paese di uscita rilevato (${country}) è diverso da quello dichiarato (${base.declared}).${inEu ? '' : ' Il paese rilevato è fuori da UE/SEE: il banner può non essere mostrato o essere diverso.'}`,
    };
  } catch (e) {
    return {
      ...base,
      verified: false,
      ip: null,
      country: null,
      matches: false,
      inEu: null,
      note: `Paese di uscita non verificato (${(e as Error).message.split('\n')[0]}): vale solo quello dichiarato.`,
    };
  } finally {
    await ctx.close();
  }
}
