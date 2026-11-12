import { CATEGORY_LABEL, groupBy, nReq, requestExcerpt, sessionEvidence } from '../helpers.js';
import { maskedCfMatchesTestSurname, reviveTestHits, type PiiHit } from '../../util/pii.js';
import { registrableDomain } from '../../util/domains.js';
import type { RawFinding, Rule } from '../types.js';

/** Caselle PEC: indirizzi pubblicati dalle aziende, non dati dell'utente. */
const PEC = /(^|\.)(pec|legalmail|arubapec|postecert|postacert|cert)\.|\.pec\.it$/i;

/**
 * Indirizzi email pubblicati dal sito stesso (es. assistenza@dominio-del-sito, caselle PEC): alcuni pixel, come
 * quello di TikTok, leggono le email presenti nella pagina. Non sono dati dell'utente e non si contano.
 */
function userPii(pii: PiiHit[], site: string): PiiHit[] {
  const own = registrableDomain(new URL(site).hostname);
  return pii.filter((p) => {
    if (p.kind !== 'email') return true;
    const dom = (p.masked.split('@')[1] ?? '').toLowerCase();
    return !(dom === own || dom.endsWith(`.${own}`) || PEC.test(dom));
  });
}

/**
 * Dati personali (targa, data di nascita, email, codice fiscale, telefono) inviati a terze parti nell'indirizzo
 * o nel corpo delle richieste, per esempio come parametri dell'indirizzo della pagina visitata.
 * I valori sono riportati solo mascherati.
 */
/**
 * Servizi che ricevono i moduli per conto del sito (es. HubSpot Forms): l'invio dei dati inseriti è il loro
 * funzionamento previsto, non un tracciamento.
 */
const FORM_ENDPOINTS = /(^|\.)(api\.hsforms\.com|forms\.hsforms\.com|forms\.hubspot\.com|api\.typeform\.com|submit\.jotform\.com|formspree\.io|list-manage\.com|webto\.salesforce\.com|go\.pardot\.com)$/i;

type Certainty = 'prova' | 'parametro' | 'forma';

/** Quanto è certo che il valore sia un dato personale. */
const certaintyOf = (hits: PiiHit[]): Certainty => (hits.some((h) => h.test) ? 'prova' : hits.some((h) => h.param) ? 'parametro' : 'forma');

const CERTAINTY_TEXT: Record<Certainty, string> = {
  prova: "Certezza: alta. I valori coincidono con i dati di prova inseriti dall'operatore durante la navigazione (dichiarati nel metodo): il fatto osservato è il percorso di questi dati verso il fornitore.",
  parametro: 'Certezza: media. I valori sono in parametri con nome di dato personale (es. "targa", "dataNascita") ma non coincidono con i dati di prova dichiarati: vanno verificati.',
  forma: 'Certezza: bassa. I valori somigliano soltanto a dati personali (per forma) e non coincidono con i dati di prova dichiarati: da verificare, possono essere identificativi tecnici.',
};

