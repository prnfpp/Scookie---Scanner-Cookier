import type { Page } from 'playwright';
import type { DeclaredItem } from '../../types.js';
import { anyVisible, clickFirst, waitFor, type ClickedElement } from '../dom.js';
import { TEXTS } from '../heuristic.js';
import type { CmpAdapter, Choice, ChoiceResult, ConsentCheck } from '../types.js';

/**
 * Descrizione dichiarativa di un CMP basato su selettori.
 * Le espressioni JavaScript sono stringhe valutate nella pagina.
 */
export interface SelectorCmpSpec {
  id: string;
  name: string;
  /** Espressione JS che vale true se il CMP è caricato. */
  detectExpr: string;
  /** Selettori che identificano il CMP nel DOM. */
  detectSelectors: string[];
  /** Selettori di un banner visibile (primo livello). */
  bannerSelectors: string[];
  reject: {
    firstLayer: string[];
    /** Pulsante X / "continua senza accettare". */
    close?: string[];
    openPreferences?: string[];
    preferencesReject?: string[];
    /** Espressione JS di ripiego che rifiuta tramite API. */
    api?: string;
  };
  accept: {
    firstLayer: string[];
    api?: string;
  };
  /** Espressione JS che restituisce lo stato del consenso (serializzabile). */
  stateExpr: string;
  check(state: unknown, choice: Choice): ConsentCheck;
  declared?(page: Page): Promise<DeclaredItem[] | null>;
  /** Espressione JS che riapre il banner (per la revoca). */
  reopenExpr?: string;
}

async function evalExpr<T>(page: Page, expr: string): Promise<T | null> {
  try {
    return (await page.evaluate(expr)) as T;
  } catch {
    return null;
  }
}

export function selectorAdapter(spec: SelectorCmpSpec): CmpAdapter {
  const bannerVisible = (page: Page) => anyVisible(page, spec.bannerSelectors);

  const clicked = (layer: ChoiceResult['layer'], ...els: ClickedElement[]): ChoiceResult => ({
    ok: true,
    layer,
    via: 'click',
    detail: els.map((e) => `click su ${e.label} (${e.selector})`).join(', poi '),
    clicked: els.map((e) => e.label),
  });

  return {
    id: spec.id,
    name: spec.name,
    async detect(page) {
      if (await evalExpr<boolean>(page, `(() => { try { return !!(${spec.detectExpr}); } catch { return false; } })()`)) return true;
      // Basta la presenza nel DOM: il banner può essere nascosto se il consenso è già stato dato.
      return (await page.locator(spec.detectSelectors.join(', ')).count().catch(() => 0)) > 0;
    },
    bannerVisible,
    ...(spec.reopenExpr
      ? {
          async reopen(page: Page) {
            return (await evalExpr(page, `(() => { ${spec.reopenExpr}; return true; })()`)) !== null;
          },
        }
      : {}),
    async choose(page, choice, mode) {
      if (mode === 'api') {
        const api = choice === 'accetta' ? spec.accept.api : spec.reject.api;
        if (!api) return null;
        return (await evalExpr(page, `(() => { ${api}; return true; })()`)) !== null
          ? { ok: true, layer: null, via: 'api', detail: `scelta eseguita via API del CMP: ${api}` }
          : { ok: false, layer: null, via: null, detail: `chiamata API non riuscita: ${api}` };
      }
      if (choice === 'accetta') {
        const sel = await clickFirst(page, spec.accept.firstLayer);
        if (sel) return clicked('primo-livello', sel);
        return { ok: false, layer: null, via: null, detail: 'pulsante "Accetta" non trovato' };
      }
      const first = await clickFirst(page, spec.reject.firstLayer);
      if (first) return clicked('primo-livello', first);
      const close = spec.reject.close && (await clickFirst(page, spec.reject.close));
      // Un pulsante di chiusura con un testo di rifiuto (es. OneTrust "Continua senza accettare") è un rifiuto al primo livello.
      if (close) return clicked(TEXTS.reject.test(/"([^"]+)"/.exec(close.label)?.[1]?.trim() ?? '') ? 'primo-livello' : 'chiusura-x', close);
      // Pannello delle preferenze già aperto (es. riaperto dal link nel footer per revocare): si rifiuta lì
      if (spec.reject.preferencesReject) {
        const direct = await clickFirst(page, spec.reject.preferencesReject);
        if (direct) return clicked('secondo-livello', direct);
      }
      if (spec.reject.openPreferences && spec.reject.preferencesReject) {
        const open = await clickFirst(page, spec.reject.openPreferences);
        if (open) {
          let inner: ClickedElement | null = null;
          await waitFor(async () => !!(inner = await clickFirst(page, spec.reject.preferencesReject!)), 5000, 400);
          if (inner) return clicked('secondo-livello', open, inner);
        }
      }
      return { ok: false, layer: null, via: null, detail: 'pulsante "Rifiuta" non trovato né al primo né al secondo livello' };
    },
    async consentState(page) {
      return evalExpr(page, `(() => { try { return ${spec.stateExpr}; } catch (e) { return { errore: String(e) }; } })()`);
    },
    checkConsent: spec.check,
    declared: spec.declared,
  };
}

/** Utility per le verifiche: categorie attive in un elenco con ID noti. */
export function consentFromFlags(
  flags: Record<string, unknown> | null | undefined,
  nonEssentialKeys: string[],
  choice: Choice,
): ConsentCheck {
  if (!flags || typeof flags !== 'object') return { consistent: null, detail: 'stato del consenso non leggibile' };
  const on = nonEssentialKeys.filter((k) => flags[k] === true);
  if (choice === 'rifiuta') {
    return on.length
      ? { consistent: false, detail: `dopo il rifiuto risultano attive: ${on.join(', ')}` }
      : { consistent: true, detail: `nessuna categoria non necessaria attiva (${nonEssentialKeys.join(', ')})` };
  }
  return on.length
    ? { consistent: true, detail: `categorie attive: ${on.join(', ')}` }
    : { consistent: false, detail: 'dopo l\'accettazione nessuna categoria non necessaria risulta attiva' };
}

/** Espressione JS che restituisce i cookie leggibili da document.cookie come oggetto nome → valore. */
export const COOKIE_MAP_EXPR = `Object.fromEntries(document.cookie.split('; ').filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }))`;
