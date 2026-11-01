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
      try {
        path = new URL(r.url).pathname;
      } catch {
        // indirizzo non valido
      }
      const t = classifier.classifyHost(r.host, path);
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
