import type { Page } from 'playwright';
import { maskPii, registerTypedValue } from '../util/pii.js';
import type { Collector } from './collector.js';
import { RECORDER, type RecordedStep } from './replay.js';

export interface ManualPlan {
  /** Istruzioni mostrate all'operatore (es. "compila il preventivo con la targa di prova AB123CD"). */
  instructions: string;
  maxMs: number;
  /** Host del sito del controllo: il riquadro avvisa l'operatore quando la pagina è su un altro sito. */
  siteHost?: string;
  /** Promemoria aggiuntivo nel riquadro (es. i dati inseriti nella navigazione precedente, da riusare). */
  hint?: string;
}

export interface ManualOutcome {
  instructions: string;
  /** Pagine visitate dall'operatore, nell'ordine. */
  pages: string[];
  endedBy: 'operatore' | 'tempo' | 'pagina-chiusa';
  seconds: number;
  /** Azioni dell'operatore (clic e campi compilati), per rigiocare il percorso in automatico. */
  steps: RecordedStep[];
  /** Pagine che hanno risposto con un errore (es. 404) durante la navigazione. */
  errorPages?: { url: string; status: number }[];
  /** Numero di schede aperte durante la navigazione (oltre la prima). */
  extraTabs?: number;
}

/**
 * Riquadro con le istruzioni e il pulsante "Ho finito", in shadow DOM per non interferire con la pagina.
 * Costruito con le API del DOM e stili impostati da script: le Content-Security-Policy dei siti bloccano gli
 * attributi style e innerHTML, e il riquadro comparirebbe senza formattazione o non comparirebbe. Dove possibile
 * sta nel top layer (popover), sopra i banner; con una finestra modale del sito aperta si sposta dentro di essa,
 * altrimenti non sarebbe cliccabile. Se la pagina lo rimuove, si rimonta.
 * Su schermi piccoli resta dentro la finestra: il pulsante "Ho finito" è in alto, il testo scorre, e il riquadro si
 * può ridurre a una barra o spostare in alto se copre il contenuto. Indica se la pagina è sul sito del controllo.
 */
