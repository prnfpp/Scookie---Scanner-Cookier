import { NON_TECHNICAL, type Category } from '../../types.js';
import { activeAfterReject, cookieActivity, pagesOf, CATEGORY_LABEL, googleConsentSummary, refTo, groupBy, hostsSummary, isConsentModeDeniedPing, nReq, requestEvidenceLevel, requestExcerpt, sessionEvidence, strongestRequest } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';
import { nWords, plural } from '../../util/text.js';

/** Dopo la revoca del consenso: nuovi cookie non tecnici o richieste a tracker. */
export const attivazioneDopoRevoca: Rule = {
  id: 'attivazione-dopo-revoca',
  title: 'Tracciamenti attivi dopo la revoca del consenso',
  defaultSeverity: 'alta',
  defaultNorms: ['gdpr7', 'art122', 'eprivacy53', 'garante2021'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    // Fornitori ancora attivi dopo il rifiuto, per sito: se dopo la revoca succede lo stesso, non è un fatto nuovo.
    const afterReject = activeAfterReject(sessions);
    for (const s of sessions.filter((x) => x.scenario === 'revoca' && x.revocation?.outcome === 'eseguita')) {
      // scritti dopo la revoca, oppure già presenti e riscritti dopo la revoca
      const cookies = s.cookies.filter((c) => cookieActivity(c, 'revoca'));
      const reqs = s.requests.filter((r) => r.stage === 'revoca' && r.tracker && NON_TECHNICAL.has(r.tracker.category) && !isConsentModeDeniedPing(r));
      const keys = new Set([...cookies.map((c) => c.classification.platform ?? c.domain), ...reqs.map((r) => r.tracker!.company)]);
      for (const key of keys) {
        const cs = cookies.filter((c) => (c.classification.platform ?? c.domain) === key);
        const all = reqs.filter((r) => r.tracker!.company === key);
        // Invio residuo (sulla pagina in cui si revoca, es. dati già raccolti inviati alla chiusura della pagina)
        // e nuova raccolta (sulle pagine visitate dopo la revoca) sono fatti di peso diverso.
        const fresh = all.filter((r) => r.afterRevokeNav);
        const residual = all.filter((r) => !r.afterRevokeNav);
        const onlyResidual = !cs.length && !fresh.length && residual.length > 0;
        const rs = fresh.length ? fresh : all;
        const level = cs.length ? 'identificativo' : requestEvidenceLevel(rs);
        const sample = rs.length ? strongestRequest(rs) : undefined;
        const viaApi = s.revocation!.via === 'api';
        const sameAsReject = afterReject.get(s.site)?.has(key) ?? false;
        const consentShort = googleConsentSummary(rs).short;
        const parts: string[] = [];
        const newC = cs.filter((c) => cookieActivity(c, 'revoca') === 'nuovo');
        const again = cs.filter((c) => cookieActivity(c, 'revoca') === 'rinnovato');
        if (newC.length) parts.push(`${newC.length === 1 ? 'viene scritto 1 cookie' : `vengono scritti ${newC.length} cookie`} (${newC.map((c) => c.name).join(', ')})`);
        if (again.length) parts.push(`${again.length === 1 ? 'viene riscritto 1 cookie già presente' : `vengono riscritti ${again.length} cookie già presenti`}, con scadenza o valore aggiornati (${again.map((c) => c.name).join(', ')})`);
        if (fresh.length) parts.push(`sulle pagine visitate dopo la revoca ${fresh.length === 1 ? 'parte' : 'partono'} ${nReq(fresh.length)} a ${hostsSummary(fresh)}`);
        if (residual.length) {
          const first = Math.min(...residual.map((r) => r.msFromRevoke ?? Infinity));
          parts.push(
            `sulla pagina in cui è avvenuta la revoca ${residual.length === 1 ? 'parte' : 'partono'} ${nReq(residual.length)} a ${hostsSummary(residual)}` +
              (Number.isFinite(first) ? ` (la prima ${first} ms dopo la revoca)` : ''),
          );
        }
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: sample?.pageUrl ?? cs[0]?.firstSeenUrl ?? null,
          // Comportamento uguale a quello dopo il rifiuto: già nelle schede del rifiuto, qui solo come conferma.
          // Revoca simulata via API (un utente non può farla): prova più debole.
          // Solo invio residuo: compatibile con dati già raccolti inviati alla chiusura della pagina, prova debole.
          severity: sameAsReject || onlyResidual ? 'bassa' : level === 'risorsa' || viaApi ? 'media' : undefined,
          evidenceLevel: level,
          // revoca dal link della pagina o solo via API: casi diversi, schede diverse
          subjects: [key],
          groupKey: `${key}|${s.revocation!.via ?? 'link'}|${sameAsReject}|${onlyResidual}`,
          headline: onlyResidual
            ? `Dopo la revoca, ${key} invia solo dati residui dalla pagina in cui si è revocato`
            : sameAsReject
            ? `Dopo la revoca, ${key} si comporta come dopo il rifiuto`
            : `Dopo la revoca del consenso${viaApi ? ' (simulata via API)' : ''}, ${key} continua a ${cs.length ? 'scrivere identificativi' : level === 'raccolta' ? 'ricevere dati' : 'essere caricato'}${!cs.length && consentShort ? `, ${consentShort}` : ''}`,
          description:
            `Dopo aver accettato e poi revocato il consenso (${s.revocation!.how}), per ${key} ${parts.join(' e ')}.` +
            (onlyResidual
              ? ' Sulle pagine visitate dopo la revoca non parte nulla: è compatibile con l\'invio di dati già raccolti sulla pagina corrente (molti strumenti li inviano alla chiusura o al cambio di pagina), non con una nuova raccolta.'
              : '') +
            (sameAsReject ? ` Lo stesso fornitore risulta attivo anche dopo il rifiuto (${refTo('attivazione-dopo-rifiuto', key)}): non è un comportamento diverso.` : ''),
          details: [
            ...(s.revocation!.remaining.length ? [`Cookie non tecnici ancora presenti subito dopo la revoca: ${s.revocation!.remaining.join(', ')}`] : []),
            ...(pagesOf(all).exitLine ? [pagesOf(all).exitLine!] : []),
            ...(sample ? [`Richiesta di esempio: ${sample.msFromRevoke != null ? `${sample.msFromRevoke} ms dopo la revoca — ` : ''}${sample.url.slice(0, 200)}`] : []),
          ],
          evidence: sessionEvidence(s, ['4-dopo-revoca', '5-fine-revoca']),
          requestExcerpt: sample ? requestExcerpt(sample, s) : undefined,
        });
      }
    }
    return out;
  },
};

