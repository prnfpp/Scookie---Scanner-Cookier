import type { Frame, Page } from 'playwright';
import { frames } from './dom.js';
import { frameRole } from './heuristic.js';

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
  // Complianz: pulsante "Gestisci consenso" (classi cmplz-manage-consent manage-consent-N), visibile dopo la scelta
  '.cmplz-manage-consent',
  '[class*="cmplz-manage-consent"]',
  '.cmplz-btn[class*="manage-consent-"]',
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

/**
 * Comando di revoca nella pagina (fuori dal banner), cercato nella pagina e negli iframe del gestore, non nei
 * contenuti incorporati. Molti gestori lo mostrano solo dopo la scelta: va cercato anche allora.
 */
export async function findRevokeInPage(page: Page): Promise<{ text: string; how: string; frame: Frame } | null> {
  for (const f of frames(page)) {
    if ((await frameRole(f).catch(() => 'other')) === 'other') continue;
    const r = await findRevokeControl(f);
    if (r) return { ...r, frame: f };
  }
  return null;
}

/** Pulsante che salva un modulo di preferenze (non quello che accetta tutto). */
const SAVE_RE = /^(salva|conferma|applica|aggiorna|save|confirm|apply|update)\b.{0,40}$/i;
const ACCEPT_RE = /accett|consenti|allow|accept|agree/i;
/** Opzione "spento" di un gruppo di pulsanti di scelta (es. On / Off). */
const OFF_RE = /^(off|no|disattiv[ao]|disabilita(to)?|rifiut[ao]|nego|non acconsento|deny|reject|disabled?)$/i;

/**
 * Pagina di preferenze propria del sito (es. /preferenze-cookies con interruttori "On/Off" e "Salva preferenze"),
 * fuori dal banner del gestore: disattiva le categorie modificabili e salva, come farebbe un utente. Non tocca le
 * categorie bloccate (necessarie) né i pulsanti che accettano tutto.
 */
export async function rejectOnPreferencesPage(page: Page): Promise<{ ok: boolean; steps: string[]; detail: string }> {
  for (const f of frames(page)) {
    const found = await f
      .evaluate(
        ({ saveSrc, acceptSrc, offSrc }) => {
          const saveRe = new RegExp(saveSrc, 'i');
          const acceptRe = new RegExp(acceptSrc, 'i');
          const offRe = new RegExp(offSrc, 'i');
          const shown = (el: Element | null | undefined) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
          };
          const txt = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
          const ownLabel = (el: Element) => {
            const i = el as HTMLInputElement;
            return (i.labels?.[0] ? txt(i.labels[0]) : '') || el.getAttribute('aria-label') || '';
          };
          const rowLabel = (el: Element) => txt(el.closest('li, tr, fieldset, section, [class*="categor"], [class*="cookie"], div'))?.slice(0, 60) || ownLabel(el);
          const marked: { label: string; how: string }[] = [];
          const mark = (el: Element, how: string) => {
            el.setAttribute('data-scookie-off', String(marked.length));
            marked.push({ label: rowLabel(el), how });
          };
          for (const el of Array.from(document.querySelectorAll('input[type=checkbox], [role=switch], [role=checkbox]'))) {
            const input = el as HTMLInputElement;
            const visible = shown(el) || shown(input.labels?.[0]) || shown(el.parentElement);
            const checked = el.matches('input') ? input.checked : el.getAttribute('aria-checked') === 'true';
            const disabled = (el.matches('input') && input.disabled) || el.getAttribute('aria-disabled') === 'true';
            if (visible && checked && !disabled) mark(el, 'disattivazione');
          }
          for (const el of Array.from(document.querySelectorAll('input[type=radio]'))) {
            const input = el as HTMLInputElement;
            const visible = shown(el) || shown(input.labels?.[0]) || shown(el.parentElement);
            if (visible && !input.checked && !input.disabled && offRe.test(ownLabel(el))) mark(el, `scelta di "${ownLabel(el)}"`);
          }
          const save = Array.from(document.querySelectorAll('button, [role=button], input[type=submit], input[type=button], a')).find((b) => {
            const t = txt(b) || (b as HTMLInputElement).value || '';
            return shown(b) && saveRe.test(t) && !acceptRe.test(t);
          });
          if (save) save.setAttribute('data-scookie-save', '1');
          return { marked, save: save ? (txt(save) || (save as HTMLInputElement).value || '').slice(0, 60) : null };
        },
        { saveSrc: SAVE_RE.source, acceptSrc: ACCEPT_RE.source, offSrc: OFF_RE.source },
      )
      .catch(() => null);
    if (!found?.save) continue;
    const steps: string[] = [];
    for (let k = 0; k < found.marked.length; k++) {
      const el = f.locator(`[data-scookie-off="${k}"]`).first();
      await el.click({ timeout: 3000 }).catch(() => el.click({ timeout: 3000, force: true }).catch(() => el.evaluate((n) => (n as HTMLElement).click()).catch(() => {})));
      steps.push(`${found.marked[k].how} di "${found.marked[k].label}"`);
    }
    if (!steps.length) steps.push('nessuna categoria da disattivare (già tutte spente o bloccate)');
    const save = f.locator('[data-scookie-save]').first();
    await save.click({ timeout: 5000 }).catch(() => save.click({ timeout: 5000, force: true }).catch(() => {}));
    steps.push(`click su "${found.save}"`);
    return { ok: true, steps, detail: steps.join(', ') };
  }
  return { ok: false, steps: [], detail: 'nessun pulsante per salvare le preferenze nella pagina' };
}
