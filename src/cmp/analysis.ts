import type { Page } from 'playwright';
import type { BannerAnalysis, CommandLook } from '../types.js';
import { frames, waitFor } from './dom.js';
import { TEXTS, clickCandidate, scan, type Candidate } from './heuristic.js';
import { findRevokeControl } from './revoke.js';
import type { CmpAdapter } from './types.js';

const POLICY_TEXT = /cookie|privacy|informativa|policy|trattamento dei dati/i;
const CLOSE_LIKE = /^(×|✕|✖|x|chiudi|close|dismiss)$/i;

/** Classifica i pulsanti del primo livello del banner per funzione. */
function classify(candidates: Candidate[]) {
  const pick = (re: RegExp) => [...new Set(candidates.filter((c) => re.test(c.text)).map((c) => c.text))];
  return {
    accept: pick(TEXTS.accept),
    reject: pick(TEXTS.reject),
    preferences: pick(TEXTS.preferences),
    close: pick(CLOSE_LIKE),
    all: [...new Set(candidates.map((c) => c.text))],
  };
}

/**
 * Analisi della struttura del banner, oltre al comportamento: pulsanti al primo livello, link alla cookie policy,
 * categorie pre-attivate nel secondo livello, presenza di un modo per riaprire le preferenze.
 * Da eseguire a fine sessione, dopo aver fermato la raccolta: aprire le preferenze non deve alterare i dati.
 */
export async function analyzeBanner(page: Page, adapters: CmpAdapter[], shot: (label: string) => Promise<void>): Promise<BannerAnalysis> {
  const { banner, candidates } = await scan(page);
  const firstLayer = classify(candidates);
  const policy = candidates.find((c) => c.href && POLICY_TEXT.test(c.text));

  // Modo per riaprire le preferenze nella pagina, fuori dal banner (gli elementi del banner sono marcati dallo scan).
  let revoke: BannerAnalysis['revokeLink'] = null;
  for (const f of frames(page)) {
    revoke = await findRevokeControl(f);
    if (revoke) break;
  }

  // Evidenza visiva dei comandi di accettazione e rifiuto (prima di toccare altro)
  const lookOf = async (c: Candidate | undefined) => (c ? measure(c).catch(() => null) : null);
  const prominence = {
    accept: await lookOf(candidates.find((c) => TEXTS.accept.test(c.text))),
    reject: await lookOf(candidates.find((c) => TEXTS.reject.test(c.text))),
  };

  // Fondo della pagina (di solito il footer, dove sta il link per rivedere la scelta): fotografato come prova.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {});
  await page.waitForTimeout(800);
  await shot('3-footer');
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  // Secondo livello: si apre "Preferenze/Personalizza" e si leggono gli interruttori delle categorie, senza salvare.
  let preferences: BannerAnalysis['preferences'] = null;
  const prefsButton = candidates.find((c) => TEXTS.preferences.test(c.text));
  if (banner && prefsButton) {
    try {
      const opened = await clickCandidate(prefsButton);
      await page.waitForTimeout(1500);
      let toggles: { label: string; checked: boolean; disabled: boolean }[] = [];
      await waitFor(
        async () => {
          toggles = [];
          for (const f of frames(page)) toggles.push(...(await readToggles(f, f === page.mainFrame()).catch(() => [])));
          // Lo stesso interruttore può comparire due volte (es. versione mobile e desktop del pannello)
          toggles = toggles.filter((t, i) => toggles.findIndex((x) => x.label === t.label && x.checked === t.checked) === i);
          return toggles.length > 0;
        },
        4000,
        500,
      );
      await shot('4-preferenze');
      // Anche nel pannello: evidenza di "Consenti tutti" rispetto a "Rifiuta tutti"
      const inner = (await scan(page)).candidates;
      const prom = {
        accept: await lookOf(inner.find((c) => TEXTS.accept.test(c.text))),
        reject: await lookOf(inner.find((c) => TEXTS.preferencesReject.test(c.text) || TEXTS.reject.test(c.text))),
      };
      preferences = { opened: true, via: opened, toggles, prominence: prom };
    } catch (e) {
      preferences = { opened: false, via: (e as Error).message.split('\n')[0], toggles: [] };
    }
  }

  return {
    bannerVisible: banner,
    cmp: adapters.filter((a) => a.id !== 'tcf').map((a) => a.name),
    firstLayer,
    policyLink: policy ? { text: policy.text, href: policy.href ?? '' } : null,
    revokeLink: revoke,
    preferences,
    prominence,
  };
}

