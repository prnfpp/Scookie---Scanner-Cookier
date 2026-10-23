import type { CmpAdapter } from '../types.js';

/**
 * IAB TCF v2 (__tcfapi): non è un banner ma uno standard esposto da molti CMP.
 * L'adattatore non interagisce; serve a leggere e verificare lo stato del consenso.
 */
export const tcf: CmpAdapter = {
  id: 'tcf',
  name: 'IAB TCF v2',
  async detect(page) {
    return (await page.evaluate(`typeof window.__tcfapi === 'function'`).catch(() => false)) as boolean;
  },
  async bannerVisible() {
    return false;
  },
  async choose() {
    return null;
  },
  async consentState(page) {
    return page
      .evaluate(
        () =>
          new Promise((resolve) => {
            const w = window as unknown as { __tcfapi?: (cmd: string, v: number, cb: (d: unknown, ok: boolean) => void) => void };
            if (!w.__tcfapi) return resolve(null);
            const t = setTimeout(() => resolve({ errore: 'timeout getTCData' }), 3000);
            w.__tcfapi('getTCData', 2, (d, ok) => {
              clearTimeout(t);
              if (!ok || !d) return resolve(null);
              const data = d as {
                tcString?: string;
                cmpId?: number;
                gdprApplies?: boolean;
                eventStatus?: string;
                purpose?: { consents?: Record<string, boolean>; legitimateInterests?: Record<string, boolean> };
                specialFeatureOptins?: Record<string, boolean>;
              };
              resolve({
                tcString: data.tcString,
                cmpId: data.cmpId,
                gdprApplies: data.gdprApplies,
                eventStatus: data.eventStatus,
                purposeConsents: data.purpose?.consents,
                purposeLegitimateInterests: data.purpose?.legitimateInterests,
                specialFeatureOptins: data.specialFeatureOptins,
              });
            });
          }),
      )
      .catch(() => null);
  },
  checkConsent(state, choice) {
    const s = state as { tcString?: string; purposeConsents?: Record<string, boolean> } | null;
    if (!s?.purposeConsents) return { consistent: null, detail: 'dati TCF non disponibili' };
    if (!s.tcString) return { consistent: null, detail: 'TC string vuota: nessuna scelta registrata' };
    const on = Object.entries(s.purposeConsents).filter(([, v]) => v).map(([k]) => k);
    if (choice === 'rifiuta') {
      return on.length
        ? { consistent: false, detail: `TCF: finalità con consenso dopo il rifiuto: ${on.join(', ')}` }
        : { consistent: true, detail: 'TCF: nessuna finalità con consenso' };
    }
    return on.length
      ? { consistent: true, detail: `TCF: finalità con consenso: ${on.join(', ')}` }
      : { consistent: false, detail: 'TCF: nessuna finalità con consenso dopo l\'accettazione' };
  },
};
