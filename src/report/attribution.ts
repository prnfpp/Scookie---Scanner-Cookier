import type { DeclaredSet, SessionResult } from '../types.js';

/**
 * Attribuzione per host: ogni cookie, archivio locale e richiesta appartiene al sito della pagina in cui è comparso,
 * non al sito della sessione. Serve soprattutto per le navigazioni manuali e i percorsi registrati, che possono
 * partire da un altro sito dello stesso titolare (es. il preventivo che inizia su www e prosegue su app): ciò che
 * avviene su www è un fatto di www, non di app.
 */

const hostname = (u: string): string | null => {
  try {
    const h = new URL(u).hostname;
    return h || null;
  } catch {
    return null;
  }
};
const bare = (h: string) => h.replace(/^www\./, '');
const originOf = (u: string, h: string) => {
  try {
    return `${new URL(u).protocol}//${h}`;
  } catch {
    return `https://${h}`;
  }
};

/** Host che appartengono a un sito: il suo, la variante con o senza www e quello a cui porta la home (reindirizzamento). */
export function ownHosts(site: string, sessions: SessionResult[]): Set<string> {
  const h = hostname(site) ?? site;
  const own = new Set([h, bare(h), `www.${bare(h)}`]);
  for (const s of sessions) {
    if (s.site !== site || s.manual || s.replay || s.pageType !== 'home') continue;
    for (const r of s.requests) {
      if (r.resourceType !== 'document') continue;
      const x = hostname(r.pageUrl);
      if (x) own.add(x);
    }
  }
  return own;
}

export interface Attribution {
  sessions: SessionResult[];
  /** Note da riportare tra le anomalie (navigazioni uscite dal sito, elenchi dichiarati scartati). */
  notes: string[];
}

/** Gruppi di screenshot: quelli del banner e della scelta stanno sulla prima pagina, quelli finali sull'ultima. */
const FIRST_PAGE_SHOTS = /^(1-|2-|4-preferenze|3-footer)/;

/**
 * Divide le sessioni che hanno visitato pagine di altri host: la parte sugli altri host diventa una sessione
 * attribuita a quel sito (stesso id, stesse prove), con l'indicazione della sessione di origine. Una sessione che non
 * è mai entrata nel proprio sito non descrive il sito ed esce dalle regole (resta nei dati grezzi).
 */
