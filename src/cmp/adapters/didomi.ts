import { selectorAdapter } from './base.js';

export const didomi = selectorAdapter({
  id: 'didomi',
  name: 'Didomi',
  detectExpr: `window.Didomi || window.didomiOnReady`,
  detectSelectors: ['#didomi-host'],
  bannerSelectors: ['#didomi-notice', '#didomi-popup .didomi-popup-notice'],
  reject: {
    firstLayer: ['#didomi-notice-disagree-button'],
    close: ['.didomi-continue-without-agreeing', '#didomi-notice .didomi-popup-close'],
    api: 'Didomi.setUserDisagreeToAll()',
  },
  accept: { firstLayer: ['#didomi-notice-agree-button'], api: 'Didomi.setUserAgreeToAll()' },
  stateExpr: `(() => { const s = window.Didomi && Didomi.getUserStatus ? Didomi.getUserStatus() : null; return s ? { purposesEnabled: s.purposes && s.purposes.consent && s.purposes.consent.enabled, purposesDisabled: s.purposes && s.purposes.consent && s.purposes.consent.disabled, vendorsEnabled: s.vendors && s.vendors.consent && s.vendors.consent.enabled } : null; })()`,
  check(state, choice) {
    const s = state as { purposesEnabled?: string[] } | null;
    if (!s?.purposesEnabled) return { consistent: null, detail: 'Didomi.getUserStatus() non disponibile' };
    const n = s.purposesEnabled.length;
    if (choice === 'rifiuta') {
      return n ? { consistent: false, detail: `finalità attive dopo il rifiuto: ${s.purposesEnabled.join(', ')}` } : { consistent: true, detail: 'nessuna finalità attiva' };
    }
    return n ? { consistent: true, detail: `finalità attive: ${n}` } : { consistent: false, detail: 'nessuna finalità attiva dopo l\'accettazione' };
  },
});
