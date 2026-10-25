import { selectorAdapter, COOKIE_MAP_EXPR } from './base.js';

export const hubspot = selectorAdapter({
  id: 'hubspot',
  name: 'HubSpot',
  // dopo la scelta il banner può sparire dal DOM: bastano l'API e i cookie di consenso di HubSpot
  detectExpr: `window._hsp && (document.getElementById('hs-eu-cookie-confirmation') || document.getElementById('hs-banner-parent') || /(^|; )(__hs_cookie_cat_pref|__hs_opt_out)=/.test(document.cookie))`,
  detectSelectors: ['#hs-eu-cookie-confirmation', '#hs-banner-parent'],
  bannerSelectors: ['#hs-eu-cookie-confirmation', '#hs-banner-parent'],
  reject: {
    firstLayer: ['#hs-eu-decline-button', '#hs-banner-decline-button'],
    close: ['#hs-eu-close-button', '#hs-banner-close-button'],
    // API di HubSpot per revocare il consenso (rimuove anche i cookie di HubSpot).
    api: "(window._hsp = window._hsp || []).push(['revokeCookieConsent'])",
  },
  accept: { firstLayer: ['#hs-eu-confirmation-button', '#hs-banner-accept-button'] },
  // il link "Impostazioni cookie" di HubSpot chiama questa API: riapre il banner
  reopenExpr: "(window._hsp = window._hsp || []).push(['showBanner'])",
  stateExpr: `(() => { const m = ${COOKIE_MAP_EXPR}; return { optOut: m.__hs_opt_out || null, catPref: m.__hs_cookie_cat_pref || null }; })()`,
  check(state, choice) {
    const s = state as { optOut: string | null; catPref: string | null } | null;
    if (!s || (!s.optOut && !s.catPref)) return { consistent: null, detail: 'cookie di consenso HubSpot non trovati' };
    const anyOn = s.catPref ? /:true/.test(s.catPref) : s.optOut === 'no';
    if (choice === 'rifiuta') return { consistent: !anyOn, detail: `__hs_opt_out=${s.optOut}; __hs_cookie_cat_pref=${s.catPref}` };
    return { consistent: anyOn, detail: `__hs_opt_out=${s.optOut}; __hs_cookie_cat_pref=${s.catPref}` };
  },
});
