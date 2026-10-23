import type { ComparisonRow } from '../../types.js';
import { CATEGORY_LABEL, groupBy } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

const label = (r: ComparisonRow) =>
  `${r.kind === 'servizio' ? 'servizio' : r.kind === 'storage' ? 'storage' : 'cookie'} "${r.name}"${r.domain ? ` (${r.domain})` : ''}`;

/** Elementi osservati ma assenti dall'elenco dichiarato. */
export const nonDichiarati: Rule = {
  id: 'elementi-non-dichiarati',
  title: 'Elementi presenti ma non dichiarati',
  defaultSeverity: 'media',
  defaultNorms: ['gdpr13', 'garante2021', 'art122'],
  evaluate({ comparison, declared }) {
    const out: RawFinding[] = [];
    for (const [site, rows] of groupBy(comparison.filter((r) => r.status === 'non-dichiarato'), (r) => r.site)) {
      const src = declared.find((d) => d.site === site)?.source ?? 'elenco dichiarato';
      const nonTech = rows.filter((r) => r.observedCategory && !['tecnico', 'funzionalita', 'sconosciuta'].includes(r.observedCategory));
      out.push({
        site,
        scenario: null,
        pageUrl: null,
        description: `${rows.length === 1 ? '1 elemento osservato non compare' : `${rows.length} elementi osservati non compaiono`} nell'elenco dichiarato (${src}), di cui ${nonTech.length} di categoria non tecnica.`,
        details: rows.map((r) => `${label(r)} — categoria osservata: ${CATEGORY_LABEL[r.observedCategory ?? 'sconosciuta']}; scenari: ${r.scenarios.join(', ')}`),
        evidence: [],
      });
    }
    return out;
  },
};

/** Elementi dichiarati ma mai osservati nelle sessioni. */
export const dichiaratiNonOsservati: Rule = {
  id: 'dichiarati-non-osservati',
  title: 'Elementi dichiarati ma non osservati',
  defaultSeverity: 'bassa',
  defaultNorms: ['gdpr13'],
  evaluate({ comparison, declared }) {
    const out: RawFinding[] = [];
    for (const [site, rows] of groupBy(comparison.filter((r) => r.status === 'dichiarato-non-osservato'), (r) => r.site)) {
      const src = declared.find((d) => d.site === site)?.source ?? 'elenco dichiarato';
      out.push({
        site,
        scenario: null,
        pageUrl: null,
        description: `${rows.length === 1 ? "1 elemento dell'elenco dichiarato" : `${rows.length} elementi dell'elenco dichiarato`} (${src}) non ${rows.length === 1 ? 'è stato osservato' : 'sono stati osservati'} in nessuna sessione, compresa quella con "Accetta". Possono essere voci obsolete o legate a pagine non campionate.`,
        details: rows.map((r) => `${label(r)} — categoria dichiarata: ${r.declaredCategories.join(', ')}`),
        evidence: [],
      });
    }
    return out;
  },
};

/** Categoria dichiarata incoerente (es. analytics tra i "necessari") o elemento in più categorie. */
export const categoriaIncoerente: Rule = {
  id: 'categoria-incoerente',
  title: 'Categoria dichiarata non coerente',
  defaultSeverity: 'media',
  defaultNorms: ['gdpr13', 'garante2021', 'art122'],
  evaluate({ comparison }) {
    return comparison
      .filter((r) => r.categoryIssue)
      .map((r) => ({
        site: r.site,
        scenario: null,
        pageUrl: null,
        severity: r.categoryIssue === 'categorie-multiple' ? ('bassa' as const) : undefined,
        description:
          r.categoryIssue === 'incoerente'
            ? `Il ${label(r)} è dichiarato come ${r.declaredAlwaysActive ? '"sempre attivo"/' : ''}tecnico (${r.declaredCategories.join(', ')}), ma è riconosciuto come ${CATEGORY_LABEL[r.observedCategory ?? 'sconosciuta']}.`
            : `Il ${label(r)} compare in più categorie dell'elenco dichiarato: ${r.declaredCategories.join(', ')}.`,
        details: [`Scenari in cui è osservato: ${r.scenarios.join(', ') || 'nessuno'}`],
        evidence: [],
      }));
  },
};
