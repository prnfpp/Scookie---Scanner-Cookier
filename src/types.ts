// Tipi condivisi tra raccolta, regole e report.

/**
 * Scenari: nessuna azione, rifiuta, accetta; personalizza (accetta solo la categoria statistica);
 * revoca (accetta, poi revoca il consenso e rifiuta); chiudi (chiude il banner con la X, senza scegliere).
 */
export type ScenarioName = 'nessuna-azione' | 'rifiuta' | 'accetta' | 'personalizza' | 'revoca' | 'chiudi';

/** Momento rispetto alla scelta sul banner. */
export type Phase = 'prima' | 'dopo';

/**
 * Momento preciso in cui un elemento compare, rispetto alla pagina in cui avviene:
 * - caricamento: prima della prima interazione simulata (mouse o rotella) su quella pagina;
 * - scroll: dopo la prima interazione simulata su quella pagina, senza alcuna scelta sul banner;
 * - scelta: dopo il click sul banner.
 * Separare lo scroll serve per i banner che (illegittimamente) lo trattano come consenso.
 */
export type Stage = 'caricamento' | 'scroll' | 'scelta' | 'revoca';

export const STAGE_LABEL: Record<Stage, string> = {
  caricamento: 'al caricamento, senza interazioni',
  scroll: 'dopo lo scroll della pagina e il movimento del mouse, senza scelta sul banner',
  scelta: 'dopo la scelta sul banner',
  revoca: 'dopo la revoca del consenso',
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
  source: string; // es. "elenco-curato", "open-cookie-database", "dominio-del-fornitore", "nessuna"
  platform?: string;
  /** Nota da mostrare nel report (es. "monitoraggio delle prestazioni: da valutare"). */
  note?: string;
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
  /**
   * Cookie già presente prima della scelta e ancora presente in una fotografia successiva alla scelta. Assente nelle
   * rilevazioni fatte con versioni precedenti alla 0.1.1 (dato non raccolto).
   */
  presentAfterChoice?: boolean;
  /** Cookie già presente prima della scelta e riscritto dopo (valore o scadenza cambiati): una voce per momento. */
  renewals?: { stage: Stage; at: string; url: string; expires: string | null }[];
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
  /** Richiesta inviata da un service worker del sito (non dalla pagina): può riferirsi a eventi precedenti. */
  fromServiceWorker?: boolean;
  /** Dati personali trovati nell'indirizzo o nel corpo (valori mascherati). */
  pii?: import('./util/pii.js').PiiHit[];
  /** Scenario "revoca": richiesta partita dopo il primo caricamento di pagina successivo alla revoca. */
  afterRevokeNav?: boolean;
  /** Scenario "revoca": millisecondi dalla revoca (msFromChoice è misurato dall'accettazione). */
  msFromRevoke?: number | null;
  url: string;
  host: string;
  method: string;
  resourceType: string;
  party: Party;
  phase: Phase;
  stage: Stage;
  /** Pagina che ospita il contenuto che ha inviato la richiesta (documento del frame al momento della richiesta). */
  pageUrl: string;
  /**
   * Richiesta inviata all'uscita dalla pagina `pageUrl` (pagehide/unload, o tra l'inizio della navigazione verso la
   * pagina successiva e il suo caricamento): non è stata generata dalla pagina successiva.
   */
  sentOnExit?: boolean;
  /** Documento dell'iframe che ha inviato la richiesta (solo per le richieste partite da un contenuto incorporato). */
  frameUrl?: string;
  /** Contenuto incorporato da cui parte la richiesta, se riconosciuto (es. il widget di prenotazione di Google Calendar). */
  embed?: string;
  /**
   * Il contenuto incorporato riunisce tutto ciò che parte dal suo documento (voce con "raggruppa" nell'elenco dei
   * domini): la richiesta appartiene a `embed` anche se va a un altro fornitore (es. Sentry caricato dal lettore).
   */
  embedGroup?: boolean;
  status: number | null;
  tracker?: { company: string; category: Category };
  /** Parametri di consenso Google (gcs, gcd, npa) se presenti. */
  consentParams?: Record<string, string>;
  /** Tipi degli elementi di un envelope di Sentry (es. "event", "transaction", "replay_event"), letti dal corpo. */
  envelopeItems?: string[];
  /** Natura della richiesta riconosciuta dallo strumento (es. Session Replay di Dynatrace, segnale di consenso UET). */
  purpose?: string;
  /** Endpoint di raccolta riconosciuto su un dominio proprio (probabile server-side tagging). */
  serverSide?: string;
  /** Motivo del fallimento, se la richiesta non ha ricevuto risposta (es. net::ERR_TIMED_OUT). */
  failure?: string;
  /** Indice della visita di pagina nella sessione (SessionResult.visits). Assente nelle rilevazioni precedenti alla 0.1.2. */
  visit?: number;
}

