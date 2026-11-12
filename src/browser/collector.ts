import type { BrowserContext, Frame, Page, Request, Response } from 'playwright';
import type { Classifier } from '../classify/classifier.js';
import type { CookieRecord, Phase, RequestRecord, Stage, StorageRecord } from '../types.js';
import { hostOf, type PartyResolver } from '../util/domains.js';
import { readableFrame } from '../cmp/dom.js';
import { preview, withTimeout } from '../util/misc.js';

/** Attesa massima per leggere lo storage di un frame. */
const FRAME_TIMEOUT_MS = 5000;
import { detectPii, maskPii } from '../util/pii.js';
import { SENTRY_INGEST } from '../classify/enrich.js';

/** Parametri di consenso nelle richieste Google e IAB, utili come evidenza. */
const CONSENT_PARAMS = ['gcs', 'gcd', 'npa', 'dma', 'dma_cps', 'gdpr', 'gdpr_consent', 'us_privacy', 'pscd'];

/** Endpoint di raccolta noti: se compaiono su un dominio proprio indicano probabile tagging lato server. */
const SERVER_SIDE_PATHS: { re: RegExp; label: string }[] = [
  { re: /\/g\/collect\b/, label: 'endpoint GA4 (/g/collect)' },
  { re: /\/j\/collect\b|\/r\/collect\b/, label: 'endpoint Universal Analytics (/j/collect)' },
  { re: /\/mp\/collect\b/, label: 'Measurement Protocol (/mp/collect)' },
  { re: /\/gtm\.js\b/, label: 'Google Tag Manager servito da dominio proprio (/gtm.js)' },
  { re: /\/gtag\/js\b/, label: 'gtag.js servito da dominio proprio' },
  { re: /\/collect\b.*[?&]tid=/, label: 'endpoint di raccolta con parametro tid' },
];

/**
 * Raccoglie richieste, cookie e storage di un contesto browser, marcando ogni elemento
 * con la fase (prima/dopo la scelta sul banner) e la pagina su cui è comparso.
 */
export class Collector {
  phase: Phase = 'prima';
  stage: Stage = 'caricamento';
  choiceEpoch: number | null = null;
  private stageBeforeChoice: Stage = 'caricamento';
  currentUrl = '';
  readonly requests: (RequestRecord & { epoch: number })[] = [];
  private readonly cookies = new Map<string, CookieRecord>();
  /** Ultimo valore e scadenza visti per ogni cookie: un cambiamento dopo la scelta è una nuova scrittura. */
  private readonly cookieState = new Map<string, string>();
  private readonly storage = new Map<string, StorageRecord>();
  private readonly byRequest = new WeakMap<Request, RequestRecord>();
  private seq = 0;
  /** Documento principale caricato in ogni scheda (aggiornato al commit della navigazione). */
  private readonly committedTop = new WeakMap<Page, string>();
  /** Per ogni iframe, il documento principale che lo ospitava quando è stato caricato. */
  private readonly frameTop = new WeakMap<Frame, string>();
  /** Navigazione della pagina principale avviata e non ancora confermata: il documento corrente sta per uscire. */
  private navPending = false;
  /**
   * Visite di pagina della sessione, nell'ordine: indirizzo, inizio del caricamento e prima interazione simulata
   * (mouse o rotella). Il momento "al caricamento" / "dopo lo scroll" si misura rispetto alla pagina in cui avviene.
   */
  readonly visits: { url: string; at: string; interactionAt?: string }[] = [];
  /** Stadio della pagina che si sta lasciando: gli invii all'uscita appartengono a quella pagina, non alla nuova. */
  private leavingStage: Stage = 'caricamento';

  constructor(
    private readonly context: BrowserContext,
    private readonly party: PartyResolver,
    private readonly classifier: Classifier,
  ) {
    for (const p of context.pages()) this.watch(p);
    context.on('page', (p) => this.watch(p));
    context.on('request', (r) => this.onRequest(r));
    context.on('requestfailed', (req) => {
      const rec = this.byRequest.get(req);
      if (rec) rec.failure = req.failure()?.errorText ?? 'errore sconosciuto';
    });
    context.on('response', (res) => {
      const rec = this.byRequest.get(res.request());
      if (rec) rec.status = res.status();
      this.noteSetCookie(res);
    });
  }