const OVERLAY = (instructions: string, siteHost: string, extra: string) => `(() => {
  const css = (el, st) => { for (const [k, v] of Object.entries(st)) el.style.setProperty(k, v, 'important'); return el; };
  const SITE = ${JSON.stringify(siteHost)};
  const bare = (h) => String(h || '').replace(/^www\\./, '');
  const onSite = () => !SITE || bare(location.hostname) === bare(SITE);
  let small = false;
  try { small = sessionStorage.getItem('__scookieMini') === '1'; } catch {}
  let top = false;
  try { top = sessionStorage.getItem('__scookieTop') === '1'; } catch {}
  const place = (host) => css(host, top
    ? { position: 'fixed', top: '8px', left: '8px', bottom: 'auto', right: 'auto', inset: '8px auto auto 8px', 'z-index': '2147483647', margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible' }
    : { position: 'fixed', bottom: '8px', left: '8px', top: 'auto', right: 'auto', inset: 'auto auto 8px 8px', 'z-index': '2147483647', margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible' });
  const make = () => {
    const host = document.createElement('div');
    host.id = 'scookie-operatore';
    place(host);
    const root = host.attachShadow({ mode: 'open' });
    const box = css(document.createElement('div'), { font: '13px/1.35 -apple-system, system-ui, sans-serif', background: '#1d1d1f', color: '#fff', padding: '10px 12px', 'border-radius': '8px', width: 'min(340px, calc(100vw - 16px))', 'max-height': 'calc(100vh - 16px)', 'overflow-y': 'auto', 'box-sizing': 'border-box', 'box-shadow': '0 4px 16px rgba(0,0,0,.3)', 'text-align': 'left' });
    const bar = css(document.createElement('div'), { display: 'flex', 'align-items': 'center', gap: '6px', 'flex-wrap': 'wrap' });
    const btn = css(document.createElement('button'), { font: 'inherit', 'font-weight': '600', background: '#34c759', color: '#000', border: '0', 'border-radius': '6px', padding: '6px 14px', cursor: 'pointer', display: 'inline-block' });
    btn.type = 'button';
    btn.textContent = 'Ho finito';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.textContent = 'Chiusura…';
      if (window.__scookieFatto) window.__scookieFatto();
    }, true);
    const tool = (label, title, fn) => {
      const b = css(document.createElement('button'), { font: 'inherit', background: '#3a3a3c', color: '#fff', border: '0', 'border-radius': '6px', padding: '6px 9px', cursor: 'pointer' });
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); }, true);
      return b;
    };
    const title = css(document.createElement('strong'), { color: '#fff', 'flex': '1 1 auto' });
    title.textContent = 'Scookie';
    const where = css(document.createElement('p'), { margin: '8px 0 4px', 'font-weight': '600' });
    const body = css(document.createElement('div'), {});
    const p1 = css(document.createElement('p'), { margin: '4px 0', color: '#fff' });
    p1.textContent = ${JSON.stringify(instructions)};
    const p2 = css(document.createElement('p'), { margin: '4px 0', color: '#bbb' });
    p2.textContent = 'Non toccare il banner dei cookie. Tutto ciò che accade viene registrato. Se apri una pagina sbagliata (es. errore 404) puoi tornare indietro: anche il ritorno viene registrato.';
    body.append(p1, p2);
    if (${JSON.stringify(extra)}) {
      const p3 = css(document.createElement('p'), { margin: '4px 0', color: '#ffd60a' });
      p3.textContent = ${JSON.stringify(extra)};
      body.append(p3);
    }
    const render = () => {
      body.style.setProperty('display', small ? 'none' : 'block', 'important');
      where.style.setProperty('display', small && onSite() ? 'none' : 'block', 'important');
      where.textContent = onSite() ? 'Sei su ' + location.hostname + ': il sito del controllo.' : 'Sei su ' + location.hostname + ', non su ' + SITE + ': ciò che accade qui sarà attribuito a ' + location.hostname + '. Il percorso deve arrivare su ' + SITE + '.';
      where.style.setProperty('color', onSite() ? '#34c759' : '#ff9f0a', 'important');
    };
    const mini = tool(small ? '▢' : '–', 'Riduci o espandi il riquadro', () => {
      small = !small;
      try { sessionStorage.setItem('__scookieMini', small ? '1' : '0'); } catch {}
      mini.textContent = small ? '▢' : '–';
      render();
    });
    const move = tool('↕', 'Sposta il riquadro in alto o in basso', () => {
      top = !top;
      try { sessionStorage.setItem('__scookieTop', top ? '1' : '0'); } catch {}
      place(host);
    });
    bar.append(btn, title, mini, move);
    box.append(bar, where, body);
    root.append(box);
    render();
    host.__render = render;
    return host;
  };
  let host = null;
  const mount = () => {
    if (!document.body || window.__scookieStop) return;
    // una finestra modale del sito rende inerte il resto della pagina: il riquadro si sposta dentro di essa
    let modal = null;
    try { modal = document.querySelector('dialog:modal'); } catch {}
    const target = modal || document.body;
    if (!host) host = make();
    if (host.parentNode !== target) {
      target.appendChild(host);
      if (typeof host.showPopover === 'function') {
        try { host.popover = 'manual'; host.showPopover(); } catch {}
      }
    }
    host.removeAttribute('inert');
    host.removeAttribute('aria-hidden');
    if (host.__render) host.__render();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  setInterval(mount, 500);
})()`;

/**
 * Navigazione manuale: l'operatore percorre a mano un flusso che il tool non sa ripercorrere (es. un preventivo
 * con moduli), nella finestra del browser. La raccolta continua come nelle sessioni automatiche; la sessione
 * finisce quando l'operatore preme "Ho finito", allo scadere del tempo massimo o quando chiude tutte le schede.
 * Le schede aperte dal sito (link con target="_blank", finestre del preventivo) fanno parte della stessa
 * navigazione: le pagine, le azioni e i cookie si registrano anche lì, e chiudere una scheda non chiude la sessione.
 * `driver` (solo test) simula l'operatore.
 * Restituisce anche la scheda attiva alla fine, per lo screenshot finale.
 */