/** Revoca non eseguibile o cookie non tecnici rimasti dopo la revoca. */
export const esitoRevoca: Rule = {
  id: 'esito-revoca',
  title: 'Revoca del consenso',
  defaultSeverity: 'bassa',
  defaultNorms: ['gdpr7', 'garante2021'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    for (const s of sessions.filter((x) => x.scenario === 'revoca' && x.revocation)) {
      const r = s.revocation!;
      if (r.outcome === 'non-trovata') {
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: s.pages[0],
          groupKey: 'non-trovata',
          headline: 'Dopo aver accettato, non è stato trovato un modo per revocare il consenso dalla pagina',
          description: `Dopo l'accettazione non è stato possibile revocare il consenso dalla pagina: ${r.how}.`,
          details: [],
          evidence: sessionEvidence(s, ['3-fine', '4-dopo-revoca']).filter((e) => !e.file.endsWith('.har')),
        });
      } else if (r.remaining.length) {
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: s.pages[0],
          severity: 'informativa',
          groupKey: `cookie-rimasti|${r.via ?? 'link'}`,
          description: `Dopo la revoca (${r.how}) restano nel browser ${nWords(r.remaining.length, 'cookie non tecnico scritto', 'cookie non tecnici scritti')} durante il consenso. La revoca impedisce nuovi trattamenti; la rimozione dei cookie già scritti dipende dal gestore del consenso.`,
          details: r.remaining,
          evidence: sessionEvidence(s, ['4-dopo-revoca']).filter((e) => !e.file.endsWith('.har')),
        });
      }
    }
    return out;
  },
};