export const datiPersonaliATerzi: Rule = {
  id: 'dati-personali-a-terzi',
  title: 'Dati personali inviati a terze parti',
  defaultSeverity: 'alta',
  defaultNorms: ['gdpr5', 'gdpr6', 'garante2021'],
  evaluate({ sessions }) {
    const items = sessions.flatMap((s) =>
      s.requests
        .filter((r) => r.party === 'terza' && r.pii?.length)
        // valori mascherati che corrispondono ai dati digitati dall'operatore: tornano dati di prova, in chiaro
        .map((r) => ({ s, r: { ...r, pii: reviveTestHits(userPii(r.pii!, s.site)) } }))
        .filter(({ r }) => r.pii.length)
        .map(({ s, r }) => ({ s, r, form: r.method === 'POST' && FORM_ENDPOINTS.test(r.host), certainty: certaintyOf(r.pii) }))
        // codice fiscale mascherato che inizia come il cognome di prova: probabile codice calcolato dal sito dai dati inseriti
        .map((x) => (x.certainty === 'forma' && x.r.pii.some((h) => h.kind === 'codice fiscale' && maskedCfMatchesTestSurname(h.masked)) ? { ...x, certainty: 'parametro' as Certainty } : x)),
    );
    const out: RawFinding[] = [];
    for (const [, group] of groupBy(items, (i) => `${i.s.site}|${i.r.tracker?.company ?? i.r.host}|${i.form ? 'modulo' : i.certainty}`)) {
      const { s, r, form, certainty } = group[0];
      const company = r.tracker?.company ?? r.host;
      const who = r.tracker ? `${r.tracker.company} (${CATEGORY_LABEL[r.tracker.category]})` : r.host;
      const kinds = [...new Set(group.flatMap((g) => g.r.pii.map((p) => p.kind)))];
      const allHits = [...new Map(group.flatMap((g) => g.r.pii.map((p) => [`${p.kind}|${p.param}|${p.masked}`, p]))).values()];
      // lo stesso valore trovato con e senza nome del parametro conta una volta, col parametro
      const hits = allHits.filter((h) => h.param || !allHits.some((o) => o.param && o.kind === h.kind && o.masked === h.masked));
      // nel gruppo "prova" possono esserci anche valori che non coincidono con i dati di prova: vanno detti a parte
      const testKinds = [...new Set(hits.filter((h) => h.test).map((h) => h.kind))];
      const otherKinds = [...new Set(hits.filter((h) => !h.test).map((h) => h.kind))].filter((k) => !testKinds.includes(k));
      const shown = certainty === 'prova' && testKinds.length ? testKinds : kinds;
      const others = certainty === 'prova' && otherKinds.length ? ` Le stesse richieste contengono anche valori che possono essere dati personali ma non coincidono con i dati di prova registrati (${otherKinds.join(', ')}): sono riportati mascherati e vanno verificati nel file HAR.` : '';
      const pages = [...new Set(group.map((g) => g.r.pageUrl))];
      const scen = [...new Set(group.map((g) => g.s.scenario))];
      const afterReject = scen.includes('rifiuta');
      const sample = group.find((g) => g.s.scenario === 'rifiuta')?.r ?? r;
      const sampleSession = group.find((g) => g.r === sample)?.s ?? s;
      out.push({
        site: s.site,
        scenario: afterReject ? 'rifiuta' : s.scenario,
        pageUrl: sample.pageUrl,
        severity: form ? 'informativa' : certainty === 'parametro' ? 'media' : certainty === 'forma' ? 'bassa' : undefined,
        subjects: [company],
        groupKey: `${company}|${form ? 'modulo' : certainty}|${kinds.sort().join(',')}`,
        evidenceLevel: 'raccolta',
        headline: form
          ? `Il modulo invia i dati inseriti (${kinds.join(', ')}) a ${company}, che lo gestisce`
          : certainty === 'prova'
            ? `I dati inseriti nel modulo (${shown.join(', ')}) arrivano a ${company}${afterReject ? ', anche dopo il rifiuto' : ''}`
            : group.some((g) => /Session Replay/.test(g.r.purpose ?? ''))
              ? `La registrazione della sessione di ${company} (Session Replay) contiene valori che ${certainty === 'forma' ? 'somigliano a' : 'potrebbero essere'} dati personali (${kinds.join(', ')})`
              : `${company} riceve valori che ${certainty === 'forma' ? 'somigliano a' : 'potrebbero essere'} dati personali (${kinds.join(', ')})`,
        description: form
          ? `${nReq(group.length)} a ${who} ${group.length === 1 ? 'invia' : 'inviano'} i dati inseriti nel modulo (${kinds.join(', ')}). È l'invio del modulo al fornitore che lo gestisce per conto del sito: il funzionamento previsto del modulo, riportato come contesto.`
          : `${nReq(group.length)} a ${who} ${group.length === 1 ? 'contiene' : 'contengono'} ${certainty === 'prova' ? 'i dati di prova inseriti durante la navigazione' : 'valori che possono essere dati personali'} (${shown.join(', ')}), nell'indirizzo o nel corpo della richiesta, ` +
            `per esempio come parametri dell'indirizzo della pagina visitata.${afterReject ? ' Avviene anche dopo il rifiuto dei cookie.' : ''}` +
            (certainty === 'prova' ? others : ' I valori sono riportati mascherati; quelli completi sono nei file HAR.'),
        details: [
          ...(form ? [] : [CERTAINTY_TEXT[certainty]]),
          ...hits
            .filter((h) => h.kind === 'codice fiscale' && !h.test)
            .map((h) => [h, maskedCfMatchesTestSurname(h.masked)] as const)
            .filter(([, w]) => w)
            .map(([h, w]) => `Il codice fiscale ${h.masked} inizia con le lettere del cognome di prova "${w}": probabilmente è il codice calcolato dal sito a partire dai dati inseriti; il valore completo va confrontato nel file HAR.`),
          ...[...new Set(group.map((g) => g.r.purpose).filter(Boolean))].map((p) => `Natura delle richieste: ${p}.`),
          ...hits.slice(0, 10).map((h) => `${h.kind}: ${h.masked}${h.param ? ` (parametro "${h.param}")` : ''}${h.test ? ' — dato di prova' : ''}`),
          `Pagine: ${pages.slice(0, 8).join(', ')}`,
          `Scenari: ${scen.join(', ')}`,
        ],
        evidence: sessionEvidence(sampleSession, ['3-fine']),
        requestExcerpt: requestExcerpt(sample, sampleSession),
      });
    }
    return out;
  },
};
