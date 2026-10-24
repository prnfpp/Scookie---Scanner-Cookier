import type { ExitInfo } from '../browser/exit.js';
import type { AuditConfig } from '../config/schema.js';
import type { ComparisonRow, DeclaredSet, Evidence, ScenarioName, SessionResult, Severity } from '../types.js';

export interface RuleContext {
  config: AuditConfig;
  sessions: SessionResult[];
  declared: DeclaredSet[];
  comparison: ComparisonRow[];
  /** IP e paese di uscita rilevati all'avvio. */
  exit: ExitInfo;
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
