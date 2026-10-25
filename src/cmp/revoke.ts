import type { Frame } from 'playwright';

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

/** Indirizzi di pagine dedicate alla gestione dei cookie (es. /preferenze-cookies), nel footer o nella sitemap. */
// "gestione-cookie" è escluso di proposito: sui siti italiani è spesso il nome della pagina di cookie policy.
export const REVOKE_HREF =
  /(preferenze|impostazioni|gestisci|modifica)[-_]?(dei[-_])?cookies?|cookies?[-_]?(preferenc|settings|impostazioni|preferenze|consent)|(privacy|consent)[-_](preferences|settings|center)/i;

/** Testi e indirizzi dell'informativa: un link "Informativa sulla gestione dei cookie" non serve a revocare. */
const POLICY_LIKE = /informativa|policy|privacy-policy|cookie-policy|normativa/i;

/**
 * Cerca nel frame un comando visibile per riaprire le preferenze, fuori dal banner (elementi marcati dallo scan
 * con data-scookie-c): prima gli elementi dei CMP noti, poi il testo, poi l'indirizzo di una pagina dedicata.
 * Il comando trovato è marcato con data-scookie-revoke per poterlo cliccare.
 */
export async function findRevokeControl(frame: Frame): Promise<{ text: string; how: string } | null> {
  return frame
    .evaluate(
      ({ selectors, textSrc, hrefSrc, policySrc }) => {
        const textRe = new RegExp(textSrc, 'i');
        const hrefRe = new RegExp(hrefSrc, 'i');
        const policyRe = new RegExp(policySrc, 'i');
        for (const old of Array.from(document.querySelectorAll('[data-scookie-revoke]'))) old.removeAttribute('data-scookie-revoke');
        const inBanner = (el: Element) => !!el.closest('[data-scookie-c]');
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const label = (el: Element) => ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const mark = (el: Element, how: string) => {
          el.setAttribute('data-scookie-revoke', '1');
          return { text: label(el) || how, how };
        };
        for (const sel of selectors) {
          const el = Array.from(document.querySelectorAll(sel)).find((x) => visible(x) && !inBanner(x));
          if (el) return mark(el, `elemento ${sel}`);
        }
        const clickable = Array.from(document.querySelectorAll('a, button, [role="button"]')).filter((x) => visible(x) && !inBanner(x));
        for (const el of clickable) {
          const t = label(el);
          const href = (el as HTMLAnchorElement).href ?? '';
          // un link all'informativa non è un comando di revoca, anche se il testo parla di gestione dei cookie
          if (t && textRe.test(t) && !policyRe.test(t) && !(href && policyRe.test(href) && !hrefRe.test(href))) return mark(el, 'testo del comando');
        }
        for (const el of clickable) {
          const href = (el as HTMLAnchorElement).href;
          if (href && hrefRe.test(href)) return mark(el, `link alla pagina ${href}`);
        }
        return null;
      },
      { selectors: REVOKE_SELECTORS, textSrc: REVOKE_TEXT.source, hrefSrc: REVOKE_HREF.source, policySrc: POLICY_LIKE.source },
    )
    .catch(() => null);
}

export const isRevokeUrl = (url: string) => {
  try {
    const u = new URL(url);
    return REVOKE_HREF.test(u.pathname + u.hash);
  } catch {
    return false;
  }
};
