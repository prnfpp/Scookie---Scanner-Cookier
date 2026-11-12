import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { Category, Classification } from '../types.js';
import { parseCsv } from '../util/csv.js';
import { hostMatches } from '../util/domains.js';

const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));

export interface TrackerEntry {
  /** Host o dominio; "*" = qualsiasi host (anche il sito stesso), solo insieme a percorsi o parametri. */
  dominio: string;
  azienda: string;
  categoria: Category;
  percorsi?: string[];
  /** Espressioni regolari sulla query (senza "?"): devono corrispondere tutte. */
  parametri?: string[];
  nota?: string;
  /**
   * Contenuto incorporato (iframe): le richieste e lo storage che partono dal suo documento, anche verso altri
   * fornitori (es. Sentry caricato dal lettore), appartengono a questo contenuto e si riuniscono sotto di lui.
   */
  raggruppa?: boolean;
}

/**
 * Host che corrisponde al dominio di una voce: il dominio stesso o un suo sottodominio; un dominio con "*" (es.
 * "image-cdn-*.spotifycdn.com", "*-spclient.spotify.com") è un modello in cui "*" sta per una parte di un'etichetta.
 */
const wildcardCache = new Map<string, RegExp>();

export function entryHostMatches(host: string, dominio: string): boolean {
  if (dominio === '*') return true;
  if (!dominio.includes('*')) return hostMatches(host, dominio);
  let re = wildcardCache.get(dominio);
  if (!re) wildcardCache.set(dominio, (re = wildcardRe(dominio)));
  return re.test(host.replace(/^\./, ''));
}