  /**
   * Scritture di cookie viste nelle intestazioni Set-Cookie delle risposte, per nome: dicono il momento esatto della
   * scrittura. I cookie si leggono a intervalli (dopo ogni pagina): senza questo, un cookie scritto poco prima della
   * scelta e letto dopo risulterebbe "dopo la scelta". Non aggiungono cookie: un Set-Cookie può essere rifiutato dal
   * browser, quindi conta solo ciò che il browser ha davvero memorizzato.
   */
  private readonly setCookieSeen = new Map<string, { epoch: number; domain: string; phase: Phase; stage: Stage; url: string }[]>();
  /** Inizio della lettura precedente: una scrittura più vecchia riguarda un cookie che allora non c'era già più. */
  private prevSnapshotEpoch = 0;

  private noteSetCookie(res: Response) {
    if (this.paused) return;
    const epoch = Date.now();
    const { phase, stage } = this;
    const url = this.currentUrl;
    let host: string;
    try {
      host = new URL(res.url()).hostname.toLowerCase();
    } catch {
      return;
    }
    void res
      .headerValues('set-cookie')
      .then((values) => {
        for (const v of values) {
          const name = v.slice(0, Math.max(0, v.indexOf('='))).trim();
          if (!name) continue;
          const lower = v.toLowerCase();
          // cancellazioni (scadenza nel passato): non sono scritture
          if (/;\s*max-age=\s*(0|-\d+)\s*(;|$)/.test(lower)) continue;
          const exp = /;\s*expires=([^;]+)/.exec(lower)?.[1];
          if (exp && Date.parse(exp) < epoch) continue;
          const domain = (/;\s*domain=\.?([^;\s]+)/.exec(lower)?.[1] ?? host).replace(/\.$/, '');
          const list = this.setCookieSeen.get(name) ?? [];
          list.push({ epoch, domain, phase, stage, url });
          this.setCookieSeen.set(name, list);
        }
      })
      .catch(() => {
        // risposta non più disponibile (pagina chiusa): resta il momento della lettura
      });
  }

  private watch(p: Page) {
    p.on('framenavigated', (f) => {
      if (f === p.mainFrame()) {
        this.committedTop.set(p, f.url());
        this.navPending = false;
      } else this.frameTop.set(f, p.mainFrame().url());
    });
  }

  /** Inizio di una navigazione della pagina principale verso `url`: fino al commit il documento corrente è in uscita. */
  beginNavigation(url: string) {
    this.navPending = true;
    this.currentUrl = url;
    this.leavingStage = this.stage;
    // Pagina nuova, nessuna interazione ancora: prima della scelta si torna "al caricamento" (lo scroll della pagina
    // precedente non vale per questa). Dopo la scelta o la revoca lo stadio resta quello.
    if (this.phase === 'prima' && this.stage === 'scroll') this.stage = 'caricamento';
    this.visits.push({ url: maskPii(url), at: new Date().toISOString() });
  }

  /** Navigazione non riuscita: nessun documento in uscita. */
  endNavigation() {
    this.navPending = false;
  }

  /**
   * Pagina che ospita il contenuto che ha generato la richiesta (letta al momento della richiesta, dal frame) e, se
   * la richiesta parte da un documento che si sta lasciando (pagehide/unload, o tra l'inizio della navigazione e il
   * commit della nuova pagina), la pagina da cui si esce.
   */
  private origin(r: Request): { page: string | null; exit: boolean; frameUrl?: string } {
    let f: Frame;
    try {
      f = r.frame();
    } catch {
      return { page: null, exit: false }; // service worker
    }
    const p = f.page();
    const committed = this.committedTop.get(p);
    const isMain = f === p.mainFrame();
    const isNav = r.isNavigationRequest();
    // la richiesta che carica la nuova pagina principale appartiene alla nuova pagina
    if (isMain && isNav) return { page: null, exit: false };
    const top = isMain ? committed : (this.frameTop.get(f) ?? committed);
    if (!top || !/^https?:/.test(top)) return { page: null, exit: false };
    const exit = f.isDetached() || (!!committed && top !== committed) || (this.navPending && top === committed);
    const doc = isMain ? '' : f.url();
    return { page: top, exit, ...(/^https?:/.test(doc) ? { frameUrl: doc } : {}) };
  }

  markChoice() {
    this.phase = 'dopo';
    this.stageBeforeChoice = this.stage;
    this.stage = 'scelta';
    this.choiceEpoch = Date.now();
  }

