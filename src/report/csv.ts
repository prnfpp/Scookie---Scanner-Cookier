import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComparisonRow, DeclaredSet, Finding, SessionResult } from '../types.js';
import { compareTextual } from '../declared/textual.js';
import { toCsv } from '../util/csv.js';
import { repeatsShort } from './repeats.js';

/**
 * Elemento del confronto osservato dopo il rifiuto: "sì" o "no" se il rifiuto è stato eseguito sul sito,
 * "non-applicabile" se non lo è stato (nessun banner, comando non trovato, sessioni non valide).
 */
function afterReject(sessions: SessionResult[], c: ComparisonRow): string {
  const rej = sessions.filter((s) => s.site === c.site && s.scenario === 'rifiuta' && s.interaction.outcome === 'eseguito' && !s.blocked && !s.unreachable);
  if (!rej.length) return NA;
  const name = (n: string) => n === c.name;
  const dom = (d: string) => !c.domain || d.replace(/^\./, '') === c.domain;
  const seen = rej.some((s) =>
    c.kind === 'servizio'
      ? s.requests.some((r) => r.phase === 'dopo' && r.tracker?.company === c.name)
      : c.kind === 'storage'
        ? s.storage.some((st) => st.phase === 'dopo' && name(st.key))
        : s.cookies.some((k) => name(k.name) && dom(k.domain) && (k.phase === 'dopo' || k.renewals?.some((x) => x.stage === 'scelta'))),
  );
  return seen ? 'sì' : 'no';
}

/** Valore esplicito per una cella che non si applica (scenario non eseguito, nessuna scelta): mai una cella vuota. */
export const NA = 'non-applicabile';

/**
 * Esito della scelta di una sessione, per distinguere "0 osservati" (scelta eseguita) da "non applicabile"
 * (scenario senza scelta, nessun banner, comando non trovato).
 */
export function choiceStatus(s: SessionResult): string {
  if (s.scenario === 'nessuna-azione') return `${NA} (nessuna-azione)`;
  if (s.interaction.outcome === 'eseguito') return 'eseguita';
  if (!s.interaction.bannerVisibleBefore && !s.interaction.detectedCmps.length) return `${NA} (nessun banner)`;
  return `${NA} (scelta non eseguita: ${s.interaction.outcome})`;
}

