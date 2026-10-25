import { NON_TECHNICAL } from '../../types.js';
import { choiceHow, describeGoogleConsent, googleConsentSummary, strongestRequest, requestEvidenceLevel, nReq, CATEGORY_LABEL, groupBy, hostsSummary, isConsentModeDeniedPing, requestExcerpt, sessionEvidence } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Dopo "Rifiuta": nuovi cookie non tecnici o richieste a tracker, anche nelle pagine successive. */
export const attivazioneDopoRifiuto: Rule = {
  id: 'attivazione-dopo-rifiuto',
  title: 'Tracciamenti attivi dopo il rifiuto',
  defaultSeverity: 'alta',
  defaultNorms: ['art122', 'eprivacy53', 'garante2021', 'gdpr4_11', 'gdpr7'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    for (const s of sessions.filter((x) => x.scenario === 'rifiuta' && x.interaction.outcome === 'eseguito')) {
      // Lo stesso cookie già scritto prima della scelta (nella sessione, con altro dominio o percorso, o nella
      // sessione senza azione dello stesso sito): dopo il rifiuto è un aggiornamento, non un identificativo nuovo.
      const preSame = new Set(s.cookies.filter((c) => c.phase === 'prima').map((c) => c.name));
      const preSite = new Set(sessions.filter((x) => x.site === s.site && x.scenario === 'nessuna-azione').flatMap((x) => x.cookies.map((c) => c.name)));
      const cookieNote = (name: string) =>
        preSame.has(name) ? ' (già presente prima della scelta in questa sessione: continua a essere scritto o aggiornato)' : preSite.has(name) ? ' (compare già prima di qualsiasi scelta nelle sessioni senza azione dello stesso sito)' : '';
      const cookies = s.cookies.filter((c) => c.phase === 'dopo' && NON_TECHNICAL.has(c.classification.category));
      const reqs = s.requests.filter(
        (r) => r.phase === 'dopo' && r.tracker && NON_TECHNICAL.has(r.tracker.category) && !isConsentModeDeniedPing(r),
      );
      const keys = new Set([
        ...cookies.map((c) => c.classification.platform ?? c.domain),
        ...reqs.map((r) => r.tracker!.company),
      ]);
      for (const key of keys) {
        const cs = cookies.filter((c) => (c.classification.platform ?? c.domain) === key);
        const rs = reqs.filter((r) => r.tracker!.company === key);
        const cat = cs[0]?.classification.category ?? rs[0]?.tracker!.category;
        const parts: string[] = [];
        if (cs.length) parts.push(`${cs.length === 1 ? 'viene scritto 1 cookie' : `vengono scritti ${cs.length} cookie`} (${cs.map((c) => c.name).join(', ')})`);
        if (rs.length) parts.push(`${rs.length === 1 ? 'parte' : 'partono'} ${nReq(rs.length)} a ${hostsSummary(rs)}`);
        const pages = [...new Set([...cs.map((c) => c.firstSeenUrl), ...rs.map((r) => r.pageUrl)])];
        const level = cs.length ? 'identificativo' : requestEvidenceLevel(rs);
        const sample = rs.length ? strongestRequest(rs) : undefined;
        const consent = sample ? describeGoogleConsent(sample.consentParams) : null;
        const summary = googleConsentSummary(rs);
        const consentShort = summary.short;
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: pages[0] ?? null,
          severity: level === 'risorsa' ? 'media' : undefined,
          evidenceLevel: level,
          subjects: [key],
          groupKey: `${key}|${cat}`,
          headline: `Dopo il rifiuto, ${key} continua a ${cs.length ? 'scrivere identificativi nel browser' : level === 'raccolta' ? 'ricevere dati di navigazione' : 'essere caricato dal sito'}${!cs.length && consentShort ? `, ${consentShort}` : ''}`,
          description:
            `Dopo il rifiuto (eseguito ${choiceHow(s.interaction)}), per ${key} (${CATEGORY_LABEL[cat!]}) ${parts.join(' e ')}.` +
            (cs.length && cs.every((c) => preSame.has(c.name))
              ? ' Gli stessi cookie erano già presenti prima della scelta: dopo il rifiuto continuano a essere scritti o aggiornati, non sono identificativi nuovi.'
              : ''),
          details: [
            `Pagine in cui si osserva: ${pages.join(', ')}`,
            `Metodo di interazione: ${s.interaction.method}; verifica stato consenso: ${s.interaction.verification} ${s.interaction.verificationDetail}`,
            ...cs.map((c) => `cookie ${c.name} — ${c.domain}, prima volta su ${c.firstSeenUrl}${cookieNote(c.name)}`),
            ...(sample ? [`Richiesta di esempio: ${sample.msFromChoice} ms dopo la scelta — ${sample.url.slice(0, 200)}`] : []),
            ...(consent ? [`Consenso Google dichiarato nella richiesta di esempio: ${consent}${sample?.fromServiceWorker ? ' (richiesta inviata da un service worker del sito)' : ''}`] : []),
            ...(summary.detail ? [summary.detail] : []),
          ],
          evidence: sessionEvidence(s, ['2-dopo-scelta', '3-fine']),
          requestExcerpt: sample ? requestExcerpt(sample, s) : undefined,
        });
      }
    }
    return out;
  },
};
