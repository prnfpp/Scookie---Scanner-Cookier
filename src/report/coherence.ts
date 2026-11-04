import { requestEvidenceLevel } from '../rules/helpers.js';
import type { RequestRecord, SessionResult } from '../types.js';

/** Strumento di statistica che invia un pageview per pagina: di prima parte, oppure Matomo/Piwik ovunque sia ospitato. */
const pageviewTool = (r: RequestRecord) => r.tracker?.category === 'statistica' && (r.party === 'prima' || /matomo|piwik/i.test(r.tracker.company));

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

/**
 * Controllo di coerenza del momento: uno strumento che invia un pageview per pagina non può avere, al caricamento,
 * più richieste di raccolta delle pagine visitate. Se le ha, il conteggio "al caricamento / dopo lo scroll" va
 * verificato (eventi aggiuntivi, invii ripetuti, o un errore nell'attribuzione del momento): finisce nelle anomalie.
 * Vale solo per le rilevazioni che registrano le visite di pagina (dalla 0.1.2).
 */
export function pageviewCoherence(sessions: SessionResult[]): string[] {
  const agg = new Map<string, { site: string; vendor: string; hits: number; visits: number; sessions: Set<string>; worst: string | null }>();
  for (const s of sessions) {
    if (!s.visits?.length || s.blocked || s.unreachable) continue;
    // pagine visitate prima di qualsiasi scelta (con la scelta eseguita, le visite precedenti al click)
    const choice = s.choiceAt ? Date.parse(s.choiceAt) : Infinity;
    const visits = s.visits.filter((v) => Date.parse(v.at) < choice).length;
    const hits = s.requests.filter((r) => r.phase === 'prima' && r.stage === 'caricamento' && pageviewTool(r) && requestEvidenceLevel([r]) === 'raccolta');
    const byVendor = new Map<string, RequestRecord[]>();
    for (const r of hits) byVendor.set(r.tracker!.company, [...(byVendor.get(r.tracker!.company) ?? []), r]);
    for (const [vendor, list] of byVendor) {
      const k = `${s.site}|${vendor}`;
      const a = agg.get(k) ?? { site: s.site, vendor, hits: 0, visits: 0, sessions: new Set<string>(), worst: null };
      a.hits += list.length;
      a.visits += visits;
      // la visita con più raccolte al caricamento, come esempio
      const perVisit = new Map<number, number>();
      for (const r of list) if (r.visit !== undefined) perVisit.set(r.visit, (perVisit.get(r.visit) ?? 0) + 1);
      const [vi, n] = [...perVisit].sort((x, y) => y[1] - x[1])[0] ?? [];
      if (n && n > 1) {
        a.sessions.add(s.id);
        a.worst ??= `${s.id}, ${s.visits[vi!]?.url ?? 'pagina'}: ${n} raccolte al caricamento`;
      }
      agg.set(k, a);
    }
  }
  return [...agg.values()]
    .filter((a) => a.hits > a.visits || a.sessions.size)
    .map(
      (a) =>
        `${hostOf(a.site)}: ${a.vendor} ha ${a.hits} richieste di raccolta "al caricamento" su ${a.visits} pagine visitate senza scelta: ` +
        'per uno strumento che invia un pageview per pagina ci si aspetta al massimo una raccolta per pagina prima di qualsiasi interazione. ' +
        `Il conteggio del momento va verificato in richieste.csv (eventi aggiuntivi, invii ripetuti o momento attribuito male)${a.worst ? `; esempio: ${a.worst}` : ''}.`,
    );
}