export interface StatsProbe {
  url: string;
  /** Comandi _paq della pagina (es. "disableCookies", "trackPageView"). */
  paq: string[];
  hasCookies: boolean | null;
  consentRequired?: boolean | null;
  source: 'pagina' | 'har';
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
  /**
   * La scelta è avvenuta su un altro sito (host), da cui la navigazione è poi arrivata qui: banner e gestore del
   * consenso descritti in questo esito sono quelli di quel sito, non di questo.
   */
  choiceOn?: string;
  /** Esito della verifica dello stato di consenso dopo la scelta. */
  verification: 'verificato' | 'diverso' | 'non-verificabile' | 'non-applicabile';
  verificationDetail: string;
  consentStateBefore?: unknown;
  consentStateAfter?: unknown;
  bannerVisibleBefore: boolean;
  bannerVisibleAfter: boolean | null;
  /** Elementi effettivamente cliccati, con testo e tipo (pulsante, link, X di chiusura). */
  clicked?: string[];
  /** Scenario "chiudi": cosa registra il gestore dopo la X. */
  closeEffect?: 'rifiuto' | 'consenso' | 'nessuna-scelta' | 'non-verificabile';
  /** Dopo la scelta (o la X): il banner ricompare alla pagina successiva (la scelta non è stata ricordata). */
  bannerOnNextPage?: boolean;
}

/** Struttura del banner osservata sulla prima pagina (sessione "nessuna azione"). */
export interface BannerAnalysis {
  bannerVisible: boolean;
  cmp: string[];
  firstLayer: { accept: string[]; reject: string[]; preferences: string[]; close: string[]; all: string[] };
  policyLink: { text: string; href: string } | null;
  /** Modo per riaprire le preferenze nella pagina, fuori dal banner. */
  revokeLink: { text: string; how: string } | null;
  /** Secondo livello: categorie con lo stato in cui si presentano, prima di qualsiasi scelta. */
  preferences: {
    opened: boolean;
    via: string;
    toggles: { label: string; checked: boolean; disabled: boolean }[];
    /** Interruttori letti non plausibili come categorie (es. troppi): il rilievo sulle categorie attive non si produce. */
    unreliable?: string;
    /** Evidenza di "Consenti tutti" e "Rifiuta tutti" nel pannello delle preferenze. */
    prominence?: { accept: CommandLook | null; reject: CommandLook | null };
  } | null;
  /** Aspetto dei comandi di accettazione e rifiuto al primo livello (misure oggettive, nessuna valutazione). */
  prominence?: { accept: CommandLook | null; reject: CommandLook | null };
}

export interface CommandLook {
  text: string;
  /** Aspetto: pulsante (con sfondo o bordo) o link/testo semplice. */
  kind: 'pulsante' | 'link';
  width: number;
  height: number;
  fontSize: number;
  fontWeight: number;
  color: string;
  /** Sfondo proprio dell'elemento, se presente. */
  background: string | null;
  /** Rapporto di contrasto WCAG tra testo e sfondo effettivo (leggibilità del testo, non evidenza del comando). */
  contrast: number | null;
  /** Posizione del comando e del contenitore del banner (pixel nella finestra). */
  box?: { x: number; y: number; w: number; h: number };
  container?: { x: number; y: number; w: number; h: number };
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
  /**
   * Visite di pagina nell'ordine: indirizzo, inizio del caricamento e prima interazione simulata (mouse o rotella),
   * se c'è stata. Assente nelle rilevazioni precedenti alla 0.1.2.
   */
  visits?: { url: string; at: string; interactionAt?: string }[];
  /**
   * Configurazione dello strumento di statistica ospitato sul sito (Matomo/Piwik) letta a fine pagina: comandi _paq
   * scritti nella pagina e hasCookies() del tracker. Prova accessoria dello stato dei cookie. Nelle rilevazioni
   * precedenti alla 0.1.2 si ricava, se possibile, dai documenti nel file HAR (source "har").
   */
  statsProbe?: StatsProbe[];
  /** Scenario "revoca": come è stato revocato il consenso e quali cookie non tecnici restavano nel browser. */
  revocation?: { outcome: 'eseguita' | 'non-trovata'; how: string; via: 'link' | 'pagina' | 'api' | null; remaining: string[] };
  /** Numero della ripetizione dello scenario (con scenari.ripetizioni > 1). */
  repeat?: number;
  /** Prima pagina non raggiungibile (es. connessione assente, computer in stop): la sessione non descrive il sito. */
  unreachable?: string;
  /** Sessione con navigazione manuale dell'operatore dopo la scelta. */
  manual?: { instructions: string; pages: string[]; endedBy: 'operatore' | 'tempo' | 'pagina-chiusa'; seconds: number; /** Pagine dell'intera navigazione, anche su altri siti (la sessione può essere divisa per sito). */ totalPages?: number; steps?: import('./browser/replay.js').RecordedStep[]; errorPages?: { url: string; status: number }[]; extraTabs?: number };
  /** Sessione automatica che ha rigiocato un percorso registrato in una navigazione manuale. */
  replay?: { pages: string[]; stepsDone: number; stepsTotal: number; stoppedAt?: string; seconds: number; recordedAt: string; fromSession: string; fills?: { value: string; hint: string }[] };
  /**
   * Sessione fermata dal tetto di durata prima di finire il percorso: i fatti osservati valgono, ma ciò che manca
   * (es. le pagine dopo la scelta o dopo la revoca) non è stato visto. Contiene il passo in cui si è fermata.
   */
  truncated?: string;
  /** Comando per rivedere la scelta trovato nella pagina dopo la scelta (molti gestori lo mostrano solo allora). */
  revokeAfterChoice?: { text: string; how: string; url: string };
  /** Analisi della struttura del banner (solo nella prima sessione "nessuna azione" di ogni sito). */
  bannerAnalysis?: BannerAnalysis;
  /**
   * Parte di una sessione attribuita a un altro sito: le pagine visitate (di solito in una navigazione manuale)
   * erano su questo host, non su quello della sessione di origine. Stesso id e stesse prove della sessione di origine.
   */
  attributedFrom?: { session: string; site: string };
  /** Se presente, la navigazione è stata intercettata da un sistema anti-bot: sessione non valida. */
  blocked?: { provider: string; signal: string; url: string };
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
  /** Ricerca della pagina di informativa: pagina usata, come è stata trovata, tentativi con lo stato HTTP. */
  policy?: PolicySearch;
  /** Informativa senza tabelle leggibili: dichiarazione testuale (fornitori citati, affermazioni sui cookie). */
  textual?: TextualDeclaration;
}