export async function manualJourney(
  page: Page,
  collector: Collector,
  plan: ManualPlan,
  driver?: (page: Page) => Promise<void>,
  /** Riceve la funzione che chiude la sessione (pulsante "Ho finito" dell'interfaccia), poi null a sessione chiusa. */
  onFinisher?: (finish: (() => void) | null) => void,
): Promise<ManualOutcome & { lastPage: Page }> {
  const started = Date.now();
  const context = page.context();
  const pages: string[] = [maskPii(page.url())];
  const errorPages: { url: string; status: number }[] = [];
  let finish: (by: ManualOutcome['endedBy']) => void = () => {};
  const done = new Promise<ManualOutcome['endedBy']>((r) => (finish = r));

  // sul contesto, non sulla pagina: il pulsante funziona anche nelle schede aperte dal sito
  await context.exposeBinding('__scookieFatto', () => finish('operatore')).catch(() => {});
  onFinisher?.(() => finish('operatore'));
  // registrazione delle azioni dell'operatore, per poter rigiocare il percorso nelle esecuzioni successive
  const steps: RecordedStep[] = [];
  await context
    .exposeBinding('__scookieRec', (_src, step: RecordedStep) => {
      const last = steps[steps.length - 1];
      // lo stesso campo modificato più volte conta col valore finale
      if (last && step.type === 'fill' && last.type === 'fill' && last.css === step.css) steps[steps.length - 1] = step;
      else steps.push(step);
      if (step.type === 'fill' && step.value) registerTypedValue(step.value, `${step.css} ${step.text}`);
    })
    .catch(() => {});
  const overlay = OVERLAY(plan.instructions, plan.siteHost ?? '', plan.hint ?? '');
  await context.addInitScript(RECORDER);
  await page.evaluate(RECORDER).catch(() => {});
  await context.addInitScript(overlay);
  await page.evaluate(overlay).catch(() => {});

  // Schede: la pagina attiva è l'ultima aperta o l'ultima che ha navigato; la sessione finisce quando sono tutte chiuse
  const open = new Set<Page>([page]);
  let active = page;
  let extraTabs = 0;
  const watch = (p: Page) => {
    p.on('framenavigated', (frame) => {
      if (frame !== p.mainFrame()) return;
      active = p;
      const url = maskPii(frame.url());
      if (url === 'about:blank') return;
      collector.currentUrl = url;
      if (pages[pages.length - 1] !== url) pages.push(url);
    });
    p.on('response', (res) => {
      const req = res.request();
      if (req.frame() !== p.mainFrame() || req.resourceType() !== 'document' || res.status() < 400) return;
      errorPages.push({ url: maskPii(res.url()), status: res.status() });
    });
    p.on('close', () => {
      open.delete(p);
      if (active === p) active = [...open].pop() ?? p;
      if (!open.size) finish('pagina-chiusa');
      else if (active !== p) collector.currentUrl = maskPii(active.url());
    });
  };
  watch(page);
  const onPage = (p: Page) => {
    open.add(p);
    extraTabs++;
    active = p;
    watch(p);
  };
  context.on('page', onPage);
  // Fotografia periodica di cookie e storage, come dopo ogni pagina nelle sessioni automatiche
  const timer = setInterval(() => void collector.snapshot(active).catch(() => {}), 3000);
  const limit = setTimeout(() => finish('tempo'), plan.maxMs);
  if (driver) void driver(page).catch(() => {});

  const endedBy = await done;
  onFinisher?.(null);
  clearInterval(timer);
  clearTimeout(limit);
  context.off('page', onPage);
  for (const p of open) {
    await p
      .evaluate(() => {
        (window as unknown as { __scookieStop: boolean }).__scookieStop = true;
        document.getElementById('scookie-operatore')?.remove();
      })
      .catch(() => {});
  }
  if (endedBy !== 'pagina-chiusa') await collector.snapshot(active).catch(() => {});
  return {
    instructions: plan.instructions,
    pages,
    endedBy,
    seconds: Math.round((Date.now() - started) / 1000),
    steps,
    ...(errorPages.length ? { errorPages } : {}),
    ...(extraTabs ? { extraTabs } : {}),
    lastPage: active,
  };
}
