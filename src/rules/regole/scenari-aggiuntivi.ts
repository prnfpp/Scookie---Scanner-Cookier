import { NON_TECHNICAL, type Category } from '../../types.js';
import { CATEGORY_LABEL, googleConsentSummary, groupBy, hostsSummary, isConsentModeDeniedPing, nReq, requestEvidenceLevel, requestExcerpt, sessionEvidence, strongestRequest } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Dopo la revoca del consenso: nuovi cookie non tecnici o richieste a tracker. */
export const attivazioneDopoRevoca: Rule = {
  id: 'attivazione-dopo-revoca',
  title: 'Tracciamenti attivi dopo la revoca del consenso',
  defaultSeverity: 'alta',
  defaultNorms: ['gdpr7', 'art122', 'eprivacy53', 'garante2021'],
  evaluate({ sessions }) {
    const out: RawFinding[] = [];
    // Fornitori ancora attivi dopo il rifiuto, per sito: se dopo la revoca succede lo stesso, non è un fatto nuovo.
    const afterReject = new Map<string, Set<string>>();
    for (const s of sessions.filter((x) => x.scenario === 'rifiuta' && x.interaction.outcome === 'eseguito')) {
      const set = afterReject.get(s.site) ?? new Set<string>();
      for (const c of s.cookies) if (c.phase === 'dopo' && NON_TECHNICAL.has(c.classification.category)) set.add(c.classification.platform ?? c.domain);
      for (const r of s.requests) if (r.phase === 'dopo' && r.tracker && NON_TECHNICAL.has(r.tracker.category) && !isConsentModeDeniedPing(r)) set.add(r.tracker.company);
      afterReject.set(s.site, set);
    }
    for (const s of sessions.filter((x) => x.scenario === 'revoca' && x.revocation?.outcome === 'eseguita')) {
      const cookies = s.cookies.filter((c) => c.stage === 'revoca' && NON_TECHNICAL.has(c.classification.category));
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
        if (cs.length) parts.push(`${cs.length === 1 ? 'viene scritto 1 cookie' : `vengono scritti ${cs.length} cookie`} (${cs.map((c) => c.name).join(', ')})`);
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
            (sameAsReject ? ' Lo stesso fornitore risulta attivo anche dopo il rifiuto (vedi le schede "Tracciamenti attivi dopo il rifiuto"): non è un comportamento diverso.' : ''),
          details: [
            ...(s.revocation!.remaining.length ? [`Cookie non tecnici ancora presenti subito dopo la revoca: ${s.revocation!.remaining.join(', ')}`] : []),
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
          description: `Dopo la revoca (${r.how}) restano nel browser ${r.remaining.length} cookie non tecnici scritti durante il consenso. La revoca impedisce nuovi trattamenti; la rimozione dei cookie già scritti dipende dal gestore del consenso.`,
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
    for (const s of sessions.filter((x) => x.scenario === 'personalizza' && x.interaction.outcome === 'eseguito')) {
      const cookies = s.cookies.filter((c) => c.phase === 'dopo' && notAllowed(c.classification.category));
      const reqs = s.requests.filter((r) => r.phase === 'dopo' && r.tracker && notAllowed(r.tracker.category) && !isConsentModeDeniedPing(r));
      const groups = groupBy([...cookies.map((c) => ({ key: c.classification.platform ?? c.domain, cat: c.classification.category })), ...reqs.map((r) => ({ key: r.tracker!.company, cat: r.tracker!.category }))], (x) => x.key);
      for (const [key, items] of groups) {
        const cs = cookies.filter((c) => (c.classification.platform ?? c.domain) === key);
        const rs = reqs.filter((r) => r.tracker!.company === key);
        const level = cs.length ? 'identificativo' : requestEvidenceLevel(rs);
        out.push({
          site: s.site,
          scenario: s.scenario,
          pageUrl: s.pages[0],
          severity: level === 'risorsa' ? 'media' : undefined,
          evidenceLevel: level,
          groupKey: key,
          headline: `Accettando solo la statistica, ${key} (${CATEGORY_LABEL[items[0].cat]}) si attiva comunque`,
          description: `Dopo aver accettato solo la categoria statistica (${s.interaction.detail}), si attiva ${key} (${CATEGORY_LABEL[items[0].cat]}): ${[cs.length ? `cookie ${cs.map((c) => c.name).join(', ')}` : '', rs.length ? `${nReq(rs.length)} a ${hostsSummary(rs)}` : ''].filter(Boolean).join('; ')}.`,
          details: [`Verifica dello stato del consenso: ${s.interaction.verification} — ${s.interaction.verificationDetail}`],
          evidence: sessionEvidence(s, ['2-dopo-scelta', '3-fine']),
          requestExcerpt: rs[0] ? requestExcerpt(rs[0], s) : undefined,
        });
      }
    }
    return out;
  },
};
