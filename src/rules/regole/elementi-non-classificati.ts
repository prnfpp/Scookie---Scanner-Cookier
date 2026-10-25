import type { Classification, ScenarioName } from '../../types.js';
import { groupBy, sessionEvidence } from '../helpers.js';
import type { RawFinding, Rule } from '../types.js';

/** Fornitore del dominio come indizio, quando il nome non è riconosciuto. */
const hint = (c: Classification) => (c.source === 'dominio-del-fornitore' && c.platform ? ` — dominio di ${c.platform}` : '');

/**
 * Cookie, storage e terze parti che il tool non sa classificare, osservati prima della scelta o dopo il rifiuto.
 * Senza questa regola il report risulterebbe "pulito" proprio dove la classificazione non arriva:
 * questi elementi vanno valutati caso per caso.
 */
export const elementiNonClassificati: Rule = {
  id: 'elementi-non-classificati',
  title: 'Elementi non classificati, da valutare',
  defaultSeverity: 'bassa',
  defaultNorms: ['art122', 'eprivacy53', 'garante2021'],
  evaluate({ sessions }) {
    const relevant = (phase: string, scenario: ScenarioName) => phase === 'prima' || scenario === 'rifiuta';
    const rows = sessions.flatMap((s) => [
      ...s.cookies
        .filter((c) => c.classification.category === 'sconosciuta' && relevant(c.phase, s.scenario))
        .map((c) => ({ s, key: `cookie "${c.name}" (${c.domain}, ${c.party} parte, scadenza ${c.expires ? c.expires.slice(0, 10) : 'sessione'})${hint(c.classification)}`, kind: 'cookie' })),
      ...s.storage
        .filter((st) => st.classification.category === 'sconosciuta' && st.party === 'terza' && relevant(st.phase, s.scenario))
        .map((st) => ({ s, key: `${st.kind} "${st.key}" (${st.origin})${hint(st.classification)}`, kind: 'storage' })),
      ...s.requests
        .filter((r) => r.party === 'terza' && !r.tracker && relevant(r.phase, s.scenario))
        .map((r) => ({ s, key: `terza parte ${r.host}`, kind: r.phase === 'prima' ? 'host-prima' : 'host' })),
    ]);
    const out: RawFinding[] = [];
    for (const [site, list] of groupBy(rows, (r) => r.s.site)) {
      const unique = [...new Map(list.map((r) => [r.key, r])).values()];
      const count = (...k: string[]) => unique.filter((u) => k.includes(u.kind)).length;
      // Una terza parte sconosciuta contattata prima della scelta va verificata con priorità media.
      const unknownBefore = count('host-prima');
      const first = list[0].s;
      out.push({
        site,
        scenario: null,
        pageUrl: null,
        severity: unknownBefore ? 'media' : undefined,
        groupKey: 'tutti',
        headline: unknownBefore ? `${unknownBefore} terze parti non classificate vengono contattate prima della scelta` : undefined,
        description:
          `${unique.length} elementi osservati prima della scelta o dopo il rifiuto non sono riconosciuti dalle fonti di classificazione ` +
          `(${count('cookie')} cookie, ${count('storage')} chiavi di storage di terze parti, ${count('host', 'host-prima')} domini di terze parti, di cui ${unknownBefore} contattati prima della scelta). ` +
          `Non sono stati valutati dalle altre regole: la loro natura (tecnica o di tracciamento) va verificata.`,
        details: unique.map((u) => `${u.key} — scenari: ${[...new Set(list.filter((l) => l.key === u.key).map((l) => l.s.scenario))].join(', ')}`),
        evidence: sessionEvidence(first, ['1-banner']).filter((e) => !e.file.endsWith('.har')),
      });
    }
    return out;
  },
};