export function attributeByHost(sessions: SessionResult[]): Attribution {
  const notes: string[] = [];
  const out: SessionResult[] = [];
  const ownBySite = new Map<string, Set<string>>();
  const own = (site: string) => {
    if (!ownBySite.has(site)) ownBySite.set(site, ownHosts(site, sessions));
    return ownBySite.get(site)!;
  };
  // Host che appartengono a un sito della rilevazione (il suo, con o senza www, e quello a cui porta la home): una
  // pagina su uno di questi host è una pagina di quel sito, non di un sito a parte (es. conte.it che rimanda a www.conte.it).
  const aliasSite = new Map<string, string>();
  for (const site of new Set(sessions.filter((s) => !s.attributedFrom).map((s) => s.site))) {
    for (const h of own(site)) if (!aliasSite.has(h)) aliasSite.set(h, site);
  }
  for (const s of sessions) {
    if (s.attributedFrom) {
      out.push(s);
      continue;
    }
    const mine = own(s.site);
    /** Sito a cui appartiene una pagina fuori dal sito della sessione; null se la pagina è del sito. */
    const targets = new Set<string>();
    const siteFor = (u: string) => {
      const h = hostname(u);
      if (!h || mine.has(h)) return null;
      const t = aliasSite.get(h) ?? originOf(u, h);
      if (t === s.site) return null;
      targets.add(t);
      return t;
    };
    const cookieSite = s.cookies.map((c) => siteFor(c.firstSeenUrl));
    const storageSite = s.storage.map((c) => siteFor(c.firstSeenUrl));
    const requestSite = s.requests.map((r) => siteFor(r.pageUrl));
    const visited = s.manual?.pages ?? s.replay?.pages ?? s.pages;
    const visitedSite = visited.map(siteFor);
    if (!targets.size) {
      out.push(s);
      continue;
    }
    const firstUrl = visited[0] ?? s.pages[0] ?? '';
    const firstHost = hostname(firstUrl);
    const firstSite = firstUrl ? siteFor(firstUrl) : null;
    const lastSite = visited.length ? visitedSite[visited.length - 1] : null;
    const ownVisited = visited.filter((_, i) => !visitedSite[i]);
    const siteHost = hostname(s.site) ?? s.site;
    const off = [...targets];
    const offHosts = off.map((t) => hostname(t) ?? t);
    const total = visited.length;
    for (const t of off) {
      const keepShot = (label: string) => (FIRST_PAGE_SHOTS.test(label) ? firstSite === t : lastSite === t);
      const pages = visited.filter((_, i) => visitedSite[i] === t);
      const part: SessionResult = {
        ...s,
        site: t,
        pages,
        cookies: s.cookies.filter((_, i) => cookieSite[i] === t),
        storage: s.storage.filter((_, i) => storageSite[i] === t),
        requests: s.requests.filter((_, i) => requestSite[i] === t),
        screenshots: s.screenshots.filter((e) => keepShot(e.label)),
        attributedFrom: { session: s.id, site: s.site },
        errors: [],
        interaction:
          firstSite === t
            ? s.interaction
            : { ...s.interaction, detail: `${s.interaction.detail} (scelta fatta su ${firstHost ?? 'un altro sito'})`, choiceOn: firstHost ?? 'un altro sito' },
        ...(s.manual ? { manual: { ...s.manual, pages, totalPages: total } } : {}),
        ...(s.replay ? { replay: { ...s.replay, pages } } : {}),
      };
      if (firstSite !== t) delete part.bannerAnalysis;
      out.push(part);
    }
    const kind = s.manual ? 'la navigazione manuale' : s.replay ? 'il percorso registrato' : 'la sessione';
    if (!ownVisited.length) {
      notes.push(
        `${s.id}: ${kind} non è mai entrata su ${siteHost} (pagine visitate solo su ${offHosts.join(', ')}). I fatti osservati sono attribuiti a ${offHosts.join(', ')}; per descrivere ${siteHost} va rifatta partendo da ${siteHost}.`,
      );
      continue;
    }
    notes.push(
      `${s.id}: ${kind} è passata anche da ${offHosts.join(', ')}, fuori da ${siteHost}: cookie e richieste osservati su quelle pagine sono attribuiti a ${off.length === 1 ? 'quel sito' : 'quei siti'}.`,
    );
    const startedElsewhere = !!firstSite;
    out.push({
      ...s,
      pages: s.pages.filter((u) => !siteFor(u)),
      cookies: s.cookies.filter((_, i) => !cookieSite[i]),
      storage: s.storage.filter((_, i) => !storageSite[i]),
      requests: s.requests.filter((_, i) => !requestSite[i]),
      screenshots: s.screenshots.filter((e) => (FIRST_PAGE_SHOTS.test(e.label) ? !firstSite : !lastSite)),
      interaction: startedElsewhere ? { ...s.interaction, detail: `${s.interaction.detail} (scelta fatta su ${firstHost})`, choiceOn: firstHost ?? 'un altro sito' } : s.interaction,
      ...(startedElsewhere ? { bannerAnalysis: undefined } : {}),
      ...(s.manual ? { manual: { ...s.manual, pages: ownVisited, totalPages: total } } : {}),
      ...(s.replay ? { replay: { ...s.replay, pages: ownVisited } } : {}),
    });
  }
  return { sessions: out, notes };
}

/**
 * L'elenco dichiarato letto dal gestore del consenso vale solo se quel gestore è quello del sito: un elenco letto su
 * un'altra pagina (es. durante una navigazione manuale partita da www) non descrive il sito e si scarta.
 */
export function checkDeclared(declared: DeclaredSet[], sessions: SessionResult[]): { declared: DeclaredSet[]; notes: string[] } {
  const notes: string[] = [];
  const out = declared.map((d) => {
    const m = /^CMP (.+)$/.exec(d.source ?? '');
    if (!m) return d;
    const own = sessions.filter((s) => s.site === d.site && !s.attributedFrom && !s.manual && !s.blocked && !s.unreachable);
    if (!own.length || own.some((s) => s.interaction.detectedCmps.includes(m[1]))) return d;
    const shown = [...new Set(own.flatMap((s) => s.interaction.detectedCmps))];
    const note = `Elenco del gestore ${m[1]} scartato: è stato letto su una pagina fuori dal sito, mentre sul sito il gestore mostrato è ${shown.join(', ') || 'non riconosciuto'}. Confronto con i dichiarati non eseguito: va fornito l'elenco (cookie policy o file dei dichiarati) o ripetuta la rilevazione.`;
    notes.push(`${d.site}: ${note}`);
    return { site: d.site, source: null, items: [], note };
  });
  return { declared: out, notes };
}
