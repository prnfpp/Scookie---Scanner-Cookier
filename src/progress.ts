/** Avanzamento dell'audit, per l'interfaccia: fase, sessioni fatte e totali, per sito, tempo rimanente stimato. */
export interface Progress {
  phase: 'uscita' | 'scoperta' | 'manuale' | 'automatiche' | 'report' | 'fine';
  /** Sessioni concluse e previste (le ripetizioni automatiche si aggiungono quando servono). */
  done: number;
  total: number;
  /** Cosa sta facendo adesso, in parole (es. "www.esempio.it · rifiuta"). */
  current: string | null;
  /** Attesa che non dipende dal tool: l'operatore (navigazione manuale) o la connessione. */
  waiting: 'manuale' | 'connessione' | null;
  /** Secondi rimanenti stimati (null finché il totale non è noto). */
  etaSec: number | null;
  sites: { site: string; done: number; total: number }[];
}

/** Durata ipotizzata di una sessione prima di averne misurata una. */
const DEFAULT_SESSION_SEC = 30;

export class ProgressTracker {
  private p: Progress = { phase: 'uscita', done: 0, total: 0, current: null, waiting: null, etaSec: null, sites: [] };
  private autoSec: number[] = [];
  private autoLeft = 0;

  constructor(
    private readonly emit: (p: Progress) => void,
    /** Secondi stimati per report, CSV e PDF a fine audit. */
    private readonly reportSec: number,
  ) {}

  private send() {
    const avg = this.autoSec.length ? this.autoSec.reduce((a, b) => a + b, 0) / this.autoSec.length : DEFAULT_SESSION_SEC;
    const known = this.p.phase === 'manuale' || this.p.phase === 'automatiche' || this.p.phase === 'report';
    this.p.etaSec = this.p.phase === 'fine' ? 0 : known ? Math.round(this.autoLeft * avg + (this.p.phase === 'report' ? this.reportSec / 2 : this.reportSec)) : null;
    this.emit(structuredClone(this.p));
  }

  phase(phase: Progress['phase'], current: string | null = null) {
    this.p.phase = phase;
    this.p.current = current;
    this.send();
  }

  /** Piano di un sito: sessioni previste (automatiche e manuali). */
  plan(site: string, automatic: number, manual: number) {
    this.p.sites.push({ site, done: 0, total: automatic + manual });
    this.p.total += automatic + manual;
    this.autoLeft += automatic;
    this.send();
  }

  /** Una sessione in più (ripetizione per banner assente o connessione caduta). */
  extra(site: string) {
    const s = this.p.sites.find((x) => x.site === site);
    if (s) s.total++;
    this.p.total++;
    this.autoLeft++;
    this.send();
  }

  start(current: string) {
    this.p.current = current;
    this.send();
  }

  finished(site: string, seconds: number, manual: boolean) {
    const s = this.p.sites.find((x) => x.site === site);
    if (s) s.done++;
    this.p.done++;
    if (!manual) {
      this.autoSec.push(seconds);
      this.autoLeft = Math.max(0, this.autoLeft - 1);
    }
    this.send();
  }

  wait(kind: Progress['waiting']) {
    this.p.waiting = kind;
    this.send();
  }
}
