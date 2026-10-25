/**
 * Comandi per riaprire le preferenze dopo la scelta (di solito nel footer o come icona fluttuante):
 * usati sia dall'analisi del banner sia dallo scenario "revoca".
 */
export const REVOKE_SELECTORS = [
  // OneTrust: link nel footer, icona fluttuante, link "classici" Optanon
  '.ot-sdk-show-settings',
  '#ot-sdk-btn',
  '#ot-sdk-btn-floating .ot-floating-button__open',
  '.ot-floating-button__open',
  '.optanon-show-settings',
  '.optanon-toggle-display',
  '[onclick*="ToggleInfoDisplay"]',
  '[href*="ToggleInfoDisplay"]',
  // Cookiebot
  'a[href*="Cookiebot.renew"]',
  'a[href*="CookieConsent.renew"]',
  '[onclick*="Cookiebot.renew"]',
  '#CookiebotWidget .CookiebotWidget-logo',
  // iubenda, Didomi, vanilla-cookieconsent, CookieYes, Complianz
  '.iubenda-cs-preferences-link',
  'a[href*="Didomi.preferences.show"]',
  '[data-cc="c-settings"]',
  '[data-cc="show-preferencesModal"]',
  '.cky-btn-revisit',
  '#cmplz-manage-consent',
  // HubSpot
  '#hs-eu-cookie-settings-button',
  '[href*="showBanner"]',
  '[onclick*="showBanner"]',
];

export const REVOKE_TEXT =
  /((preferenze|impostazioni|gestisci|gestione|modifica|personalizza)\s.{0,25}cookie|cookie\s.{0,20}(preferenze|impostazioni|settings|preferences)|(revoca|gestisci|modifica|aggiorna).{0,30}consenso|preferenze (sulla |della )?privacy|privacy (settings|choices|preferences)|your privacy choices|cookie settings|manage cookies|le tue scelte)/i;
