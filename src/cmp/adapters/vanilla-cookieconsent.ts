import { COOKIE_MAP_EXPR, selectorAdapter } from './base.js';

// Il pulsante secondario della v2 (#c-s-bn) può essere "rifiuta" o "impostazioni" a seconda della
// configurazione del sito: lo si usa per rifiutare solo se il testo lo dice.
const REJECT_TEXT = ':text-matches("rifiut|necessar|essenzial|reject|decline|deny|only necessary", "i")';

/**
 * vanilla-cookieconsent (orestbida), v2 e v3: libreria open source molto diffusa nei siti della PA italiana.
 * Stato del consenso nel cookie cc_cookie: v2 { level: [...] }, v3 { categories: [...] }.
 */
export const vanillaCookieconsent = selectorAdapter({
  id: 'vanilla-cookieconsent',
  name: 'vanilla-cookieconsent',
  detectExpr: `typeof window.initCookieConsent === 'function' || (window.CookieConsent && typeof window.CookieConsent.getUserPreferences === 'function')`,
  detectSelectors: ['#cc_div', '#cc-main'],
  bannerSelectors: ['#cc_div #cm', '#cc-main .cm', '#cc_div #s-cnt', '#cc-main .pm'],
  reject: {
    firstLayer: [`#cc_div #cm #c-s-bn${REJECT_TEXT}`, '#cc-main .cm [data-role="necessary"]'],
    openPreferences: ['#cc_div #cm #c-s-bn', '#cc_div #cm [data-cc="c-settings"]', '#cc-main .cm [data-role="show"]'],
    preferencesReject: ['#cc_div #s-rall-bn', '#cc-main .pm [data-role="necessary"]', '#cc_div #s-sv-bn', '#cc-main .pm [data-role="save"]'],
  },
  accept: {
    firstLayer: ['#cc_div #cm #c-p-bn', '#cc-main .cm [data-role="all"]'],
  },
  stateExpr: `(() => { const m = ${COOKIE_MAP_EXPR}; if (!m.cc_cookie) return null; try { const v = JSON.parse(m.cc_cookie); return { categorie: v.categories || v.level || null, revisione: v.revision }; } catch { return { grezzo: m.cc_cookie }; } })()`,
  check(state, choice) {
    const cats = (state as { categorie?: string[] } | null)?.categorie;
    if (!Array.isArray(cats)) return { consistent: null, detail: 'cookie cc_cookie non trovato o non leggibile' };
    const others = cats.filter((c) => c !== 'necessary');
    if (choice === 'rifiuta') {
      return others.length
        ? { consistent: false, detail: `dopo il rifiuto risultano accettate: ${others.join(', ')}` }
        : { consistent: true, detail: `categorie accettate: ${cats.join(', ') || 'nessuna'}` };
    }
    return others.length
      ? { consistent: true, detail: `categorie accettate: ${cats.join(', ')}` }
      : { consistent: false, detail: 'dopo l\'accettazione risultano solo le categorie necessarie' };
  },
});
