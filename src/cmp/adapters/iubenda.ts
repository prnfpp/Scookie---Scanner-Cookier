import { consentFromFlags, selectorAdapter, COOKIE_MAP_EXPR } from './base.js';

export const iubenda = selectorAdapter({
  id: 'iubenda',
  name: 'iubenda',
  detectExpr: `window._iub && window._iub.cs`,
  detectSelectors: ['#iubenda-cs-banner'],
  bannerSelectors: ['#iubenda-cs-banner'],
  reject: {
    firstLayer: ['#iubenda-cs-banner .iubenda-cs-reject-btn'],
    close: ['#iubenda-cs-banner .iubenda-cs-close-btn'],
    openPreferences: ['#iubenda-cs-banner .iubenda-cs-customize-btn'],
    preferencesReject: ['#iubenda-iframe .iub-btn-reject', '#iubenda-iframe #iubFooterBtn'],
  },
  accept: { firstLayer: ['#iubenda-cs-banner .iubenda-cs-accept-btn'] },
  // iubenda salva il consenso nel cookie _iub_cs-<id> (JSON con le finalità).
  stateExpr: `(() => { const m = ${COOKIE_MAP_EXPR}; const k = Object.keys(m).find((n) => n.startsWith('_iub_cs-')); let v = null; try { v = k ? JSON.parse(m[k]) : null; } catch { v = m[k]; } return { cookie: k || null, valore: v }; })()`,
  check(state, choice) {
    const v = (state as { valore?: { purposes?: Record<string, boolean>; consent?: boolean } } | null)?.valore;
    if (!v) return { consistent: null, detail: 'cookie di consenso iubenda non trovato' };
    if (v.purposes) {
      // Finalità iubenda: 1 necessari, 2 funzionalità, 3 esperienza, 4 misurazione, 5 marketing
      return consentFromFlags(v.purposes, ['3', '4', '5'], choice);
    }
    if (typeof v.consent === 'boolean') {
      const ok = choice === 'rifiuta' ? v.consent === false : v.consent === true;
      return { consistent: ok, detail: `consent=${v.consent}` };
    }
    return { consistent: null, detail: 'formato del consenso iubenda non riconosciuto' };
  },
});
