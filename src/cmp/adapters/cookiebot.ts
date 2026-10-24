import { consentFromFlags, selectorAdapter } from './base.js';

export const cookiebot = selectorAdapter({
  id: 'cookiebot',
  name: 'Cookiebot',
  detectExpr: `window.Cookiebot || window.CookieConsent && window.CookieConsent.consentID !== undefined`,
  detectSelectors: ['#CybotCookiebotDialog', 'script[src*="consent.cookiebot.com"]'],
  bannerSelectors: ['#CybotCookiebotDialog'],
  reject: {
    firstLayer: ['#CybotCookiebotDialogBodyButtonDecline'],
    openPreferences: ['#CybotCookiebotDialogBodyLevelButtonCustomize', '#CybotCookiebotDialogNavDetails'],
    preferencesReject: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection'],
    api: '(window.Cookiebot || window.CookieConsent).submitCustomConsent(false, false, false)',
  },
  accept: {
    firstLayer: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept'],
    api: '(window.Cookiebot || window.CookieConsent).submitCustomConsent(true, true, true)',
  },
  stateExpr: `(() => { const c = (window.Cookiebot || window.CookieConsent || {}).consent; return c ? { necessary: c.necessary, preferences: c.preferences, statistics: c.statistics, marketing: c.marketing } : null; })()`,
  check: (s, choice) => consentFromFlags(s as Record<string, unknown>, ['preferences', 'statistics', 'marketing'], choice),
});
