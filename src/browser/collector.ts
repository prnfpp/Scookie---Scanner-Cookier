import type { BrowserContext, Page, Request } from 'playwright';
import type { Classifier } from '../classify/classifier.js';
import type { CookieRecord, Phase, RequestRecord, Stage, StorageRecord } from '../types.js';
import { hostOf, type PartyResolver } from '../util/domains.js';
import { preview } from '../util/misc.js';

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
  private readonly storage = new Map<string, StorageRecord>();
  private readonly byRequest = new WeakMap<Request, RequestRecord>();
  private seq = 0;

  constructor(
    private readonly context: BrowserContext,
    private readonly party: PartyResolver,
    private readonly classifier: Classifier,
  ) {
    context.on('request', (r) => this.onRequest(r));
    context.on('requestfailed', (req) => {
      const rec = this.byRequest.get(req);
      if (rec) rec.failure = req.failure()?.errorText ?? 'errore sconosciuto';
    });
    context.on('response', (res) => {
      const rec = this.byRequest.get(res.request());
      if (rec) rec.status = res.status();
    });
  }

  markChoice() {
    this.phase = 'dopo';
    this.stageBeforeChoice = this.stage;
    this.stage = 'scelta';
    this.choiceEpoch = Date.now();
  }

  /** Da chiamare prima di scorrere la pagina: se non c'è stata una scelta, si passa allo stadio "scroll". */
  markScroll() {
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
    for (const x of [...this.cookies.values(), ...this.storage.values()]) {
      x.phase = 'prima';
      if (Date.parse(x.firstSeenAt) >= since) x.stage = back;
    }
    this.phase = 'prima';
    this.stage = back;
    this.choiceEpoch = null;
  }

  private onRequest(r: Request) {
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
      url,
      host,
      method: r.method(),
      resourceType: r.resourceType(),
      party,
      phase: this.phase,
      stage: this.stage,
      pageUrl: this.currentUrl,
      status: null,
    };
    const t = this.classifier.classifyHost(host, parsed.pathname);
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
    if (party === 'prima') {
      const hit = SERVER_SIDE_PATHS.find((s) => s.re.test(parsed.pathname + parsed.search));
      if (hit) rec.serverSide = hit.label;
    }
    this.byRequest.set(r, rec);
    this.requests.push(rec);
  }

  /** Fotografa cookie (inclusi HttpOnly) e storage di tutti i frame, registrando i nuovi elementi. */
  async snapshot(page: Page) {
    const now = new Date().toISOString();
    for (const c of await this.context.cookies()) {
      const key = `${c.name}|${c.domain}|${c.path}`;
      if (this.cookies.has(key)) continue;
      this.cookies.set(key, {
        name: c.name,
        domain: c.domain,
        path: c.path,
        expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        party: this.party.party(c.domain),
        phase: this.phase,
        stage: this.stage,
        firstSeenUrl: this.currentUrl,
        firstSeenAt: now,
        valuePreview: preview(c.value),
        classification: this.classifier.classifyName(c.name, c.domain),
      });
    }
    for (const f of page.frames()) {
      if (f.isDetached()) continue;
      const data = await f
        .evaluate(() => {
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
        })
        .catch(() => null);
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
            valuePreview: preview(v),
            party: this.party.party(host),
            phase: this.phase,
            stage: this.stage,
            firstSeenUrl: this.currentUrl,
            firstSeenAt: now,
            classification: this.classifier.classifyName(k, host),
          });
        }
      }
    }
  }

  results() {
    const choice = this.choiceEpoch;
    const requests: RequestRecord[] = this.requests.map(({ epoch, ...r }) => ({
      ...r,
      msFromChoice: choice === null ? null : epoch - choice,
    }));
    return { cookies: [...this.cookies.values()], storage: [...this.storage.values()], requests };
  }
}
