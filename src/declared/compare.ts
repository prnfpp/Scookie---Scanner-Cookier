import { NON_TECHNICAL, type Category, type ComparisonRow, type DeclaredItem, type DeclaredSet, type ScenarioName, type SessionResult } from '../types.js';

const PLACEHOLDER = /(\*|[xX]{3,}|<[^>]*>|\{[^}]*\}|\[[^\]]*\]|#{2,}|\.{3}|…)/;

/**
 * Converte un nome dichiarato in un'espressione regolare.
 * Gli elenchi usano segnaposto come _ga_xxxxxxx, _ga_*, _ga_<container-id>, _hjSession_{id}.
 * Un nome che termina con "_" o "-" vale come prefisso.
 */
export function declaredPattern(name: string): RegExp {
  const n = name.trim();
  const parts = n.split(new RegExp(PLACEHOLDER.source, 'g'));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let body = parts.map((p) => (p && new RegExp(`^${PLACEHOLDER.source}$`).test(p) ? '.+' : esc(p))).join('');
  if (!PLACEHOLDER.test(n) && /[_-]$/.test(n)) body += '.*';
  return new RegExp(`^${body}$`, 'i');
}

interface Observed {
  name: string;
  domain: string;
  kind: 'cookie' | 'storage';
  category: Category;
  scenarios: Set<ScenarioName>;
  platform?: string;
}

function collectObserved(sessions: SessionResult[]): Map<string, Observed> {
  const map = new Map<string, Observed>();
  const add = (o: Omit<Observed, 'scenarios'>, scenario: ScenarioName) => {
    const key = `${o.kind}|${o.name}|${o.domain}`;
    const cur = map.get(key) ?? { ...o, scenarios: new Set<ScenarioName>() };
    cur.scenarios.add(scenario);
    map.set(key, cur);
  };
  for (const s of sessions) {
    for (const c of s.cookies) {
      add({ name: c.name, domain: c.domain.replace(/^\./, ''), kind: 'cookie', category: c.classification.category, platform: c.classification.platform }, s.scenario);
    }
    // Delle chiavi di storage si confrontano solo quelle riconosciute come non tecniche:
    // gli elenchi dichiarati raramente le riportano tutte.
    for (const st of s.storage) {
      if (!NON_TECHNICAL.has(st.classification.category)) continue;
      add({ name: st.key, domain: new URL(st.origin).hostname, kind: 'storage', category: st.classification.category, platform: st.classification.platform }, s.scenario);
    }
  }
  return map;
}

/** Aziende dei tracker osservati (per il confronto con elenchi dichiarati per servizio). */
function observedCompanies(sessions: SessionResult[]): Map<string, { category: Category; scenarios: Set<ScenarioName> }> {
  const out = new Map<string, { category: Category; scenarios: Set<ScenarioName> }>();
  for (const s of sessions) {
    for (const r of s.requests) {
      if (!r.tracker || !NON_TECHNICAL.has(r.tracker.category)) continue;
      const cur = out.get(r.tracker.company) ?? { category: r.tracker.category, scenarios: new Set<ScenarioName>() };
      cur.scenarios.add(s.scenario);
      out.set(r.tracker.company, cur);
    }
  }
  return out;
}

const looselyEqual = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.includes(y) || y.includes(x);
};

export function compareDeclared(site: string, sessions: SessionResult[], declared: DeclaredSet): ComparisonRow[] {
  if (!declared.items.length) return [];
  const rows: ComparisonRow[] = [];
  const cookieDecl = declared.items.filter((d) => d.kind === 'cookie').map((d) => ({ d, re: declaredPattern(d.name) }));
  const serviceDecl = declared.items.filter((d) => d.kind === 'servizio');
  const matchedDecl = new Set<DeclaredItem>();

  if (cookieDecl.length) {
    for (const o of collectObserved(sessions).values()) {
      const hits = cookieDecl.filter(({ re }) => re.test(o.name)).map(({ d }) => d);
      hits.forEach((h) => matchedDecl.add(h));
      const categories = [...new Set(hits.map((h) => h.declaredCategory || h.category))];
      const normalized = new Set(hits.map((h) => h.category));
      let categoryIssue: ComparisonRow['categoryIssue'] = null;
      if (hits.length && NON_TECHNICAL.has(o.category) && hits.every((h) => h.category === 'tecnico' || h.alwaysActive)) {
        categoryIssue = 'incoerente';
      } else if (normalized.size > 1) categoryIssue = 'categorie-multiple';
      rows.push({
        site,
        name: o.name,
        domain: o.domain,
        kind: o.kind,
        status: hits.length ? 'dichiarato' : 'non-dichiarato',
        declaredCategories: categories,
        declaredAlwaysActive: hits.some((h) => h.alwaysActive),
        observedCategory: o.category,
        categoryIssue,
        scenarios: [...o.scenarios],
      });
    }
  }

  if (serviceDecl.length) {
    for (const [company, info] of observedCompanies(sessions)) {
      const hits = serviceDecl.filter((d) => looselyEqual(d.name, company));
      hits.forEach((h) => matchedDecl.add(h));
      rows.push({
        site,
        name: company,
        domain: '',
        kind: 'servizio',
        status: hits.length ? 'dichiarato' : 'non-dichiarato',
        declaredCategories: [...new Set(hits.map((h) => h.declaredCategory))],
        declaredAlwaysActive: hits.some((h) => h.alwaysActive),
        observedCategory: info.category,
        categoryIssue: hits.length && hits.every((h) => h.alwaysActive || h.category === 'tecnico') ? 'incoerente' : null,
        scenarios: [...info.scenarios],
      });
    }
  }

  for (const d of declared.items) {
    if (matchedDecl.has(d)) continue;
    rows.push({
      site,
      name: d.name,
      domain: d.domain ?? '',
      kind: d.kind,
      status: 'dichiarato-non-osservato',
      declaredCategories: [d.declaredCategory],
      declaredAlwaysActive: d.alwaysActive,
      observedCategory: null,
      categoryIssue: null,
      scenarios: [],
    });
  }
  return rows;
}
