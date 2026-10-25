import type { ExitInfo } from '../browser/exit.js';
import type { AuditConfig } from '../config/schema.js';
import type { DiscoveryResult } from '../discovery/discover.js';
import type { ComparisonRow, DeclaredSet, Evidence, ScenarioName, SessionResult, Severity } from '../types.js';

export interface RuleContext {
  config: AuditConfig;
  /** Sessioni valide (escluse quelle bloccate da sistemi anti-bot). */
  sessions: SessionResult[];
  /** Sessioni intercettate da un sistema anti-bot. */
  blocked: SessionResult[];
  declared: DeclaredSet[];
  comparison: ComparisonRow[];
  /** IP e paese di uscita rilevati all'avvio. */
  exit: ExitInfo;
  /** Pagine scoperte per sito (facoltativo nei test delle singole regole). */
  discovery?: DiscoveryResult[];
}

/** Criticità prodotta da una regola, prima della numerazione e del collegamento alle norme. */
export interface RawFinding {
  site: string;
  scenario: ScenarioName | null;
  pageUrl: string | null;
  description: string;
  details: string[];
  evidence: Evidence[];
  requestExcerpt?: Record<string, unknown>;
  evidenceLevel?: 'risorsa' | 'raccolta' | 'identificativo';
  /** Frase breve in linguaggio semplice per la sintesi iniziale. */
  headline?: string;
  /** Fornitori o piattaforme di cui parla la scheda (per raggruppare la sintesi per causa). */
  subjects?: string[];
  /**
   * Chiave di raggruppamento: schede della stessa regola con la stessa chiave, su siti dello stesso
   * dominio, diventano una sola scheda con l'elenco dei siti (es. stessa configurazione su www e app).
   */
  groupKey?: string;
  /** Sostituisce la gravità predefinita della regola per questo caso. */
  severity?: Severity;
}

/**
 * Regola di criticità. Ogni regola è un modulo a sé: descrive fatti osservati, non come rimediare.
 * Le norme collegate e la gravità si possono cambiare dal file norme.yaml senza toccare il codice.
 */
export interface Rule {
  id: string;
  title: string;
  defaultSeverity: Severity;
  defaultNorms: string[];
  evaluate(ctx: RuleContext): RawFinding[];
}
