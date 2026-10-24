// Tipi condivisi tra raccolta, regole e report.

export type ScenarioName = 'nessuna-azione' | 'rifiuta' | 'accetta';

/** Momento rispetto alla scelta sul banner. */
export type Phase = 'prima' | 'dopo';

/**
 * Momento preciso in cui un elemento compare:
 * - caricamento: pagina caricata, nessuna interazione dell'utente;
 * - scroll: dopo lo scroll della pagina, senza alcuna scelta sul banner;
 * - scelta: dopo il click sul banner.
 * Separare lo scroll serve per i banner che (illegittimamente) lo trattano come consenso.
 */
export type Stage = 'caricamento' | 'scroll' | 'scelta';

export const STAGE_LABEL: Record<Stage, string> = {
  caricamento: 'al caricamento, senza interazioni',
  scroll: 'dopo lo scroll della pagina, senza scelta sul banner',
  scelta: 'dopo la scelta sul banner',
};

export type Party = 'prima' | 'terza';

/** Categoria normalizzata usata in tutto il tool. */
export type Category =
  | 'tecnico'
  | 'funzionalita'
  | 'statistica'
  | 'marketing'
  | 'registrazione-sessioni'
  | 'social'
  | 'sconosciuta';

export const NON_TECHNICAL: ReadonlySet<Category> = new Set([
  'statistica',
  'marketing',
  'registrazione-sessioni',
  'social',
]);

export interface Classification {
  category: Category;
  source: string; // es. "open-cookie-database", "elenco-tracker", "nessuna"
  platform?: string;
}

export interface CookieRecord {
  name: string;
  domain: string;
  path: string;
  /** Scadenza come data ISO, oppure null per i cookie di sessione. */
  expires: string | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  party: Party;
  phase: Phase;
  stage: Stage;
  /** Pagina su cui il cookie è stato osservato per la prima volta. */
  firstSeenUrl: string;
  firstSeenAt: string;
  valuePreview: string;
  classification: Classification;
}

export interface StorageRecord {
  origin: string;
  kind: 'localStorage' | 'sessionStorage';
  key: string;
  valuePreview: string;
  party: Party;
  phase: Phase;
  stage: Stage;
  firstSeenUrl: string;
  firstSeenAt: string;
  classification: Classification;
}

export interface RequestRecord {
  seq: number;
  at: string;
  /** Millisecondi rispetto al click sul banner (negativi = prima). Null se nessun click. */
  msFromChoice: number | null;
  url: string;
  host: string;
  method: string;
  resourceType: string;
  party: Party;
  phase: Phase;
  stage: Stage;
  pageUrl: string;
  status: number | null;
  tracker?: { company: string; category: Category };
  /** Parametri di consenso Google (gcs, gcd, npa) se presenti. */
  consentParams?: Record<string, string>;
  /** Endpoint di raccolta riconosciuto su un dominio proprio (probabile server-side tagging). */
  serverSide?: string;
  /** Motivo del fallimento, se la richiesta non ha ricevuto risposta (es. net::ERR_TIMED_OUT). */
  failure?: string;
}

export type ChoiceLayer = 'primo-livello' | 'secondo-livello' | 'chiusura-x';

export interface InteractionReport {
  /** Metodo che ha eseguito la scelta: "manuale", "adattatore:onetrust", "euristica", "nessuno". */
  method: string;
  /** CMP riconosciuti sulla pagina. */
  detectedCmps: string[];
  outcome: 'eseguito' | 'non-trovato' | 'non-applicabile' | 'errore';
  layer: ChoiceLayer | null;
  /** Come è stata eseguita: click su un elemento o chiamata API del CMP. */
  via: 'click' | 'api' | null;
  /** Descrizione leggibile, es. "click su #onetrust-reject-all-handler". */
  detail: string;
  /** Esito della verifica dello stato di consenso dopo la scelta. */
  verification: 'verificato' | 'incoerente' | 'non-verificabile' | 'non-applicabile';
  verificationDetail: string;
  consentStateBefore?: unknown;
  consentStateAfter?: unknown;
  bannerVisibleBefore: boolean;
  bannerVisibleAfter: boolean | null;
}

export interface Evidence {
  label: string;
  file: string; // percorso relativo alla cartella dell'esecuzione
}

export interface SessionResult {
  id: string;
  site: string; // origine, es. https://www.esempio.it
  registrableDomain: string;
  scenario: ScenarioName;
  pageType: string;
  pages: string[];
  startedAt: string;
  endedAt: string;
  choiceAt: string | null;
  interaction: InteractionReport;
  cookies: CookieRecord[];
  storage: StorageRecord[];
  requests: RequestRecord[];
  screenshots: Evidence[];
  har: string | null;
  errors: string[];
  /** Se la sessione è la ripetizione di un'altra, l'id di quella scartata. */
  retryOf?: string;
}

export interface DeclaredItem {
  kind: 'cookie' | 'servizio';
  name: string;
  domain?: string;
  /** Categoria come scritta nel banner/policy. */
  declaredCategory: string;
  /** Categoria normalizzata. */
  category: Category;
  alwaysActive: boolean;
  source: string; // "cmp:onetrust", "file:dichiarati.csv"
}

export interface DeclaredSet {
  site: string;
  source: string | null;
  items: DeclaredItem[];
  note?: string;
}

export interface ComparisonRow {
  site: string;
  name: string;
  domain: string;
  kind: 'cookie' | 'storage' | 'servizio';
  status: 'dichiarato' | 'non-dichiarato' | 'dichiarato-non-osservato';
  declaredCategories: string[];
  declaredAlwaysActive: boolean;
  observedCategory: Category | null;
  categoryIssue: 'incoerente' | 'categorie-multiple' | null;
  scenarios: ScenarioName[];
}

export type Severity = 'alta' | 'media' | 'bassa' | 'informativa';

export interface NormRef {
  key: string;
  title: string;
  reference: string;
  url?: string;
}

export interface Finding {
  id: string; // C-001
  ruleId: string;
  ruleTitle: string;
  severity: Severity;
  site: string;
  scenario: ScenarioName | null;
  pageUrl: string | null;
  /** Descrizione fattuale di cosa succede (nessuna indicazione correttiva). */
  description: string;
  details: string[];
  evidence: Evidence[];
  /** Estratto della richiesta dal HAR, se pertinente. */
  requestExcerpt?: Record<string, unknown>;
  norms: NormRef[];
}
