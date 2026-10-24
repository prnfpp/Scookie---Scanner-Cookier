import type { Frame, Page } from 'playwright';
import type { ChoiceLayer, DeclaredItem } from '../types.js';

export type Choice = 'rifiuta' | 'accetta';

export interface ChoiceResult {
  ok: boolean;
  layer: ChoiceLayer | null;
  via: 'click' | 'api' | null;
  detail: string;
}

export interface ConsentCheck {
  /** true = lo stato corrisponde alla scelta, false = incoerente, null = non determinabile. */
  consistent: boolean | null;
  detail: string;
}

/**
 * Adattatore per un gestore del consenso noto.
 * Ogni adattatore è un modulo a sé: per aggiungerne uno basta crearlo e registrarlo in registry.ts.
 */
export interface CmpAdapter {
  id: string;
  name: string;
  /** True se il CMP è presente sulla pagina (API JavaScript o elementi DOM). */
  detect(page: Page): Promise<boolean>;
  /** True se il banner del CMP è visibile. */
  bannerVisible(page: Page): Promise<boolean>;
  /**
   * Esegue la scelta. In modalità "click" usa i pulsanti reali (come farebbe l'utente);
   * in modalità "api" chiama l'API del CMP, usata solo come ultimo ripiego.
   * Ritorna null se l'adattatore non supporta la modalità (es. TCF, che espone solo lo stato).
   */
  choose(page: Page, choice: Choice, mode: 'click' | 'api'): Promise<ChoiceResult | null>;
  /** Stato del consenso letto dal CMP, da registrare come evidenza. */
  consentState(page: Page): Promise<unknown>;
  /** Verifica che lo stato registrato dopo la scelta corrisponda alla scelta. */
  checkConsent(state: unknown, choice: Choice): ConsentCheck;
  /** Elenco dichiarato letto dal CMP, se disponibile. */
  declared?(page: Page): Promise<DeclaredItem[] | null>;
}

export type FrameLike = Page | Frame;
