import { consentFromFlags, selectorAdapter } from './base.js';

export const cookieyes = selectorAdapter({
  id: 'cookieyes',
  name: 'CookieYes',
  detectExpr: `typeof window.getCkyConsent === 'function'`,
  detectSelectors: ['.cky-consent-container', '#cookie-law-info-bar'],
  bannerSelectors: ['.cky-consent-container:not(.cky-hide)', '#cookie-law-info-bar'],
  reject: {
    firstLayer: ['.cky-btn-reject', '#cookie_action_close_header_reject'],
    close: ['.cky-banner-btn-close'],
    openPreferences: ['.cky-btn-customize'],
    preferencesReject: ['.cky-btn-preferences'],
  },
  accept: { firstLayer: ['.cky-btn-accept', '#cookie_action_close_header'] },
  stateExpr: `(() => { try { const c = window.getCkyConsent(); return c && c.categories ? c.categories : null; } catch { return null; } })()`,
  check: (s, choice) => consentFromFlags(s as Record<string, unknown>, ['functional', 'analytics', 'performance', 'advertisement'], choice),
});
