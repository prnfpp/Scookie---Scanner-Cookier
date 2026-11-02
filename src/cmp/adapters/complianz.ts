import { consentFromFlags, selectorAdapter, COOKIE_MAP_EXPR } from './base.js';

export const complianz = selectorAdapter({
  id: 'complianz',
  name: 'Complianz',
  detectExpr: `window.complianz || typeof window.cmplz_set_cookie === 'function'`,
  detectSelectors: ['#cmplz-cookiebanner-container', '.cmplz-cookiebanner'],
  // Il banner resta nel DOM anche dopo la scelta: mostrato = classe cmplz-show, chiuso = cmplz-dismissed o cmplz-hidden
  bannerSelectors: ['.cmplz-cookiebanner.cmplz-show:not(.cmplz-dismissed):not(.cmplz-hidden)'],
  bannerStateExpr: `(() => { const b = Array.from(document.querySelectorAll('.cmplz-cookiebanner')); if (!b.length) return null; return b.some((e) => e.classList.contains('cmplz-show') && !e.classList.contains('cmplz-dismissed') && !e.classList.contains('cmplz-hidden')); })()`,
  reject: {
    firstLayer: ['.cmplz-cookiebanner .cmplz-deny'],
    close: ['.cmplz-cookiebanner .cmplz-close'],
    openPreferences: ['.cmplz-cookiebanner .cmplz-view-preferences'],
    preferencesReject: ['.cmplz-cookiebanner .cmplz-save-preferences'],
  },
  accept: { firstLayer: ['.cmplz-cookiebanner .cmplz-accept'] },
  // Categorie dagli input del banner (input.cmplz-consent-checkbox con data-category cmplz_functional, cmplz_preferences,
  // cmplz_statistics, cmplz_marketing); etichetta dal titolo della categoria (.cmplz-category-title) o dalla <label>.
  // Si leggono solo le caselle con il loro riquadro visibile: Complianz ha più banner (optin/optout) nella pagina.
  categoriesExpr: `(() => {
    const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const seen = new Set();
    const out = [];
    for (const i of document.querySelectorAll('.cmplz-cookiebanner input[type="checkbox"][data-category]')) {
      const cat = i.getAttribute('data-category') || '';
      const box = i.closest('.cmplz-category') || i.parentElement || i;
      if (seen.has(cat) || !shown(box)) continue;
      seen.add(cat);
      const title = box.querySelector('.cmplz-category-title');
      const lab = i.id ? document.querySelector('label[for="' + i.id + '"]') : null;
      const label = ((title && title.textContent) || (lab && lab.textContent) || cat).replace(/\\s+/g, ' ').trim();
      out.push({ label, checked: i.checked, disabled: i.disabled });
    }
    return out;
  })()`,
  stateExpr: `(() => { const m = ${COOKIE_MAP_EXPR}; return Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('cmplz_'))); })()`,
  check(state, choice) {
    const m = state as Record<string, string> | null;
    if (!m || !Object.keys(m).length) return { consistent: null, detail: 'cookie cmplz_* non trovati' };
    const flags = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === 'allow']));
    return consentFromFlags(flags, ['cmplz_statistics', 'cmplz_marketing', 'cmplz_preferences'], choice);
  },
});