/** Scrive i dati grezzi in CSV (separatore ";", UTF-8 con BOM per Excel). Ritorna i nomi dei file. */
export function writeCsvs(dir: string, sessions: SessionResult[], comparison: ComparisonRow[], findings: Finding[], declared: DeclaredSet[] = []): string[] {
  const files: [string, string][] = [
    [
      'sessioni.csv',
      toCsv(
        ['sessione', 'sito', 'scenario', 'tipo_pagina', 'pagine', 'inizio', 'fine', 'momento_scelta', 'cmp_rilevati', 'banner_visibile', 'banner_visibile_dopo_scelta', 'banner_alla_pagina_successiva', 'metodo', 'livello', 'via', 'esito', 'dettaglio', 'verifica', 'dettaglio_verifica', 'har', 'errori'],
        sessions.map((s) => [
          s.id, s.site, s.scenario, s.pageType, s.pages.join(' '), s.startedAt, s.endedAt, s.choiceAt, s.interaction.detectedCmps,
          s.interaction.bannerVisibleBefore, s.interaction.bannerVisibleAfter, s.interaction.bannerOnNextPage, s.interaction.method, s.interaction.layer, s.interaction.via, s.interaction.outcome,
          s.interaction.detail, s.interaction.verification, s.interaction.verificationDetail, s.har, s.errors.join(' | '),
        ]),
      ),
    ],
    [
      'cookie.csv',
      toCsv(
        ['sessione', 'sito', 'scenario', 'esito_scelta', 'nome', 'dominio', 'path', 'parte', 'fase', 'momento', 'scadenza', 'httpOnly', 'secure', 'sameSite', 'categoria', 'fonte_categoria', 'piattaforma', 'prima_pagina', 'prima_osservazione', 'valore_anteprima'],
        sessions.flatMap((s) =>
          s.cookies.map((c) => [
            s.id, s.site, s.scenario, choiceStatus(s), c.name, c.domain, c.path, c.party, c.phase, c.stage, c.expires ?? 'sessione', c.httpOnly, c.secure, c.sameSite,
            c.classification.category, c.classification.source, c.classification.platform, c.firstSeenUrl, c.firstSeenAt, c.valuePreview,
          ]),
        ),
      ),
    ],
    [
      'storage.csv',
      toCsv(
        ['sessione', 'sito', 'scenario', 'origine', 'tipo', 'chiave', 'parte', 'fase', 'momento', 'categoria', 'fonte_categoria', 'piattaforma', 'prima_pagina', 'prima_osservazione', 'valore_anteprima'],
        sessions.flatMap((s) =>
          s.storage.map((st) => [
            s.id, s.site, s.scenario, st.origin, st.kind, st.key, st.party, st.phase, st.stage, st.classification.category, st.classification.source,
            st.classification.platform, st.firstSeenUrl, st.firstSeenAt, st.valuePreview,
          ]),
        ),
      ),
    ],
    [
      'richieste.csv',
      toCsv(
        ['sessione', 'sito', 'scenario', 'esito_scelta', 'seq', 'orario', 'ms_dalla_scelta', 'fase', 'momento', 'metodo', 'tipo', 'stato', 'host', 'parte', 'fornitore', 'categoria', 'parametri_consenso', 'server_side', 'errore', 'pagina', 'inviata_all_uscita', 'url'],
        sessions.flatMap((s) =>
          s.requests.map((r) => [
            s.id, s.site, s.scenario, choiceStatus(s), r.seq, r.at, r.msFromChoice ?? NA, r.phase, r.stage, r.method, r.resourceType, r.status, r.host, r.party,
            r.tracker?.company, r.tracker?.category, r.consentParams ? JSON.stringify(r.consentParams) : '', r.serverSide, r.failure, r.pageUrl, r.sentOnExit ?? false, r.url,
          ]),
        ),
      ),
    ],
    [
      'confronto-dichiarati.csv',
      toCsv(
        ['sito', 'tipo', 'nome', 'dominio', 'stato', 'categorie_dichiarate', 'sempre_attivo', 'categoria_osservata', 'differenza_categoria', 'scenari', 'osservato_dopo_rifiuto'],
        comparison.map((c) => [
          c.site, c.kind, c.name, c.domain, c.status, c.declaredCategories, c.declaredAlwaysActive, c.observedCategory ?? 'non-osservato', c.categoryIssue ?? 'nessuna',
          c.scenarios.length ? c.scenarios : 'nessuno', afterReject(sessions, c),
        ]),
      ),
    ],
    [
      'confronto-testuale.csv',
      toCsv(
        ['sito', 'informativa', 'trovata_come', 'fornitore', 'esito', 'osservato_o_citazione'],
        declared.filter((d) => d.textual).flatMap((d) => {
          const t = d.textual!;
          const cmp = compareTextual(sessions.filter((s) => s.site === d.site && !s.blocked && !s.unreachable), t);
          return [...cmp.rows.map((x) => [d.site, t.url, t.how, x.vendor, x.status, x.note]), ...cmp.claims.map((c) => [d.site, t.url, t.how, NA, 'affermazione', c])];
        }),
      ),
    ],
    [
      'rilievi.csv',
      toCsv(
        ['id', 'regola', 'titolo', 'gravita', 'sito', 'scenario', 'pagina', 'osservato', 'descrizione', 'dettagli', 'evidenze', 'norme'],
        findings.map((f) => [
          f.id, f.ruleId, f.ruleTitle, f.severity, f.site, f.scenario, f.pageUrl, f.repeats ? repeatsShort(f.repeats) : '', f.description, f.details.join(' | '),
          f.evidence.map((e) => e.file), f.norms.map((n) => n.title),
        ]),
      ),
    ],
  ];
  for (const [name, content] of files) writeFileSync(join(dir, name), content);
  return files.map(([n]) => n);
}
