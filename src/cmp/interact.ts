import type { Page } from 'playwright';
import type { BannerConfig } from '../config/schema.js';
import type { InteractionReport } from '../types.js';
import { waitFor } from './dom.js';
import { heuristicBannerVisible, heuristicChoose } from './heuristic.js';
import { hasManual, manualBannerVisible, manualChoose } from './manual.js';
import { ADAPTERS } from './registry.js';
import type { CmpAdapter, Choice, ChoiceResult } from './types.js';

export async function detectCmps(page: Page): Promise<CmpAdapter[]> {
  const found: CmpAdapter[] = [];
  for (const a of ADAPTERS) if (await a.detect(page).catch(() => false)) found.push(a);
  return found;
}

export async function bannerVisible(page: Page, adapters: CmpAdapter[], banner?: BannerConfig): Promise<boolean> {
  if (banner && (await manualBannerVisible(page, banner))) return true;
  for (const a of adapters) if (await a.bannerVisible(page).catch(() => false)) return true;
  return heuristicBannerVisible(page);
}

async function readStates(page: Page, adapters: CmpAdapter[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const a of adapters) out[a.id] = await a.consentState(page).catch((e) => ({ errore: String(e) }));
  return out;
}

/**
 * Attende la comparsa del banner (molti CMP lo mostrano dopo qualche secondo),
 * rileva i CMP e restituisce lo stato iniziale. Usato anche nello scenario "nessuna azione".
 */
export async function observeBanner(page: Page, banner: BannerConfig | undefined, waitMs: number) {
  let adapters = await detectCmps(page);
  let visible = await bannerVisible(page, adapters, banner);
  if (!visible) {
    visible = await waitFor(async () => {
      adapters = await detectCmps(page);
      return bannerVisible(page, adapters, banner);
    }, waitMs, 700);
  }
  return { adapters, visible, states: await readStates(page, adapters) };
}

/**
 * Esegue la scelta seguendo l'ordine: selettori manuali (se configurati), pulsanti noti dei CMP
 * rilevati, euristica sui testi, API del CMP. Registra quale metodo ha funzionato e i tentativi falliti.
 */
export async function performChoice(
  page: Page,
  choice: Choice,
  banner: BannerConfig | undefined,
  waitAfterMs: number,
  bannerWaitMs: number,
  /** Chiamata subito prima del primo tentativo: da qui in poi la raccolta è "dopo la scelta". */
  onStart?: () => void,
): Promise<InteractionReport> {
  const { adapters, visible, states: before } = await observeBanner(page, banner, bannerWaitMs);
  onStart?.();
  const attempts: string[] = [];
  let method = 'nessuno';
  let result: ChoiceResult | null = null;
  let usedAdapter: CmpAdapter | null = null;

  const tryStep = async (name: string, fn: () => Promise<ChoiceResult | null>) => {
    if (result?.ok) return;
    try {
      const r = await fn();
      if (!r) return;
      if (r.ok) {
        result = r;
        method = name;
      } else attempts.push(`${name}: ${r.detail}`);
    } catch (e) {
      attempts.push(`${name}: errore ${(e as Error).message.split('\n')[0]}`);
    }
  };

  if (hasManual(banner, choice)) await tryStep('manuale', () => manualChoose(page, banner!, choice));
  const viaAdapters = async (mode: 'click' | 'api') => {
    for (const a of adapters) {
      await tryStep(`adattatore:${a.id}${mode === 'api' ? ' (API)' : ''}`, async () => {
        const r = await a.choose(page, choice, mode);
        if (r?.ok) usedAdapter = a;
        return r;
      });
    }
  };
  await viaAdapters('click');
  await tryStep('euristica', () => heuristicChoose(page, choice));
  // Ultimo ripiego: l'API del CMP. Il report lo indica, perché non equivale a un click dell'utente.
  await viaAdapters('api');

  const detected = adapters.map((a) => a.name);
  const res = result as ChoiceResult | null;
  if (!res) {
    return {
      method: 'nessuno',
      detectedCmps: detected,
      outcome: visible ? 'non-trovato' : 'non-applicabile',
      layer: null,
      via: null,
      detail: visible
        ? `scelta non eseguita. Tentativi: ${attempts.join(' | ') || 'nessuno'}`
        : `nessun banner visibile. Tentativi: ${attempts.join(' | ') || 'nessuno'}`,
      verification: 'non-applicabile',
      verificationDetail: '',
      consentStateBefore: before,
      bannerVisibleBefore: visible,
      bannerVisibleAfter: null,
    };
  }

  await page.waitForTimeout(waitAfterMs);
  const after = await readStates(page, adapters);
  const stillVisible = await bannerVisible(page, adapters, banner).catch(() => false);

  // Verifica: stato del CMP usato e, se presente, TCF. Una sola incoerenza basta per segnalarla.
  const checks: { by: string; consistent: boolean | null; detail: string }[] = [];
  const toCheck = adapters.filter((a) => a === usedAdapter || a.id === 'tcf' || (!usedAdapter && a.id !== 'tcf'));
  for (const a of toCheck) {
    const c = a.checkConsent(after[a.id], choice);
    checks.push({ by: a.name, ...c });
  }
  const bad = checks.filter((c) => c.consistent === false);
  const good = checks.filter((c) => c.consistent === true);
  let verification: InteractionReport['verification'];
  let verificationDetail: string;
  if (bad.length) {
    verification = 'incoerente';
    verificationDetail = bad.map((c) => `${c.by}: ${c.detail}`).join('; ');
  } else if (good.length) {
    verification = 'verificato';
    verificationDetail = good.map((c) => `${c.by}: ${c.detail}`).join('; ');
  } else {
    verification = 'non-verificabile';
    verificationDetail = stillVisible
      ? 'stato del consenso non leggibile e banner ancora visibile dopo il click'
      : 'banner non più visibile, ma stato del consenso non leggibile dal CMP';
  }
  if (stillVisible) verificationDetail += ' (banner ancora visibile dopo la scelta)';

  return {
    method,
    detectedCmps: detected,
    outcome: 'eseguito',
    layer: res.layer,
    via: res.via,
    detail: res.detail + (attempts.length ? ` (tentativi precedenti: ${attempts.join(' | ')})` : ''),
    verification,
    verificationDetail,
    consentStateBefore: before,
    consentStateAfter: after,
    bannerVisibleBefore: visible,
    bannerVisibleAfter: stillVisible,
  };
}