  /** Revoca del consenso: da qui in poi gli elementi sono "dopo la revoca". */
  revokeEpoch: number | null = null;
  markRevoke() {
    this.stage = 'revoca';
    this.revokeEpoch = Date.now();
  }

  /** Primo caricamento di pagina dopo la revoca: le richieste da qui in poi sono raccolta sulle pagine successive. */
  revokeNavEpoch: number | null = null;
  markRevokeNav() {
    this.revokeNavEpoch = Date.now();
  }

  /** Da chiamare prima di scorrere la pagina: se non c'è stata una scelta, si passa allo stadio "scroll". */
  /** Ferma la raccolta: ciò che avviene dopo (es. apertura delle preferenze per l'analisi del banner) non è registrato. */
  paused = false;
  pause() {
    this.paused = true;
  }

  markScroll() {
    const v = this.visits[this.visits.length - 1];
    if (v && !v.interactionAt) v.interactionAt = new Date().toISOString();
    if (this.stage === 'caricamento') this.stage = 'scroll';
  }

  /** Annulla la marcatura se la scelta non è stata eseguita: tutto resta "prima". */
  undoChoice() {
    if (this.choiceEpoch === null) return;
    const since = this.choiceEpoch;
    const back = this.stageBeforeChoice;
    for (const r of this.requests) {
      if (r.epoch >= since) {
        r.phase = 'prima';
        r.stage = back;
      }
    }
    for (const list of this.setCookieSeen.values()) {
      for (const w of list) {
        if (w.epoch < since) continue;
        w.phase = 'prima';
        w.stage = back;
      }
    }
    for (const x of [...this.cookies.values(), ...this.storage.values()]) {
      x.phase = 'prima';
      if (Date.parse(x.firstSeenAt) >= since) x.stage = back;
    }
    this.phase = 'prima';
    this.stage = back;
    this.choiceEpoch = null;
  }