/** Accettata solo la categoria statistica: partono comunque marketing, social o registrazione sessioni. */
export const personalizzazioneNonRispettata: Rule = {
  id: 'personalizzazione-non-rispettata',
  title: 'Attivazioni oltre le categorie scelte',
  defaultSeverity: 'alta',
  defaultNorms: ['art122', 'eprivacy53', 'garante2021', 'gdpr4_11', 'gdpr7'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    const notAllowed = (c: Category) => NON_TECHNICAL.has(c) && c !== 'statistica';
    const afterReject = activeAfterReject(sessions);
    for (const s of sessions.filter((x) => x.scenario === 'personalizza' && x.interaction.outcome === 'eseguito')) {
      const cookies = s.cookies.filter((c) => c.phase === 'dopo' && notAllowed(c.classification.category));
      const reqs = s.requests.filter((r) => r.phase === 'dopo' && r.tracker && notAllowed(r.tracker.category) && !isConsentModeDeniedPing(r));
      // La scelta per categoria è accertata solo se lo stato registrato dal gestore la conferma
      const verified = s.interaction.verification === 'verificato';
      const groups = groupBy([...cookies.map((c) => ({ key: c.classification.platform ?? c.domain, cat: c.classification.category })), ...reqs.map((r) => ({ key: r.tracker!.company, cat: r.tracker!.category }))], (x) => x.key);
      for (const [key, items] of groups) {
        const cs = cookies.filter((c) => (c.classification.platform ?? c.domain) === key);
        const rs = reqs.filter((r) => r.tracker!.company === key);
        const level = cs.length ? 'identificativo' : requestEvidenceLevel(rs);
        // Attivo anche dopo il rifiuto: non è un'attivazione "oltre le categorie scelte", è lo stesso comportamento
        const sameAsReject = afterReject.get(s.site)?.has(key) ?? false;
        const label = `${key} (${CATEGORY_LABEL[items[0].cat]})`;
        const what = [cs.length ? `cookie ${cs.map((c) => c.name).join(', ')}` : '', rs.length ? `${nReq(rs.length)} a ${hostsSummary(rs)}` : ''].filter(Boolean).join('; ');
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: s.pages[0],
          // Stesso comportamento del rifiuto: già nei rilievi del rifiuto, qui solo come conferma.
          // Scelta non verificata sullo stato del gestore o solo risorse scaricate: prova più debole.
          severity: sameAsReject ? 'bassa' : level === 'risorsa' && !verified ? 'bassa' : level === 'risorsa' || !verified ? 'media' : undefined,
          evidenceLevel: level,
          subjects: [key],
          groupKey: `${key}|${sameAsReject}|${verified}`,
          headline: sameAsReject
            ? `Accettando solo la statistica, ${label} si comporta come dopo il rifiuto`
            : verified
              ? `Accettando solo la statistica, ${label} si attiva comunque`
              : `Dopo una scelta per categoria non verificata, ${label} risulta attivo`,
          description:
            `Dopo aver accettato solo la categoria statistica (${s.interaction.detail}), si attiva ${label}: ${what}.` +
            (verified ? '' : ` La scelta non è stata verificata sullo stato registrato dal gestore del consenso (${s.interaction.verification}): non è accertato che sia stata accettata la sola statistica, il fatto va letto con questa cautela.`) +
            (sameAsReject ? ` Lo stesso fornitore risulta attivo anche dopo il rifiuto (${refTo('attivazione-dopo-rifiuto', key)}): è lo stesso comportamento del rifiuto, non un'attivazione legata alle categorie scelte.` : ''),
          details: [`Verifica dello stato del consenso: ${s.interaction.verification} — ${s.interaction.verificationDetail}`],
          evidence: sessionEvidence(s, ['2-dopo-scelta', '3-fine']),
          requestExcerpt: rs.length ? requestExcerpt(strongestRequest(rs), s) : undefined,
        });
      }
    }
    return out;
  },
};
