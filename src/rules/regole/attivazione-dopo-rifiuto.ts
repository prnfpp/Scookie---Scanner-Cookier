import { NON_TECHNICAL } from '../../types.js';
import { choiceHow, cookieActivity, embedLine, requestBreakdown, cookieVendor, pagesOf, requestVendor, describeGoogleConsent, googleConsentSummary, strongestRequest, requestEvidenceLevel, nReq, CATEGORY_LABEL, groupBy, hostsSummary, isConsentModeDeniedPing, requestExcerpt, sessionEvidence, uetConsentSummary } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Testi della regola per lo scenario: rifiuto o chiusura del banner con la X. */
const WORDS = {
  rifiuta: { after: 'Dopo il rifiuto', how: (h: string) => `eseguito ${h}` },
  chiudi: { after: 'Dopo la chiusura del banner con la X', how: (h: string) => `eseguita ${h}` },
};

/** Dopo "Rifiuta" (o dopo la X): nuovi cookie non tecnici o richieste a tracker, anche nelle pagine successive. */
function afterChoice(scenario: 'rifiuta' | 'chiudi', id: string, title: string): Rule {
  const w = WORDS[scenario];
  return {
  id,
  title,
  defaultSeverity: 'alta',
  defaultNorms: ['art122', 'eprivacy53', 'garante2021', 'gdpr4_11', 'gdpr7'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    // Se la X registra un consenso, i tracciamenti dopo la chiusura sono quelli del consenso: li descrive la scheda
    // sull'esito della chiusura, non questa
    for (const s of sessions.filter((x) => x.scenario === scenario && x.interaction.outcome === 'eseguito' && x.interaction.closeEffect !== 'consenso')) {
      // Lo stesso cookie già scritto prima della scelta (nella sessione, con altro dominio o percorso, o nella
      // sessione senza azione dello stesso sito): dopo il rifiuto è un aggiornamento, non un identificativo nuovo.
      const preSame = new Set(s.cookies.filter((c) => c.phase === 'prima').map((c) => c.name));
      const preSite = new Set(sessions.filter((x) => x.site === s.site && x.scenario === 'nessuna-azione').flatMap((x) => x.cookies.map((c) => c.name)));
      const cookieNote = (name: string) =>
        preSame.has(name) ? ' (già presente prima della scelta in questa sessione: continua a essere scritto o aggiornato)' : preSite.has(name) ? ' (compare già prima di qualsiasi scelta nelle sessioni senza azione dello stesso sito)' : '';
      // Cookie attivi dopo la scelta: scritti per la prima volta, oppure già presenti e riscritti (valore o scadenza cambiati)
      const cookies = s.cookies.filter((c) => cookieActivity(c, 'scelta'));
      const renewed = new Set(cookies.filter((c) => cookieActivity(c, 'scelta') === 'rinnovato'));
      // Ancora presenti dopo la scelta ma non riscritti: fatto distinto e più debole (identificativo rimasto nel browser)
      const residual = s.cookies.filter((c) => c.phase === 'prima' && c.presentAfterChoice && NON_TECHNICAL.has(c.classification.category) && !renewed.has(c));
      const reqs = s.requests.filter(
        (r) => r.phase === 'dopo' && r.tracker && NON_TECHNICAL.has(r.tracker.category) && !isConsentModeDeniedPing(r),
      );
      // un fornitore canonico (cookie e richieste dello stesso contenuto, es. YouTube = Google) per categoria
      const keyOf = (c: (typeof s.cookies)[number]) => `${cookieVendor(c)}|${c.classification.category}`;
      const reqKey = (r: (typeof reqs)[number]) => `${requestVendor(r)}|${r.tracker!.category}`;
      const keys = new Set([...cookies.map(keyOf), ...reqs.map(reqKey)]);
      for (const k of keys) {
        const key = k.slice(0, k.lastIndexOf('|'));
        const cs = cookies.filter((c) => keyOf(c) === k);
        const fresh = cs.filter((c) => !renewed.has(c));
        const again = cs.filter((c) => renewed.has(c));
        const left = residual.filter((c) => keyOf(c) === k);
        const rs = reqs.filter((r) => reqKey(r) === k);
        const cat = cs[0]?.classification.category ?? rs[0]?.tracker!.category;
        const parts: string[] = [];
        if (fresh.length) parts.push(`${fresh.length === 1 ? 'viene scritto 1 cookie' : `vengono scritti ${fresh.length} cookie`} (${fresh.map((c) => c.name).join(', ')})`);
        if (again.length) parts.push(`${again.length === 1 ? 'viene riscritto 1 cookie già presente' : `vengono riscritti ${again.length} cookie già presenti`} prima della scelta, con scadenza o valore aggiornati (${again.map((c) => c.name).join(', ')})`);
        if (rs.length) parts.push(`${rs.length === 1 ? 'parte' : 'partono'} ${nReq(rs.length)} a ${hostsSummary(rs)}${rs.every((r) => r.party === 'prima') ? ' sul dominio del sito' : ''}${requestBreakdown(rs)}`);
        const pages = [...new Set([...fresh.map((c) => c.firstSeenUrl), ...again.map((c) => c.renewals!.find((r) => r.stage === 'scelta')!.url), ...rs.map((r) => r.pageUrl)])];
        const reqLevel = rs.length ? requestEvidenceLevel(rs) : null;
        const level = cs.length ? 'identificativo' : reqLevel!;
        const sample = rs.length ? strongestRequest(rs) : undefined;
        const consent = sample ? describeGoogleConsent(sample.consentParams) : null;
        const summary = googleConsentSummary(rs);
        const uet = uetConsentSummary(rs);
        const consentShort = summary.short ?? uet.short;
        const collected = rs.filter((r) => requestEvidenceLevel([r]) === 'raccolta');
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: pages[0] ?? null,
          severity: level === 'risorsa' ? 'media' : undefined,
          evidenceLevel: level,
          // identificativo e dati inviati insieme: la forza della prova li dichiara entrambi
          ...(cs.length && collected.length ? { evidenceExtra: `dati di navigazione inviati al fornitore (${nReq(collected.length)} di raccolta)` } : {}),
          subjects: [key],
          groupKey: `${key}|${cat}`,
          headline: `${w.after}, ${key} continua a ${cs.length ? (collected.length ? 'scrivere identificativi nel browser e ricevere dati di navigazione' : 'scrivere identificativi nel browser') : level === 'raccolta' ? 'ricevere dati di navigazione' : 'essere caricato dal sito'}${!cs.length && consentShort ? `, ${consentShort}` : ''}`,
          description:
            `${w.after} (${w.how(choiceHow(s.interaction))}), per ${key} (${CATEGORY_LABEL[cat!]}) ${parts.join(' e ')}.` +
            (fresh.length && fresh.every((c) => preSame.has(c.name))
              ? ` Gli stessi cookie erano già presenti prima della scelta: ${w.after.toLowerCase()} continuano a essere scritti o aggiornati, non sono identificativi nuovi.`
              : ''),
          details: [
            `Pagine in cui si osserva: ${pages.join(', ')}`,
            ...(pagesOf(rs).exitLine ? [pagesOf(rs).exitLine!] : []),
            ...(embedLine(rs) ? [embedLine(rs)!] : []),
            `Metodo di interazione: ${s.interaction.method}; verifica stato consenso: ${s.interaction.verification} ${s.interaction.verificationDetail}`,
            ...fresh.map((c) => `cookie ${c.name} — ${c.domain}, prima volta su ${c.firstSeenUrl}${cookieNote(c.name)}`),
            ...again.map((c) => {
              const r = c.renewals!.find((x) => x.stage === 'scelta')!;
              return `cookie ${c.name} — ${c.domain}, già presente prima della scelta (da ${c.firstSeenUrl}), riscritto dopo la scelta su ${r.url}${r.expires ? ` con scadenza ${r.expires.slice(0, 10)}` : ''}`;
            }),
            ...(left.length ? [`Cookie dello stesso fornitore ancora presenti dopo la scelta, non riscritti: ${left.map((c) => `${c.name} (${c.domain})`).join(', ')}`] : []),
            ...(sample ? [`Richiesta di esempio: ${sample.msFromChoice} ms dopo la scelta — ${sample.url.slice(0, 200)}`] : []),
            ...(consent ? [`Consenso Google dichiarato nella richiesta di esempio: ${consent}${sample?.fromServiceWorker ? ' (richiesta inviata da un service worker del sito)' : ''}`] : []),
            ...(summary.detail ? [summary.detail] : []),
            ...(uet.detail ? [uet.detail] : []),
            ...[...new Set(rs.map((x) => x.purpose).filter(Boolean))].map((x) => `Natura delle richieste: ${x}`),
          ],
          evidence: sessionEvidence(s, ['2-dopo-scelta', '3-fine']),
          requestExcerpt: sample ? requestExcerpt(sample, s) : undefined,
        });
      }
      // Fornitori con soli cookie rimasti (scritti prima della scelta, non riscritti e senza richieste dopo): fatto più debole
      for (const [k, left] of groupBy(residual.filter((c) => !keys.has(keyOf(c))), keyOf)) {
        const key = k.slice(0, k.lastIndexOf('|'));
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: s.pages[0] ?? null,
          severity: 'bassa',
          evidenceLevel: 'identificativo',
          subjects: [key],
          groupKey: `residui|${key}`,
          description:
            `${w.after} (${w.how(choiceHow(s.interaction))}) restano nel browser ${left.length === 1 ? '1 cookie non tecnico' : `${left.length} cookie non tecnici`} di ${key} (${CATEGORY_LABEL[left[0].classification.category]}) scritti prima della scelta: ${left.map((c) => c.name).join(', ')}. ` +
            'Non sono stati riscritti e non sono partite richieste del fornitore dopo la scelta: è un identificativo rimasto nel browser, non una nuova raccolta.',
          details: left.map((c) => `cookie ${c.name} — ${c.domain}, scritto prima della scelta su ${c.firstSeenUrl}${c.expires ? `, scadenza ${c.expires.slice(0, 10)}` : ''}`),
          evidence: sessionEvidence(s, ['2-dopo-scelta', '3-fine']).filter((e) => !e.file.endsWith('.har')),
        });
      }
    }
    return out;
  },
};
}

export const attivazioneDopoRifiuto = afterChoice('rifiuta', 'attivazione-dopo-rifiuto', 'Tracciamenti attivi dopo il rifiuto');
export const attivazioneDopoChiusura = afterChoice('chiudi', 'attivazione-dopo-chiusura', 'Tracciamenti attivi dopo la chiusura del banner con la X');