export interface PolicySearch {
  /** Pagina usata (risposta 200 sullo stesso sito), oppure null se nessuna è raggiungibile. */
  url: string | null;
  /** Come è stata trovata (configurazione, link nel banner, link nel piè di pagina, rel="privacy-policy", percorso comune…). */
  how: string | null;
  tried: { url: string; how: string; status: number | null; note?: string }[];
  /** Screenshot del piè di pagina della pagina iniziale. */
  footerShot?: string;
}

export interface TextualDeclaration {
  url: string;
  how: string;
  /** Titolo o inizio della sezione sui cookie usata, se trovata. */
  section: string | null;
  /** Fornitori e strumenti noti nominati nel testo, con una breve citazione. */
  vendors: { name: string; quote: string }[];
  /** Affermazioni tipiche sui cookie (es. "solo cookie tecnici"), con una breve citazione. */
  claims: { claim: TextualClaim; quote: string }[];
}

export type TextualClaim = 'solo-tecnici' | 'no-profilazione' | 'no-tracciamento' | 'terze-parti';

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

/** In quante ripetizioni automatiche è stato osservato; `manual`: solo in una sessione manuale, fatta una volta. */
export interface Repeats {
  seen: number;
  of: number;
  manual?: boolean;
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
  /** Forza della prova: risorsa scaricata, raccolta inviata, identificativo memorizzato. */
  evidenceLevel?: 'risorsa' | 'raccolta' | 'identificativo';
  /** Altra prova osservata insieme a quella principale (es. identificativo memorizzato e anche dati inviati). */
  evidenceExtra?: string;
  /** Frase breve e in linguaggio semplice per la sintesi iniziale. */
  headline?: string;
  /** Fornitori o piattaforme di cui parla la scheda. */
  subjects?: string[];
  /** Siti a cui si riferisce la scheda (più di uno se raggruppata tra sottodomini). */
  sites: string[];
  /** Chiave stabile tra esecuzioni (regola, oggetto, dominio): serve al confronto tra due esecuzioni. */
  key?: string;
  /** Con ripetizioni: in quante esecuzioni dello scenario il fatto si è osservato, su quante. */
  repeats?: Repeats & { perSite?: (Repeats & { host: string })[] };
  norms: NormRef[];
  /** Il sito non ha alcun meccanismo di consenso (nessun banner in nessuna sessione valida). */
  noBanner?: boolean;
  /** Condizioni rilevanti per la valutazione che dal browser non si possono verificare. */
  unverifiable?: string[];
  /** Precisazione sul fornitore per la sintesi (es. "di prima parte, senza cookie"). */
  subjectNote?: string;
}

/**
 * Navigazione manuale probabilmente incompleta: una sola pagina, oppure pochissime pagine in pochi secondi. Conta
 * l'intera navigazione, non la parte attribuita a un sito; un operatore veloce su molte pagine non è "incompleto".
 */
export function manualIncomplete(m: { pages: string[]; seconds: number; totalPages?: number }): boolean {
  const n = m.totalPages ?? m.pages.length;
  return n <= 1 || (m.seconds < 45 && n <= 3);
}