  private onRequest(r: Request) {
    if (this.paused) return;
    const url = r.url();
    if (!/^https?:/.test(url)) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const host = parsed.hostname.toLowerCase();
    const party = this.party.party(host);
    const now = Date.now();
    const rec: RequestRecord & { epoch: number } = {
      seq: ++this.seq,
      at: new Date(now).toISOString(),
      epoch: now,
      msFromChoice: null,
      // dati personali nell'indirizzo: nei dati e nel report solo mascherati (il valore completo resta nel HAR)
      url: maskPii(url),
      host,
      method: r.method(),
      resourceType: r.resourceType(),
      party,
      phase: this.phase,
      stage: this.stage,
      pageUrl: maskPii(this.currentUrl),
      status: null,
    };
    const from = this.origin(r);
    if (from.page) rec.pageUrl = maskPii(from.page);
    if (from.exit) {
      rec.sentOnExit = true;
      // inviata all'uscita dalla pagina precedente: vale il momento di quella pagina (es. dopo lo scroll)
      if (this.navPending && rec.phase === 'prima') rec.stage = this.leavingStage;
    }
    if (this.visits.length) rec.visit = from.exit && this.navPending ? this.visits.length - 2 : this.visits.length - 1;
    if (from.frameUrl) rec.frameUrl = maskPii(from.frameUrl);
    const t = this.classifier.classifyHost(host, parsed.pathname, parsed.search);
    if (t) rec.tracker = { company: t.azienda, category: t.categoria };
    const params: Record<string, string> = {};
    let body = '';
    try {
      body = r.postData() ?? '';
    } catch {
      // corpo binario
    }
    for (const p of CONSENT_PARAMS) {
      const v = parsed.searchParams.get(p) ?? new URLSearchParams(body.split('\n')[0]).get(p);
      if (v !== null && v !== '') params[p] = preview(v, 60);
    }
    if (Object.keys(params).length) rec.consentParams = params;
    // Envelope di Sentry: i tipi degli elementi (righe di intestazione JSON) dicono se c'è una registrazione della sessione
    if (body && SENTRY_INGEST.test(host)) {
      const items = [...new Set([...body.matchAll(/^\{[^\n]*?"type":"([a-z_]+)"/gm)].map((m) => m[1]))];
      if (items.length) rec.envelopeItems = items;
    }
    const pii = detectPii(url, body);
    if (pii.length) rec.pii = pii;
    if (party === 'prima') {
      const hit = SERVER_SIDE_PATHS.find((s) => s.re.test(parsed.pathname + parsed.search));
      if (hit) rec.serverSide = hit.label;
    }
    if (r.serviceWorker()) rec.fromServiceWorker = true;
    this.byRequest.set(r, rec);
    this.requests.push(rec);
  }

  /** Fotografa cookie (inclusi HttpOnly) e storage di tutti i frame, registrando i nuovi elementi. */
  async snapshot(page: Page) {
    if (this.paused) return;
    const now = new Date().toISOString();
    const since = this.prevSnapshotEpoch;
    this.prevSnapshotEpoch = Date.now();
    for (const c of await this.context.cookies()) {
      const key = `${c.name}|${c.domain}|${c.path}`;
      const state = `${c.value}|${c.expires}`;
      const prev = this.cookieState.get(key);
      this.cookieState.set(key, state);
      const known = this.cookies.get(key);
      if (known) {
        // Già presente prima della scelta (o, dopo la revoca, scritto durante il consenso): si registra se c'è ancora
        // e se è stato riscritto o rinnovato
        if (this.phase === 'dopo' && (known.phase === 'prima' || (this.stage === 'revoca' && known.stage !== 'revoca'))) {
          if (known.phase === 'prima') known.presentAfterChoice = true;
          if (prev !== undefined && prev !== state && !known.renewals?.some((r) => r.stage === this.stage)) {
            known.renewals = [...(known.renewals ?? []), { stage: this.stage, at: now, url: maskPii(this.currentUrl), expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null }];
          }
        }
        continue;
      }
      // momento della scrittura dall'intestazione Set-Cookie, se la risposta che lo ha scritto è stata vista
      const bare = c.domain.replace(/^\./, '').toLowerCase();
      const written = this.setCookieSeen.get(c.name)?.find((w) => w.epoch >= since && w.domain === bare);
      this.cookies.set(key, {
        name: c.name,
        domain: c.domain,
        path: c.path,
        expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        party: this.party.party(c.domain),
        phase: written?.phase ?? this.phase,
        stage: written?.stage ?? this.stage,
        firstSeenUrl: maskPii(written?.url ?? this.currentUrl),
        firstSeenAt: written ? new Date(written.epoch).toISOString() : now,
        valuePreview: preview(maskPii(c.value)),
        classification: this.classifier.classifyName(c.name, c.domain),
      });
    }
    for (const f of page.frames()) {
      if (!readableFrame(f)) continue;
      // Un frame che non risponde (es. a metà di una navigazione) non deve bloccare la sessione
      const data = await withTimeout(
        f.evaluate(() => {
          const read = (s: Storage) => {
            const out: [string, string][] = [];
            for (let i = 0; i < s.length; i++) {
              const k = s.key(i);
              if (k !== null) out.push([k, s.getItem(k) ?? '']);
            }
            return out;
          };
          try {
            return { origin: location.origin, local: read(localStorage), session: read(sessionStorage) };
          } catch {
            return null;
          }
        }),
        FRAME_TIMEOUT_MS,
        'lettura dello storage del frame',
      ).catch(() => null);
      if (!data || !data.origin || data.origin === 'null') continue;
      const host = hostOf(data.origin);
      for (const [kind, entries] of [['localStorage', data.local], ['sessionStorage', data.session]] as const) {
        for (const [k, v] of entries) {
          const key = `${data.origin}|${kind}|${k}`;
          if (this.storage.has(key)) continue;
          this.storage.set(key, {
            origin: data.origin,
            kind,
            key: k,
            valuePreview: preview(maskPii(v)),
            party: this.party.party(host),
            phase: this.phase,
            stage: this.stage,
            firstSeenUrl: maskPii(this.currentUrl),
            firstSeenAt: now,
            classification: this.classifier.classifyName(k, host),
          });
        }
      }
    }
  }

  results() {
    const choice = this.choiceEpoch;
    const revoke = this.revokeEpoch;
    const requests: RequestRecord[] = this.requests.map(({ epoch, ...r }) => ({
      ...r,
      msFromChoice: choice === null ? null : epoch - choice,
      ...(revoke !== null && epoch >= revoke ? { msFromRevoke: epoch - revoke } : {}),
      ...(this.revokeNavEpoch !== null && epoch >= this.revokeNavEpoch ? { afterRevokeNav: true } : {}),
    }));
    return { cookies: [...this.cookies.values()], storage: [...this.storage.values()], requests, visits: this.visits };
  }
}
