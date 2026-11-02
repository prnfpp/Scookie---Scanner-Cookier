/**
 * Contenitori dell'interfaccia dei gestori del consenso noti (banner e pannelli delle preferenze). Quando uno è
 * visibile, l'analisi del banner considera solo gli elementi al suo interno: il resto della pagina (moduli, widget
 * di terze parti, menu) non fa parte del banner.
 */
export const CMP_CONTAINERS = [
  '#onetrust-banner-sdk',
  '#onetrust-pc-sdk',
  '#CybotCookiebotDialog',
  '#didomi-host',
  '#usercentrics-root',
  '#cc_div',
  '#cc-main',
  '.cky-consent-container',
  '.cky-preference-center',
  '#cmplz-cookiebanner-container',
  '.cmplz-cookiebanner',
  '#hs-eu-cookie-confirmation',
  '#hs-banner-parent',
  '#hs-modal',
  '#iubenda-cs-banner',
  '.iubenda-cs-preferences',
];

/**
 * Indirizzi di iframe che appartengono a un gestore del consenso (banner servito in un frame dedicato).
 * Un iframe che non corrisponde e non è sovrapposto alla pagina è contenuto del sito (video, mappe, calendari):
 * non fa parte del banner.
 */
export const CMP_FRAME_URL =
  /consent|cookie|\bcmp\b|cmp\.|privacy-?(center|manager|mgmt)|sp_message|usercentrics|cookiebot|onetrust|cookielaw|iubenda|didomi|privacy-center\.org|cookieyes|quantcast|trustarc|truste|sourcepoint|complianz/i;