function wildcardRe(dominio: string): RegExp {
  return new RegExp(`(^|\\.)${dominio.replace(/^\./, '').split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]*')}$`, 'i');
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

/** Fonte delle classificazioni di data/cookies.yaml: hanno la precedenza su Open Cookie Database. */
export const CURATED_SOURCE = 'elenco curato Scookie';

/** Voce dell'elenco curato data/cookies.yaml. */
interface CuratedCookie {
  nome: string;
  dominio?: string;
  fornitore: string;
  categoria: Category;
  nota?: string;
}

export class Classifier {
  private readonly curated: (CuratedCookie & { re: RegExp })[];
  private readonly ocdExact = new Map<string, OcdEntry[]>();
  private readonly ocdWildcard: OcdEntry[] = [];
  private readonly trackers: TrackerEntry[];
  /** Espressioni di percorsi e parametri di ogni voce, compilate una volta (si usano a ogni richiesta). */
  private readonly compiled = new Map<TrackerEntry, { paths?: RegExp[]; params?: RegExp[] }>();

  constructor(extraTrackers: TrackerEntry[] = []) {
    this.loadOcd(`${DATA_DIR}vendor/open-cookie-database.csv`);
    const curated = (parse(readFileSync(`${DATA_DIR}cookies.yaml`, 'utf8')) as { cookie: CuratedCookie[] }).cookie;
    this.curated = curated.map((c) => ({ ...c, re: new RegExp(c.nome) }));
    const base = (parse(readFileSync(`${DATA_DIR}trackers.yaml`, 'utf8')) as { tracker: TrackerEntry[] }).tracker;
    // Le voci extra vengono prima: a parità di specificità prevalgono su quelle incluse.
    this.trackers = [...extraTrackers, ...base];
    for (const t of this.trackers) {
      if (t.dominio === '*' && !t.percorsi?.length && !t.parametri?.length) throw new Error(`Voce tracker con dominio "*" senza percorsi né parametri (${t.azienda}): varrebbe per qualsiasi richiesta`);
      try {
        this.compiled.set(t, { paths: t.percorsi?.map((p) => new RegExp(p)), params: t.parametri?.map((p) => new RegExp(p)) });
      } catch (e) {
        throw new Error(`Voce tracker di ${t.azienda} (${t.dominio}): espressione regolare non valida in percorsi o parametri (${(e as Error).message})`);
      }
    }
  }

  /** Nomi dei fornitori nell'elenco dei domini (per riconoscerli nel testo delle informative). */
  vendorNames(): string[] {
    return [...new Set(this.trackers.map((t) => t.azienda))];
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

  /**
   * Cerca un nome di cookie o chiave di storage in Open Cookie Database, per nome E dominio.
   * Una voce legata a un dominio specifico (es. "sessionid" di instagram.com) vale solo su quel dominio:
   * un nome generico uguale su un altro sito non viene attribuito a quel fornitore.
   * Le voci senza dominio, o marcate "(3rd party)" (impostate dallo script del fornitore sul dominio del sito), valgono ovunque.
   */
  private lookupOcd(name: string, domain: string): OcdEntry | undefined {
    const applies = (e: OcdEntry) => !e.domain || e.domain.includes('(3rd party)') || hostMatches(domain, e.domain.split(/\s/)[0]);
    const pick = (list: OcdEntry[]) => {
      const ok = list.filter(applies);
      // Il nome esatto (maiuscole comprese) prevale; poi la voce legata al dominio; poi quella generica.
      return (
        ok.find((e) => e.name === name && e.domain && hostMatches(domain, e.domain.split(/\s/)[0])) ??
        ok.find((e) => e.name === name) ??
        ok.find((e) => e.domain && hostMatches(domain, e.domain.split(/\s/)[0])) ??
        ok[0]
      );
    };
    const exact = this.ocdExact.get(name.toLowerCase());
    const hit = exact?.length ? pick(exact) : undefined;
    if (hit) return hit;
    const wild = this.ocdWildcard.filter((e) => name.toLowerCase().startsWith(e.name.toLowerCase()));
    return wild.length ? pick(wild) : undefined;
  }

  private lookupCurated(name: string, domain: string) {
    return this.curated.find((c) => c.re.test(name) && (!c.dominio || hostMatches(domain, c.dominio)));
  }

  /**
   * Categoria di un host (e opzionalmente di path e query) secondo l'elenco tracker. Le voci con dominio "*"
   * riconoscono un endpoint di raccolta dal percorso o dai parametri su qualsiasi host, anche il sito stesso
   * (es. Matomo ospitato sul sito: /matomo.php?idsite=1&rec=1).
   */
  classifyHost(host: string, path = '/', query = ''): TrackerEntry | undefined {
    // Percorsi dell'infrastruttura Cloudflare, su qualsiasi sito: verifica anti-bot, protezione email, analytics di rete.
    if (path.startsWith('/cdn-cgi/challenge-platform/')) {
      return { dominio: host, azienda: 'Cloudflare', categoria: 'tecnico', nota: 'Verifica anti-bot Cloudflare (si attiva soprattutto con browser automatici)' };
    }
    // /cdn-cgi/rum è Cloudflare Web Analytics (statistica); /cdn-cgi/zaraz/ è il gestore di tag, che può inoltrare a terzi
    if (path.startsWith('/cdn-cgi/rum')) {
      return { dominio: host, azienda: 'Cloudflare', categoria: 'statistica', nota: 'Cloudflare Web Analytics' };
    }
    if (path.startsWith('/cdn-cgi/') && !path.startsWith('/cdn-cgi/zaraz/')) {
      return { dominio: host, azienda: 'Cloudflare', categoria: 'tecnico', nota: 'Infrastruttura Cloudflare (/cdn-cgi/)' };
    }
    const q = query.replace(/^\?/, '');
    const candidates = this.trackers.filter((t) => {
      if (!entryHostMatches(host, t.dominio)) return false;
      const c = this.compiled.get(t);
      return (!c?.paths || c.paths.some((re) => re.test(path))) && (!c?.params || c.params.every((re) => re.test(q)));
    });
    // il dominio più specifico vince; le voci per qualsiasi host ("*") valgono solo se nessun'altra corrisponde
    const len = (t: TrackerEntry) => (t.dominio === '*' ? 0 : t.dominio.length);
    candidates.sort((a, b) => len(b) - len(a) || Number(!!b.percorsi || !!b.parametri) - Number(!!a.percorsi || !!a.parametri));
    return candidates[0];
  }

  /**
   * Classifica un cookie o una chiave di storage, sempre per nome E dominio.
   * Ordine: elenco curato (data/cookies.yaml), Open Cookie Database (voci applicabili al dominio),
   * infine il dominio del cookie nell'elenco dei fornitori (dichiarandolo nella fonte).
   */
  classifyName(name: string, domain: string): Classification {
    const d = domain.replace(/^\./, '');
    const curated = this.lookupCurated(name, d);
    if (curated) return { category: curated.categoria, source: CURATED_SOURCE, platform: curated.fornitore, note: curated.nota };
    const ocd = this.lookupOcd(name, d);
    if (ocd && ocd.category !== 'sconosciuta') {
      return { category: ocd.category, source: 'open-cookie-database', platform: ocd.platform };
    }
    // Nome sconosciuto su un dominio di un fornitore noto: il fornitore è un indizio, non una classificazione.
    // L'elemento resta "da valutare" (es. una chiave di Cloudflare scritta dentro il lettore Vimeo non è di Vimeo).
    const t = this.classifyHost(d);
    if (t) {
      return {
        category: 'sconosciuta',
        source: 'dominio-del-fornitore',
        platform: t.azienda,
        note: `nome non presente nelle fonti; scritto sul dominio di ${t.azienda} (categoria del dominio: ${t.categoria}): da valutare`,
      };
    }
    return { category: 'sconosciuta', source: 'nessuna' };
  }
}
