import type { SessionResult } from '../types.js';
import type { Classifier } from './classifier.js';

/**
 * Riclassifica cookie, archivi e richieste con gli elenchi attuali: così anche un rapporto rigenerato da una
 * rilevazione passata usa le classificazioni aggiornate (es. un fornitore aggiunto all'elenco curato).
 */
export function reclassify(sessions: SessionResult[], classifier: Classifier): void {
  for (const s of sessions) {
    for (const c of s.cookies) c.classification = classifier.classifyName(c.name, c.domain);
    for (const st of s.storage) {
      let host = st.origin;
      try {
        host = new URL(st.origin).hostname;
      } catch {
        // origine non valida: si usa così com'è
      }
      st.classification = classifier.classifyName(st.key, host);
    }
    for (const r of s.requests) {
      let path = '/';
      let query = '';
      try {
        const u = new URL(r.url);
        path = u.pathname;
        query = u.search;
      } catch {
        // indirizzo non valido
      }
      const t = classifier.classifyHost(r.host, path, query);
      if (t) r.tracker = { company: t.azienda, category: t.categoria };
      else delete r.tracker;
    }
  }
}

/**
 * Natura di alcune richieste che il solo dominio non dice: si legge dall'indirizzo e vale anche per le rilevazioni
 * già raccolte (si applica prima delle regole, anche quando il rapporto si rigenera).
 * - Dynatrace con contentType=sr…: invio di Session Replay (registrazione della sessione, può comprendere il
 *   contenuto dei campi dei moduli), non semplice monitoraggio delle prestazioni.
 * - New Relic con ref=apps.mypurecloud…: l'agente gira dentro il widget di chat Genesys, non nel sito.
 * - Microsoft UET con evt=consent: solo segnale di Consent Mode (asc=D negato, asc=G concesso).
 */
export function enrichRequests(sessions: SessionResult[]): void {
  for (const s of sessions) {
    const nrBeacons = s.requests.filter((r) => /(^|\.)nr-data\.net$/.test(r.host));
    const nrFromGenesys = nrBeacons.length > 0 && nrBeacons.every((r) => GENESYS_REF.test(decode(r.url)));
    for (const r of s.requests) {
      const url = decode(r.url);
      if (/(^|\.)dynatrace\.com$|\.dynatrace-managed\.com$/.test(r.host) && /[?&]contentType=sr[A-Za-z]*/.test(url)) {
        r.tracker = { company: 'Dynatrace', category: 'registrazione-sessioni' };
        r.purpose = `Session Replay di Dynatrace (${/contentType=(sr[A-Za-z]*)/.exec(url)![0]}): invio della registrazione della sessione, che può comprendere i contenuti mostrati e quelli inseriti nei campi`;
      } else if (nrFromGenesys && (/(^|\.)nr-data\.net$/.test(r.host) || /(^|\.)js-agent\.newrelic\.com$/.test(r.host))) {
        r.tracker = { company: 'New Relic (nel widget di chat Genesys)', category: r.tracker?.category ?? 'statistica' };
        r.purpose = "Monitoraggio delle prestazioni del widget di chat Genesys (parametro ref=apps.mypurecloud…): l'agente è caricato dal widget del fornitore della chat, non dalle pagine del sito";
      } else if (/(^|\.)bat\.bing\.(com|net)$/.test(r.host)) {
        const q = params(url);
        const asc = q.get('asc');
        if (q.get('evt') === 'consent') r.purpose = `Segnale di Consent Mode di Microsoft UET (evt=consent${asc ? `, asc=${asc}: consenso ${asc === 'D' ? 'negato' : asc === 'G' ? 'concesso' : 'non documentato'}` : ''})`;
        if (asc) r.consentParams = { ...(r.consentParams ?? {}), asc };
      }
    }
  }
}

const GENESYS_REF = /[?&]ref=https?:\/\/apps\.mypurecloud\.|[?&]ref=https?:\/\/[^&]*\.pure\.cloud/;

function decode(u: string): string {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

function params(u: string): URLSearchParams {
  try {
    return new URL(u).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Contenuto incorporato da cui parte una richiesta (documento dell'iframe che l'ha inviata), classificato con l'elenco
 * dei domini: la telemetria di un widget (es. il log di Google inviato dal widget di Google Calendar) appartiene a quel
 * widget, non è un tracker a sé.
 */
export function attributeToEmbeds(sessions: SessionResult[], classifier: Classifier): void {
  for (const s of sessions) {
    /** Origini dei documenti incorporati che riuniscono tutto ciò che parte da loro, con il nome del contenuto. */
    const grouping = new Map<string, string>();
    for (const r of s.requests) {
      delete r.embed;
      delete r.embedGroup;
      if (!r.frameUrl) continue;
      let u: URL;
      try {
        u = new URL(r.frameUrl);
      } catch {
        continue;
      }
      const t = classifier.classifyHost(u.hostname, u.pathname, u.search);
      if (!t) continue;
      r.embed = t.azienda;
      if (!t.raggruppa) continue;
      grouping.set(u.origin, t.azienda);
      r.embedGroup = true;
      if (!r.tracker) {
        // risorsa di un dominio non in elenco caricata dal contenuto incorporato: è parte di quel contenuto
        r.tracker = { company: t.azienda, category: 'funzionalita' };
        r.purpose = `Risorsa caricata da ${t.azienda}`;
      } else if (r.tracker.company !== t.azienda) {
        const note = classifier.classifyHost(r.host, safePath(r.url))?.nota;
        r.purpose = `${r.tracker.company}${note ? ` (${note})` : ''}, caricato da ${t.azienda}`;
      }
    }
    // Storage scritto dentro il documento incorporato: appartiene al contenuto, anche se il nome è di un altro
    // fornitore (es. la registrazione della sessione di Sentry nel lettore Spotify)
    for (const st of s.storage) {
      const embed = grouping.get(st.origin);
      if (!embed || st.classification.platform === embed) continue;
      const by = st.classification.platform;
      st.classification = {
        ...st.classification,
        platform: embed,
        note: `${by ? `${by}, caricato da ${embed}` : `scritto da ${embed}`}${st.classification.note ? `: ${st.classification.note}` : ''}`,
      };
    }
  }
}

function safePath(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return '/';
  }
}
