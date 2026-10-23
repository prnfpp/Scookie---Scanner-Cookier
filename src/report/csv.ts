import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComparisonRow, Finding, SessionResult } from '../types.js';
import { toCsv } from '../util/csv.js';

/** Scrive i dati grezzi in CSV (separatore ";", UTF-8 con BOM per Excel). Ritorna i nomi dei file. */
export function writeCsvs(dir: string, sessions: SessionResult[], comparison: ComparisonRow[], findings: Finding[]): string[] {
  const files: [string, string][] = [
    [
      'sessioni.csv',
      toCsv(
        ['sessione', 'sito', 'scenario', 'tipo_pagina', 'pagine', 'inizio', 'fine', 'momento_scelta', 'cmp_rilevati', 'banner_visibile', 'metodo', 'livello', 'via', 'esito', 'dettaglio', 'verifica', 'dettaglio_verifica', 'har', 'errori'],
        sessions.map((s) => [
          s.id, s.site, s.scenario, s.pageType, s.pages.join(' '), s.startedAt, s.endedAt, s.choiceAt, s.interaction.detectedCmps,
          s.interaction.bannerVisibleBefore, s.interaction.method, s.interaction.layer, s.interaction.via, s.interaction.outcome,
          s.interaction.detail, s.interaction.verification, s.interaction.verificationDetail, s.har, s.errors.join(' | '),
        ]),
      ),
    ],
    [
      'cookie.csv',
      toCsv(
        ['sessione', 'sito', 'scenario', 'nome', 'dominio', 'path', 'parte', 'fase', 'scadenza', 'httpOnly', 'secure', 'sameSite', 'categoria', 'fonte_categoria', 'piattaforma', 'prima_pagina', 'prima_osservazione', 'valore_anteprima'],
        sessions.flatMap((s) =>
          s.cookies.map((c) => [
            s.id, s.site, s.scenario, c.name, c.domain, c.path, c.party, c.phase, c.expires ?? 'sessione', c.httpOnly, c.secure, c.sameSite,
            c.classification.category, c.classification.source, c.classification.platform, c.firstSeenUrl, c.firstSeenAt, c.valuePreview,
          ]),
        ),
      ),
    ],
    [
      'storage.csv',
      toCsv(
        ['sessione', 'sito', 'scenario', 'origine', 'tipo', 'chiave', 'parte', 'fase', 'categoria', 'fonte_categoria', 'piattaforma', 'prima_pagina', 'prima_osservazione', 'valore_anteprima'],
        sessions.flatMap((s) =>
          s.storage.map((st) => [
            s.id, s.site, s.scenario, st.origin, st.kind, st.key, st.party, st.phase, st.classification.category, st.classification.source,
            st.classification.platform, st.firstSeenUrl, st.firstSeenAt, st.valuePreview,
          ]),
        ),
      ),
    ],
    [
      'richieste.csv',
      toCsv(
        ['sessione', 'sito', 'scenario', 'seq', 'momento', 'ms_dalla_scelta', 'fase', 'metodo', 'tipo', 'stato', 'host', 'parte', 'fornitore', 'categoria', 'parametri_consenso', 'server_side', 'pagina', 'url'],
        sessions.flatMap((s) =>
          s.requests.map((r) => [
            s.id, s.site, s.scenario, r.seq, r.at, r.msFromChoice, r.phase, r.method, r.resourceType, r.status, r.host, r.party,
            r.tracker?.company, r.tracker?.category, r.consentParams ? JSON.stringify(r.consentParams) : '', r.serverSide, r.pageUrl, r.url,
          ]),
        ),
      ),
    ],
    [
      'confronto-dichiarati.csv',
      toCsv(
        ['sito', 'tipo', 'nome', 'dominio', 'stato', 'categorie_dichiarate', 'sempre_attivo', 'categoria_osservata', 'problema_categoria', 'scenari'],
        comparison.map((c) => [c.site, c.kind, c.name, c.domain, c.status, c.declaredCategories, c.declaredAlwaysActive, c.observedCategory, c.categoryIssue, c.scenarios]),
      ),
    ],
    [
      'criticita.csv',
      toCsv(
        ['id', 'regola', 'titolo', 'gravita', 'sito', 'scenario', 'pagina', 'descrizione', 'dettagli', 'evidenze', 'norme'],
        findings.map((f) => [
          f.id, f.ruleId, f.ruleTitle, f.severity, f.site, f.scenario, f.pageUrl, f.description, f.details.join(' | '),
          f.evidence.map((e) => e.file), f.norms.map((n) => n.title),
        ]),
      ),
    ],
  ];
  for (const [name, content] of files) writeFileSync(join(dir, name), content);
  return files.map(([n]) => n);
}
