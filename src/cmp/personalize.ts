import type { Locator, Page } from 'playwright';
import { normalizeDeclaredCategory } from '../classify/classifier.js';
import { readToggles } from './analysis.js';
import { clickFirst, describeElement, findVisible, frames, waitFor, type ClickedElement } from './dom.js';
import { TEXTS, clickCandidate, scan } from './heuristic.js';
import type { ChoiceResult, ConsentCheck } from './types.js';

/**
 * Scenario "personalizza": accettare solo la categoria statistica e verificare che parta solo quella.
 * Implementato solo per i CMP in cui la scelta per categoria si può eseguire e verificare in modo affidabile.
 */
export interface Personalizer {
  /** Esegue la scelta: modalità click (come un utente) o API (ripiego, dichiarato nel report). */
  choose(page: Page, mode: 'click' | 'api'): Promise<ChoiceResult | null>;
  /** Verifica sullo stato registrato dal CMP: solo statistica attiva. */
  check(page: Page): Promise<ConsentCheck>;
}

const STATS_RE = /statist|analytic|analitic|prestazion|performance|misurazion|measurement/i;

/** Imposta una casella o un interruttore, anche quando l'input è nascosto dietro un elemento grafico. */
async function setToggle(page: Page, input: Locator, on: boolean): Promise<string | null> {
  if ((await input.count()) === 0) return null;
  const el = input.first();
  const checked = await el.isChecked().catch(() => null);
  if (checked === on) return null;
  const label = await describeElement(el);
  try {
    await el.setChecked(on, { force: true, timeout: 3000 });
  } catch {
    const id = await el.getAttribute('id');
    const forLabel = id ? page.locator(`label[for="${id}"]`).first() : null;
    if (forLabel && (await forLabel.count())) await forLabel.click({ force: true, timeout: 3000 });
    else await el.click({ force: true, timeout: 3000 });
  }
  return `${on ? 'attivazione' : 'disattivazione'} di ${label}`;
}

const result = (via: 'click' | 'api', detail: string, clicked: string[]): ChoiceResult => ({ ok: true, layer: 'secondo-livello', via, detail, clicked });

/* ---------------- OneTrust ---------------- */

interface OtGroupInfo {
  id: string;
  name: string;
  always: boolean;
  size: number;
}

async function otGroups(page: Page): Promise<OtGroupInfo[]> {
  return page
    .evaluate(`(() => {
      const d = window.OneTrust && OneTrust.GetDomainData ? OneTrust.GetDomainData() : null;
      const out = [];
      const walk = (g) => {
        out.push({ id: String(g.OptanonGroupId || ''), name: g.GroupName || '', always: /always/i.test(String(g.Status || '')), size: (g.Cookies || []).length + (g.FirstPartyCookies || []).length + (g.Hosts || []).length });
        (g.SubGroups || []).forEach(walk);
      };
      ((d && d.Groups) || []).forEach(walk);
      return out;
    })()`)
    .then((x) => x as OtGroupInfo[])
    .catch(() => []);
}

const statsGroup = (groups: OtGroupInfo[]) =>
  groups.find((g) => !g.always && g.size > 0 && STATS_RE.test(g.name) && normalizeDeclaredCategory(g.name) === 'statistica');

const onetrust: Personalizer = {
  async choose(page, mode) {
    const groups = await otGroups(page);
    const stats = statsGroup(groups);
    if (!stats) return { ok: false, layer: null, via: null, detail: 'nessuna categoria statistica separata e rifiutabile nella configurazione OneTrust' };
    const others = groups.filter((g) => !g.always && g.size > 0 && g.id !== stats.id);
    if (mode === 'api') {
      const ok = await page
        .evaluate(`(() => { OneTrust.RejectAll(); OneTrust.UpdateConsent('Category', '${stats.id}:1'); return true; })()`)
        .catch(() => false);
      return ok ? result('api', `OneTrust.RejectAll() e UpdateConsent('Category', '${stats.id}:1')`, []) : null;
    }
    const open = await clickFirst(page, ['#onetrust-pc-btn-handler', '.ot-sdk-show-settings']);
    if (!open) return { ok: false, layer: null, via: null, detail: 'pulsante delle preferenze OneTrust non trovato' };
    const steps: string[] = [open.label];
    await waitFor(async () => !!(await findVisible(page, '#onetrust-pc-sdk')), 5000, 300);
    const s = await setToggle(page, page.locator(`#onetrust-pc-sdk input#ot-group-id-${stats.id}`), true);
    if (s) steps.push(s);
    for (const g of others) {
      const o = await setToggle(page, page.locator(`#onetrust-pc-sdk input#ot-group-id-${g.id}`), false);
      if (o) steps.push(o);
    }
    const save = await clickFirst(page, ['#onetrust-pc-sdk .save-preference-btn-handler']);
    if (!save) return { ok: false, layer: null, via: null, detail: 'pulsante "Conferma le mie scelte" OneTrust non trovato' };
    steps.push(save.label);
    return result('click', `categoria "${stats.name}" (${stats.id}) attivata, le altre lasciate disattive`, steps);
  },
  async check(page) {
    const groups = await otGroups(page);
    const stats = statsGroup(groups);
    const active = String((await page.evaluate('window.OnetrustActiveGroups || window.OptanonActiveGroups || ""').catch(() => '')) ?? '')
      .split(',')
      .filter(Boolean);
    if (!stats) return { consistent: null, detail: 'categoria statistica non identificata' };
    const others = groups.filter((g) => !g.always && g.size > 0 && g.id !== stats.id && active.includes(g.id));
    if (!active.includes(stats.id)) return { consistent: false, detail: `la categoria "${stats.name}" non risulta attiva (attivi: ${active.join(', ')})` };
    return others.length
      ? { consistent: false, detail: `risultano attive anche: ${others.map((g) => `"${g.name}"`).join(', ')}` }
      : { consistent: true, detail: `attiva solo "${stats.name}" tra le categorie rifiutabili (attivi: ${active.join(', ')})` };
  },
};

