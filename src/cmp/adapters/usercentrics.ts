import type { DeclaredItem } from '../../types.js';
import { normalizeDeclaredCategory } from '../../classify/classifier.js';
import { selectorAdapter } from './base.js';

export const usercentrics = selectorAdapter({
  id: 'usercentrics',
  name: 'Usercentrics',
  detectExpr: `window.UC_UI || window.__ucCmp`,
  detectSelectors: ['#usercentrics-root', '#usercentrics-cmp-ui'],
  bannerSelectors: ['[data-testid="uc-default-banner"]', '[data-testid="uc-deny-all-button"]', '#usercentrics-cmp-ui #deny', '#usercentrics-cmp-ui #accept'],
  reject: {
    firstLayer: ['[data-testid="uc-deny-all-button"]', '#usercentrics-cmp-ui #deny'],
    openPreferences: ['[data-testid="uc-more-button"]', '#usercentrics-cmp-ui #more'],
    preferencesReject: ['[data-testid="uc-deny-all-button"]', '#usercentrics-cmp-ui #deny'],
    api: 'window.UC_UI ? UC_UI.denyAllConsents() : __ucCmp.denyAllConsents()',
  },
  accept: {
    firstLayer: ['[data-testid="uc-accept-all-button"]', '#usercentrics-cmp-ui #accept'],
    api: 'window.UC_UI ? UC_UI.acceptAllConsents() : __ucCmp.acceptAllConsents()',
  },
  stateExpr: `(() => { if (!window.UC_UI || !UC_UI.getServicesBaseInfo) return null; return UC_UI.getServicesBaseInfo().map((s) => ({ name: s.name, category: s.categorySlug, essential: !!s.isEssential, consent: !!(s.consent && s.consent.status) })); })()`,
  check(state, choice) {
    const list = state as { name: string; essential: boolean; consent: boolean }[] | null;
    if (!Array.isArray(list)) return { consistent: null, detail: 'UC_UI.getServicesBaseInfo() non disponibile' };
    const on = list.filter((s) => !s.essential && s.consent).map((s) => s.name);
    if (choice === 'rifiuta') {
      return on.length ? { consistent: false, detail: `servizi non essenziali con consenso dopo il rifiuto: ${on.join(', ')}` } : { consistent: true, detail: 'nessun servizio non essenziale con consenso' };
    }
    return on.length ? { consistent: true, detail: `servizi con consenso: ${on.length}` } : { consistent: false, detail: 'nessun servizio non essenziale con consenso dopo l\'accettazione' };
  },
  async declared(page) {
    const list = await page
      .evaluate(`(() => window.UC_UI && UC_UI.getServicesBaseInfo ? UC_UI.getServicesBaseInfo().map((s) => ({ name: s.name, category: (s.categorySlug || ''), essential: !!s.isEssential })) : null)()`)
      .catch(() => null);
    if (!Array.isArray(list)) return null;
    return (list as { name: string; category: string; essential: boolean }[]).map(
      (s): DeclaredItem => ({
        kind: 'servizio',
        name: s.name,
        declaredCategory: s.category,
        category: s.essential ? 'tecnico' : normalizeDeclaredCategory(s.category),
        alwaysActive: s.essential,
        source: 'cmp:usercentrics (getServicesBaseInfo)',
      }),
    );
  },
});
