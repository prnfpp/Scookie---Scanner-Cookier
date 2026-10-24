import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Category, Classification } from '../types.js';
import { parseCsv } from '../util/csv.js';
import { hostMatches } from '../util/domains.js';

const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));

export interface TrackerEntry {
  dominio: string;
  azienda: string;
  categoria: Category;
  percorsi?: string[];
  nota?: string;
}

interface OcdEntry {
  platform: string;
  category: Category;
  name: string;
  domain: string;
  wildcard: boolean;
}

/** Piattaforme che in Open Cookie Database sono "Analytics" ma registrano le sessioni. */
const SESSION_RECORDING = /hotjar|clarity|mouseflow|fullstory|smartlook|lucky ?orange|contentsquare|crazy ?egg|inspectlet|logrocket|quantum ?metric/i;

function mapOcdCategory(cat: string, platform: string): Category {
  switch (cat.trim().toLowerCase()) {
    case 'necessary':
    case 'security':
      return 'tecnico';
    case 'functional':
    case 'personalization':
      // Open Cookie Database marca come "Functional" alcuni cookie di strumenti di registrazione
      // sessioni (es. _hjSessionUser_ di Hotjar): esistono solo per quello strumento, quindi vale la piattaforma.
      return SESSION_RECORDING.test(platform) ? 'registrazione-sessioni' : 'funzionalita';
    case 'analytics':
      return SESSION_RECORDING.test(platform) ? 'registrazione-sessioni' : 'statistica';
    case 'marketing':
      return 'marketing';
    default:
      return 'sconosciuta';
  }
}

/**
 * Normalizza una categoria scritta liberamente (banner, policy, file) nelle categorie del tool.
 */
export function normalizeDeclaredCategory(label: string): Category {
  const l = label.toLowerCase();
  if (/necessar|tecnic|strett|strictly|essential|indispensab|sempre attiv/.test(l)) return 'tecnico';
  if (/registrazion|heatmap|session record/.test(l)) return 'registrazione-sessioni';
  if (/statist|analytic|analitic|performance|prestazion|misurazion|measurement/.test(l)) return 'statistica';
  if (/marketing|pubblicit|advertis|targeting|profilazion|remarketing|\bads?\b/.test(l)) return 'marketing';
  if (/social/.test(l)) return 'social';
  if (/funzional|functional|preferen|personalizz|esperienza/.test(l)) return 'funzionalita';
  return 'sconosciuta';
}

export class Classifier {
  private readonly ocdExact = new Map<string, OcdEntry[]>();
  private readonly ocdWildcard: OcdEntry[] = [];
  private readonly trackers: TrackerEntry[];

  constructor(extraTrackers: TrackerEntry[] = []) {
    this.loadOcd(`${DATA_DIR}vendor/open-cookie-database.csv`);
    const base = (parse(readFileSync(`${DATA_DIR}trackers.yaml`, 'utf8')) as { tracker: TrackerEntry[] }).tracker;
    // Le voci extra vengono prima: a parità di specificità prevalgono su quelle incluse.
    this.trackers = [...extraTrackers, ...base];
  }

  static loadExtraTrackers(path: string): TrackerEntry[] {
    if (!existsSync(path)) throw new Error(`File trackerExtra non trovato: ${path}`);
    return (parse(readFileSync(path, 'utf8')) as { tracker?: TrackerEntry[] }).tracker ?? [];
  }

  private loadOcd(path: string) {
    const rows = parseCsv(readFileSync(path, 'utf8'));
    const header = rows.shift() ?? [];
    const idx = (n: string) => header.findIndex((h) => h.trim().toLowerCase() === n);
    const iPlatform = idx('platform');
    const iCategory = idx('category');
    const iName = idx('cookie / data key name');
    const iDomain = idx('domain');
    const iWildcard = idx('wildcard match');
    for (const r of rows) {
      const name = r[iName]?.trim();
      if (!name) continue;
      const e: OcdEntry = {
        platform: r[iPlatform]?.trim() ?? '',
        category: mapOcdCategory(r[iCategory] ?? '', r[iPlatform] ?? ''),
        name,
        domain: (r[iDomain] ?? '').trim().toLowerCase(),
        wildcard: (r[iWildcard] ?? '').trim() === '1',
      };
      if (e.wildcard) this.ocdWildcard.push(e);
      else {
        const k = name.toLowerCase();
        const list = this.ocdExact.get(k) ?? [];
        list.push(e);
        this.ocdExact.set(k, list);
      }
    }
    // Prefissi più lunghi prima: "_ga_" vince su "_g".
    this.ocdWildcard.sort((a, b) => b.name.length - a.name.length);
  }

  /** Cerca un nome di cookie o chiave di storage in Open Cookie Database. */
  private lookupOcd(name: string, domain: string): OcdEntry | undefined {
    const pick = (list: OcdEntry[]) =>
      list.find((e) => e.domain && !e.domain.includes(' ') && hostMatches(domain, e.domain)) ?? list[0];
    const exact = this.ocdExact.get(name.toLowerCase());
    if (exact?.length) return pick(exact);
    const wild = this.ocdWildcard.filter((e) => name.toLowerCase().startsWith(e.name.toLowerCase()));
    if (wild.length) return pick(wild);
    return undefined;
  }

  /** Categoria di un host (e opzionalmente di un path) secondo l'elenco tracker. */
  classifyHost(host: string, path = '/'): TrackerEntry | undefined {
    const candidates = this.trackers.filter(
      (t) => hostMatches(host, t.dominio) && (!t.percorsi || t.percorsi.some((p) => new RegExp(p).test(path))),
    );
    candidates.sort(
      (a, b) => b.dominio.length - a.dominio.length || Number(!!b.percorsi) - Number(!!a.percorsi),
    );
    return candidates[0];
  }

  /**
   * Classifica un cookie o una chiave di storage.
   * Ordine: nome in Open Cookie Database, poi dominio del cookie nell'elenco tracker.
   */
  classifyName(name: string, domain: string): Classification {
    const ocd = this.lookupOcd(name, domain);
    if (ocd && ocd.category !== 'sconosciuta') {
      return { category: ocd.category, source: 'open-cookie-database', platform: ocd.platform };
    }
    const t = this.classifyHost(domain.replace(/^\./, ''));
    if (t) return { category: t.categoria, source: 'elenco-tracker', platform: t.azienda };
    return { category: 'sconosciuta', source: 'nessuna' };
  }
}