/** Misure oggettive di un comando: dimensioni, testo, sfondo e contrasto (formula WCAG 2.x). */
async function measure(c: Candidate): Promise<CommandLook | null> {
  return c.frame
    .locator(`[data-scookie-c="${c.index}"]`)
    .first()
    .evaluate((el, text) => {
      const parse = (v: string) => {
        const m = v.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const [r, g, b, a = '1'] = m[1].split(/[\s,/]+/).filter(Boolean);
        return { r: +r, g: +g, b: +b, a: +a };
      };
      const lum = (c: { r: number; g: number; b: number }) => {
        const f = (x: number) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const own = parse(s.backgroundColor);
      const hasBg = !!own && own.a > 0.1;
      const hasBorder = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && (parse(s.borderTopColor)?.a ?? 0) > 0.1;
      // sfondo effettivo: il primo antenato con uno sfondo non trasparente
      let bg: { r: number; g: number; b: number } | null = null;
      for (let n: Element | null = el; n && !bg; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0.5) bg = c;
      }
      bg ??= { r: 255, g: 255, b: 255 };
      const fg = parse(s.color);
      // contenitore del banner: l'antenato più esterno sovrapposto alla pagina (fixed/sticky) o con ruolo di finestra
      let root: Element = el;
      for (let n: Element | null = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const st = getComputedStyle(n);
        if (st.position === 'fixed' || st.position === 'sticky' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true') root = n;
      }
      const rr = root.getBoundingClientRect();
      const box = (x: DOMRect) => ({ x: Math.round(x.left), y: Math.round(x.top), w: Math.round(x.width), h: Math.round(x.height) });
      const contrast = fg ? (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05) : null;
      return {
        text,
        kind: hasBg || hasBorder ? ('pulsante' as const) : ('link' as const),
        width: Math.round(r.width),
        height: Math.round(r.height),
        fontSize: Math.round(parseFloat(s.fontSize)),
        fontWeight: parseInt(s.fontWeight, 10) || 400,
        color: fg ? hex(fg) : s.color,
        background: hasBg && own ? hex(own) : null,
        contrast: contrast ? Math.round(contrast * 10) / 10 : null,
        box: box(r),
        container: root === el ? undefined : box(rr),
      };
    }, c.text);
}

/**
 * Interruttori e caselle delle categorie visibili (anche in shadow DOM), con etichetta, stato e blocco.
 * Nella pagina principale solo quelli dentro l'interfaccia del gestore del consenso: le altre caselle
 * (es. moduli del sito) non c'entrano. Nei frame si leggono tutti: un frame del CMP è tutto interfaccia di consenso.
 */
export async function readToggles(frame: import('playwright').Frame, isMain: boolean): Promise<{ label: string; checked: boolean; disabled: boolean; index?: number }[]> {
  return frame.evaluate((isMain) => {
    // Contenitori dei CMP noti: se uno è visibile, si leggono solo i suoi interruttori (non il resto della pagina)
    const KNOWN = ['#onetrust-pc-sdk', '#CybotCookiebotDialog', '#didomi-host', '#usercentrics-root', '#s-cnt', '#cc-main .pm', '.cky-preference-center', '#cmplz-cookiebanner-container', '#hs-modal', '#hs-eu-cookie-confirmation', '.iubenda-cs-preferences', '#iubenda-cs-banner'];
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
    };
    const known = KNOWN.flatMap((sel) => Array.from(document.querySelectorAll(sel))).filter(shown);
    const CONSENT_UI = /cookie|consent|onetrust|optanon|\bot-|\bcmp|privacy|gdpr|hs-eu|hs-banner|hs-modal|cky|cmplz|didomi|usercentrics|\buc-|iubenda|cc_div|cc-main|cybot|klaro|tarteaucitron/i;
    const inConsentUi = (el: Element): boolean => {
      if (known.length) {
        // dentro un contenitore noto (anche attraverso lo shadow DOM)
        for (let n: Node | null = el; n; n = (n as Element).parentElement ?? ((n.getRootNode() as ShadowRoot).host || null)) {
          if (known.includes(n as Element)) return true;
        }
        return false;
      }
      let n: Node | null = el;
      while (n) {
        if (n instanceof Element) {
          const sig = `${n.id} ${typeof n.className === 'string' ? n.className : ''}`;
          if (CONSENT_UI.test(sig) || n.getAttribute('aria-modal') === 'true' || n.getAttribute('role') === 'dialog' || n.hasAttribute('data-scookie-c')) return true;
          // banner e pannelli di consenso sconosciuti sono quasi sempre sovrapposti alla pagina
          if (n !== document.body && n !== document.documentElement && getComputedStyle(n).position === 'fixed') return true;
        }
        n = (n as Element).parentElement ?? ((n.getRootNode() as ShadowRoot).host || null);
      }
      return false;
    };
    const all: Element[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of Array.from(root.querySelectorAll('input[type="checkbox"], [role="switch"], [role="checkbox"]'))) {
        // marcature di una lettura precedente: andrebbero a confondersi con quelle nuove
        el.removeAttribute('data-scookie-t');
        all.push(el);
      }
      for (const el of Array.from(root.querySelectorAll('*'))) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    const visible = (el: Element) => {
      // Le caselle "vere" sono spesso nascoste dietro un interruttore grafico: si guarda anche il contenitore.
      const target = (el as HTMLInputElement).labels?.[0] ?? el.parentElement ?? el;
      const r = target.getBoundingClientRect();
      const s = getComputedStyle(target);
      return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const labelOf = (el: Element): string => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        if (t) return t;
      }
      const lab = (el as HTMLInputElement).labels?.[0]?.textContent?.trim();
      if (lab) return lab;
      // testo del contenitore più vicino che abbia un titolo
      let p: Element | null = el.parentElement;
      for (let i = 0; p && i < 4; i++, p = p.parentElement) {
        const h = p.querySelector('h3, h4, h5, strong, [class*="title"], [class*="name"], [class*="header"]');
        if (h?.textContent?.trim()) return h.textContent.trim();
      }
      return '(senza etichetta)';
    };
    // Gli interruttori sono marcati (data-scookie-t) per poterli poi impostare nello scenario "personalizza"
    const toggles: { label: string; checked: boolean; disabled: boolean; index?: number }[] = all
      .filter((el) => visible(el) && (!isMain || inConsentUi(el)))
      .map((el, index) => {
        const input = el as HTMLInputElement;
        const checked = input.type === 'checkbox' ? input.checked : el.getAttribute('aria-checked') === 'true';
        const disabled = input.disabled || el.getAttribute('aria-disabled') === 'true';
        el.setAttribute('data-scookie-t', String(index));
        return { label: labelOf(el).replace(/\s+/g, ' ').slice(0, 80), checked, disabled, index };
      });
    // Categorie senza interruttore ma con la dicitura "Sempre attivi" (es. OneTrust): attive e non modificabili
    for (const el of Array.from(document.querySelectorAll('span, div, p, strong, em, label'))) {
      const t = ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
      if (!/^(sempre attiv[aeio]|always active)$/i.test(t) || !visible(el) || (isMain && !inConsentUi(el))) continue;
      const label = labelOf(el).replace(/\s+/g, ' ').slice(0, 80);
      if (!toggles.some((x) => x.label === label)) toggles.push({ label, checked: true, disabled: true });
    }
    // Interruttori senza etichetta (es. legittimo interesse) solo se non ce ne sono di etichettati
    return toggles.some((x) => x.label !== '(senza etichetta)') ? toggles.filter((x) => x.label !== '(senza etichetta)') : toggles;
  }, isMain);
}
