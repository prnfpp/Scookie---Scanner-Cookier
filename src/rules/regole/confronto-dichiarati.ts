import type { ComparisonRow } from '../../types.js';
import { CATEGORY_LABEL, groupBy } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

const label = (r: ComparisonRow) =>
  `${r.kind === 'servizio' ? 'servizio' : r.kind === 'storage' ? 'chiave di storage' : 'cookie'} "${r.name}"${r.domain ? ` (${r.domain})` : ''}`;
/** Etichetta con articolo: "Il cookie …", "La chiave di storage …". */
const theLabel = (r: ComparisonRow) => `${r.kind === 'storage' ? 'La' : 'Il'} ${label(r)}`;

const rank = (r: ComparisonRow) => (r.observedCategory === 'tecnico' ? 2 : r.observedCategory === 'sconosciuta' || !r.observedCategory ? 1 : 0);

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
        groupKey: 'tutti',
        headline: nonTech.length ? `${nonTech.length} elementi di tracciamento osservati non compaiono nell'elenco dichiarato` : undefined,
        description: `${rows.length === 1 ? '1 elemento osservato non compare' : `${rows.length} elementi osservati non compaiono`} nell'elenco dichiarato (${src}), di cui ${nonTech.length} di categoria non tecnica.`,
        // prima gli elementi di tracciamento, poi i non classificati, in fondo i tecnici
        details: [...rows].sort((x, y) => rank(x) - rank(y)).map((r) => `${label(r)} — categoria osservata: ${CATEGORY_LABEL[r.observedCategory ?? 'sconosciuta']}; scenari: ${r.scenarios.join(', ')}`),
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
        groupKey: 'tutti',
        description: `${rows.length === 1 ? "1 elemento dell'elenco dichiarato" : `${rows.length} elementi dell'elenco dichiarato`} (${src}) non ${rows.length === 1 ? 'è stato osservato' : 'sono stati osservati'} in nessuna sessione, compresa quella con "Accetta". Possono essere voci obsolete o legate a pagine non campionate.`,
        // L'elenco completo è nell'allegato confronto-dichiarati.csv: qui solo i primi, per leggibilità.
        details: [
          ...rows.slice(0, 15).map((r) => `${label(r)} — categoria dichiarata: ${r.declaredCategories.join(', ')}`),
          ...(rows.length > 15 ? [`… e altri ${rows.length - 15}: elenco completo nell'allegato confronto-dichiarati.csv`] : []),
        ],
        evidence: [],
      });
    }
    return out;
  },
};

/**
 * Categoria dichiarata incoerente (es. analytics tra i "necessari / sempre attivi") o elemento in più categorie.
 * Una scheda per categoria dichiarata, con l'elenco degli elementi: non una scheda per ogni cookie.
 */
export const categoriaIncoerente: Rule = {
  id: 'categoria-incoerente',
  title: 'Categoria dichiarata non coerente',
  defaultSeverity: 'media',
  defaultNorms: ['gdpr13', 'garante2021', 'art122'],
  evaluate({ comparison }) {
    const out: RawFinding[] = [];
    const rows = comparison.filter((r) => r.categoryIssue);
    for (const [key, list] of groupBy(rows, (r) => `${r.site}|${r.categoryIssue}|${r.categoryIssue === 'incoerente' ? r.declaredCategories.join(' + ') : ''}`)) {
      const r = list[0];
      const names = list.map((x) => `${label(x)} — riconosciuto come ${CATEGORY_LABEL[x.observedCategory ?? 'sconosciuta']}${x.categoryIssue === 'categorie-multiple' ? `; categorie dichiarate: ${x.declaredCategories.join(', ')}` : ''}`);
      const observed = [...new Set(list.map((x) => CATEGORY_LABEL[x.observedCategory ?? 'sconosciuta']))].join(', ');
      if (r.categoryIssue === 'incoerente') {
        const cat = r.declaredCategories.join(', ');
        out.push({
          site: r.site,
          scenario: null,
          pageUrl: null,
          groupKey: key.split('|').slice(1).join('|'),
          headline: `Elementi di ${observed} dichiarati nella categoria tecnica${r.declaredAlwaysActive ? ' "sempre attiva"' : ''} "${cat}"`,
          description: `${list.length === 1 ? '1 elemento riconosciuto' : `${list.length} elementi riconosciuti`} come ${observed} ${list.length === 1 ? 'è dichiarato' : 'sono dichiarati'} nella categoria "${cat}", trattata come tecnica${r.declaredAlwaysActive ? ' e "sempre attiva" (non rifiutabile)' : ''}.`,
          details: names,
          evidence: [],
        });
      } else {
        out.push({
          site: r.site,
          scenario: null,
          pageUrl: null,
          severity: 'bassa',
          groupKey: 'categorie-multiple',
          description: `${list.length === 1 ? '1 elemento compare' : `${list.length} elementi compaiono`} in più categorie dell'elenco dichiarato.`,
          details: names,
          evidence: [],
        });
      }
    }
    return out;
  },
};