/* ---------------- Cookiebot ---------------- */

const CB = {
  stats: '#CybotCookiebotDialogBodyLevelButtonStatistics, #CybotCookiebotDialogBodyLevelButtonStatisticsInline',
  prefs: '#CybotCookiebotDialogBodyLevelButtonPreferences, #CybotCookiebotDialogBodyLevelButtonPreferencesInline',
  mkt: '#CybotCookiebotDialogBodyLevelButtonMarketing, #CybotCookiebotDialogBodyLevelButtonMarketingInline',
};

const cookiebot: Personalizer = {
  async choose(page, mode) {
    if (mode === 'api') {
      const ok = await page.evaluate('(window.Cookiebot || window.CookieConsent).submitCustomConsent(false, true, false), true').catch(() => false);
      return ok ? result('api', 'Cookiebot.submitCustomConsent(preferenze: no, statistica: sì, marketing: no)', []) : null;
    }
    const steps: string[] = [];
    // Le caselle possono essere al primo livello o nella scheda "Dettagli/Personalizza".
    if (!(await findVisible(page, CB.stats))) {
      const open = await clickFirst(page, ['#CybotCookiebotDialogBodyLevelButtonCustomize', '#CybotCookiebotDialogNavDetails']);
      if (open) steps.push(open.label);
      await waitFor(async () => !!(await findVisible(page, CB.stats)), 4000, 300);
    }
    const stat = await setToggle(page, page.locator(CB.stats).filter({ visible: true }), true);
    if (stat === null && !(await page.locator(CB.stats).count())) return { ok: false, layer: null, via: null, detail: 'casella "Statistiche" di Cookiebot non trovata' };
    if (stat) steps.push(stat);
    for (const sel of [CB.prefs, CB.mkt]) {
      const o = await setToggle(page, page.locator(sel).filter({ visible: true }), false);
      if (o) steps.push(o);
    }
    const save = await clickFirst(page, ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection', '#CybotCookiebotDialogBodyButtonAcceptSelected']);
    if (!save) return { ok: false, layer: null, via: null, detail: 'pulsante "Consenti la selezione" di Cookiebot non trovato' };
    steps.push(save.label);
    return result('click', 'solo la categoria statistica selezionata', steps);
  },
  async check(page) {
    const c = (await page
      .evaluate('(() => { const c = (window.Cookiebot || window.CookieConsent || {}).consent; return c ? { p: c.preferences, s: c.statistics, m: c.marketing } : null; })()')
      .catch(() => null)) as { p: boolean; s: boolean; m: boolean } | null;
    if (!c) return { consistent: null, detail: 'Cookiebot.consent non leggibile' };
    if (!c.s) return { consistent: false, detail: 'la categoria statistica non risulta accettata' };
    return c.p || c.m
      ? { consistent: false, detail: `risultano accettate anche: ${[c.p && 'preferenze', c.m && 'marketing'].filter(Boolean).join(', ')}` }
      : { consistent: true, detail: 'accettata solo la categoria statistica' };
  },
};

/* ---------------- vanilla-cookieconsent ---------------- */

const vanilla: Personalizer = {
  async choose(page, mode) {
    if (mode === 'api') return null;
    const steps: string[] = [];
    const open: ClickedElement | null = await clickFirst(page, [
      '#cc_div #cm [data-cc="c-settings"]',
      '#cc_div #cm #c-s-bn:text-matches("impostaz|preferenz|personalizz|gestisci|settings|customi", "i")',
      '#cc-main .cm [data-role="show"]',
    ]);
    if (!open) return { ok: false, layer: null, via: null, detail: 'pulsante delle preferenze non trovato' };
    steps.push(open.label);
    const toggles = page.locator('#s-cnt input.c-tgl, #cc-main .pm input.section__toggle');
    await waitFor(async () => (await toggles.count()) > 0, 4000, 300);
    const n = await toggles.count();
    let statsFound = false;
    for (let i = 0; i < n; i++) {
      const t = toggles.nth(i);
      if (await t.isDisabled().catch(() => false)) continue;
      const value = (await t.getAttribute('value')) ?? '';
      const block = await t.evaluate((el) => (el.closest('.c-bl, .pm__section') as HTMLElement | null)?.innerText ?? '').catch(() => '');
      const isStats = STATS_RE.test(value) || STATS_RE.test(block.split('\n')[0] ?? '');
      statsFound ||= isStats;
      const s = await setToggle(page, t, isStats);
      if (s) steps.push(s);
    }
    if (!statsFound) return { ok: false, layer: null, via: null, detail: 'nessuna categoria statistica tra le preferenze' };
    const save = await clickFirst(page, ['#s-cnt #s-sv-bn', '#cc-main .pm [data-role="save"]']);
    if (!save) return { ok: false, layer: null, via: null, detail: 'pulsante di salvataggio delle preferenze non trovato' };
    steps.push(save.label);
    return result('click', 'solo la categoria statistica selezionata', steps);
  },
  async check(page) {
    const v = (await page
      .evaluate("(() => { const m = document.cookie.match(/(?:^|; )cc_cookie=([^;]*)/); if (!m) return null; try { const x = JSON.parse(decodeURIComponent(m[1])); return x.categories || x.level || null; } catch { return null; } })()")
      .catch(() => null)) as string[] | null;
    if (!v) return { consistent: null, detail: 'cookie cc_cookie non leggibile' };
    const others = v.filter((c) => c !== 'necessary' && !STATS_RE.test(c));
    if (!v.some((c) => STATS_RE.test(c))) return { consistent: false, detail: `categoria statistica non accettata (accettate: ${v.join(', ')})` };
    return others.length ? { consistent: false, detail: `accettate anche: ${others.join(', ')}` } : { consistent: true, detail: `categorie accettate: ${v.join(', ')}` };
  },
};

/** Personalizzatori per id di adattatore. */
export const PERSONALIZERS: Record<string, Personalizer> = {
  onetrust,
  cookiebot,
  'vanilla-cookieconsent': vanilla,
};

/* ---------------- Generico (banner sconosciuti, HubSpot) ---------------- */

/**
 * Scelta per categoria tramite l'interfaccia, per i banner senza un personalizzatore dedicato: si aprono le preferenze,
 * si attiva solo la categoria statistica, si disattivano le altre modificabili e si salva. Dichiarato come euristica.
 */
export const genericPersonalizer: Personalizer = {
  async choose(page, mode) {
    if (mode === 'api') return null;
    const steps: string[] = [];
    const prefs = (await scan(page)).candidates.find((c) => TEXTS.preferences.test(c.text));
    if (!prefs) return { ok: false, layer: null, via: null, detail: 'pulsante delle preferenze non trovato nel banner' };
    steps.push(await clickCandidate(prefs));
    let found: { frame: import('playwright').Frame; t: { label: string; checked: boolean; disabled: boolean; index?: number } }[] = [];
    await waitFor(
      async () => {
        found = [];
        for (const f of frames(page)) for (const t of await readToggles(f, f === page.mainFrame()).catch(() => [])) found.push({ frame: f, t });
        return found.some((x) => x.t.index !== undefined && !x.t.disabled);
      },
      5000,
      400,
    );
    const editable = found.filter((x) => x.t.index !== undefined && !x.t.disabled);
    if (!editable.some((x) => STATS_RE.test(x.t.label))) return { ok: false, layer: null, via: null, detail: `nessuna categoria statistica tra le preferenze (${editable.map((x) => x.t.label).join(', ') || 'nessun interruttore'})` };
    for (const { frame, t } of editable) {
      const want = STATS_RE.test(t.label);
      if (t.checked === want) continue;
      const el = frame.locator(`[data-scookie-t="${t.index}"]`).first();
      await el.click({ force: true, timeout: 3000 }).catch(() => el.evaluate((n) => (n as HTMLElement).click()));
      steps.push(`${want ? 'attivazione' : 'disattivazione'} di "${t.label}"`);
    }
    const save = (await scan(page)).candidates.find((c) => TEXTS.preferencesSave.test(c.text));
    if (!save) return { ok: false, layer: null, via: null, detail: 'pulsante per salvare le preferenze non trovato' };
    steps.push(await clickCandidate(save));
    return result('click', 'solo la categoria statistica selezionata (euristica sull\'interfaccia)', steps);
  },
  async check(page) {
    // HubSpot registra le categorie nel cookie __hs_cookie_cat_pref (1 statistica, 2 pubblicità, 3 funzionalità)
    const pref = (await page.evaluate("(document.cookie.match(/(?:^|; )__hs_cookie_cat_pref=([^;]*)/) || [])[1] || null").catch(() => null)) as string | null;
    if (pref) {
      const v = Object.fromEntries(decodeURIComponent(pref).split(/[_,]/).map((x) => x.split(':')));
      if (v['1'] !== 'true') return { consistent: false, detail: `HubSpot: categoria statistica non accettata (${pref})` };
      return v['2'] === 'true' ? { consistent: false, detail: `HubSpot: accettata anche la pubblicità (${pref})` } : { consistent: true, detail: `HubSpot: ${pref}` };
    }
    return { consistent: null, detail: 'stato del consenso non leggibile: la scelta si verifica sul traffico osservato' };
  },
};
