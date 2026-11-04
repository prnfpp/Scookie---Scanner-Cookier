import { isMatomo, matomoCookieMode } from '../classify/firstparty.js';
import { requestVendor } from '../rules/helpers.js';
import { NON_TECHNICAL, type SessionResult, type TextualClaim, type TextualDeclaration } from '../types.js';

/**
 * Dichiarazione testuale di un'informativa senza tabelle leggibili: fornitori e strumenti noti nominati nel testo e
 * affermazioni tipiche sui cookie. È meno precisa dell'elenco per nome di cookie e così va presentata.
 */

/** Nome di base di un fornitore: senza le precisazioni tra parentesi, con gli alias dello stesso fornitore. */
export function vendorBase(name: string): string {
  const base = name.replace(/\s*\(.*$/, '').trim();
  if (/^(google( analytics| ads| tag manager| fonts| maps| calendar)?|you ?tube|doubleclick)$/i.test(base)) return 'Google';
  if (/^(meta|facebook|instagram)( pixel)?$/i.test(base)) return 'Meta';
  if (/^(matomo|piwik)( analytics)?$/i.test(base)) return 'Matomo';
  if (/^bing|^microsoft/i.test(base)) return 'Microsoft';
  return base;
}

/** Nomi da cercare nel testo, oltre a quelli dell'elenco dei domini. */
const EXTRA_NAMES = ['Google Analytics', 'Google Tag Manager', 'YouTube', 'Facebook', 'Instagram', 'Meta', 'Matomo', 'Piwik', 'Hotjar', 'Spotify', 'Vimeo', 'LinkedIn', 'TikTok', 'Microsoft Clarity'];

const CLAIMS: { claim: TextualClaim; re: RegExp }[] = [
  { claim: 'solo-tecnici', re: /\b(solo|soltanto|esclusivamente|unicamente)\s+(dei\s+|di\s+)?cookie\s+(tecnici|di\s+sessione|necessari)/i },
  { claim: 'no-profilazione', re: /\bnon\s+(sono\s+|vengono\s+|si\s+)?(utilizz|usat|impieg|installat)\w*\s+(alcun\s+)?cookie\s+(di\s+)?profilazione/i },
  { claim: 'no-tracciamento', re: /\bnon\s+(sono|vengono)\s+(generat|utilizzat|usat|installat)\w*\s+cookie\s+per\s+(il\s+)?tracciamento/i },
  { claim: 'terze-parti', re: /\bcookie\s+(di\s+)?terz[ae]\s+part[ie]/i },
];

export const CLAIM_LABEL: Record<TextualClaim, string> = {
  'solo-tecnici': 'solo cookie tecnici',
  'no-profilazione': 'nessun cookie di profilazione',
  'no-tracciamento': 'nessun cookie per il tracciamento',
  'terze-parti': 'cookie di terze parti',
};

/** Citazione breve (al massimo ~200 caratteri) della frase che contiene il punto indicato. */
function quoteAt(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1, text.lastIndexOf('\n', index) + 1, index - 120);
  const endDot = text.slice(index + length).search(/[.\n]/);
  const end = Math.min(text.length, endDot < 0 ? index + length + 120 : index + length + endDot + 1, index + length + 140);
  const q = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return q.length > 200 ? `${q.slice(0, 197)}…` : q;
}

export function extractTextual(
  url: string,
  how: string,
  text: { full: string; section: { title: string; text: string } | null },
  vendorNames: string[],
): TextualDeclaration | null {
  const body = text.section?.text || text.full;
  if (!/cookie/i.test(text.full)) return null;
  const names = [...new Set([...EXTRA_NAMES, ...vendorNames.map((v) => v.replace(/\s*\(.*$/, '').trim())])].filter((n) => n.length >= 3);
  const vendors = new Map<string, { name: string; quote: string }>();
  for (const n of names) {
    const re = new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu');
    // prima nella sezione sui cookie, poi in tutta la pagina
    for (const t of [body, text.full]) {
      const m = re.exec(t);
      if (!m) continue;
      const base = vendorBase(n);
      if (!vendors.has(base)) vendors.set(base, { name: base, quote: quoteAt(t, m.index + m[1].length, n.length) });
      break;
    }
  }
  const claims: TextualDeclaration['claims'] = [];
  for (const c of CLAIMS) {
    for (const t of [body, text.full]) {
      const m = c.re.exec(t);
      if (!m) continue;
      claims.push({ claim: c.claim, quote: quoteAt(t, m.index, m[0].length) });
      break;
    }
  }
  return { url, how, section: text.section?.title || null, vendors: [...vendors.values()], claims };
}

export interface TextualRow {
  vendor: string;
  status: 'osservato e citato' | 'osservato, non citato' | 'citato, non osservato';
  note: string;
}

/**
 * Confronto testuale, per fornitore: osservati e citati, osservati e non citati, citati e non osservati; per le
 * affermazioni "solo cookie tecnici" (e simili) i cookie e gli storage non tecnici osservati, se ci sono.
 */
export function compareTextual(sessions: SessionResult[], t: TextualDeclaration): { rows: TextualRow[]; claims: string[] } {
  const observed = new Map<string, Set<string>>();
  const add = (v: string, what: string) => observed.set(vendorBase(v), (observed.get(vendorBase(v)) ?? new Set()).add(what));
  for (const s of sessions) {
    for (const r of s.requests) if (r.tracker && r.tracker.category !== 'tecnico') add(requestVendor(r), r.party === 'prima' ? 'richieste sul dominio del sito' : 'richieste');
    for (const c of s.cookies) if (NON_TECHNICAL.has(c.classification.category) && c.classification.platform) add(c.classification.platform, 'cookie');
  }
  const cited = new Set(t.vendors.map((v) => v.name));
  const matomo = [...observed.keys()].some(isMatomo) ? matomoCookieMode(sessions) : null;
  const note = (v: string) => `${[...(observed.get(v) ?? [])].join(', ')}${isMatomo(v) && matomo ? `; ${matomo.state === 'senza-cookie' ? 'osservato senza cookie' : matomo.state === 'con-cookie' ? 'osservato con cookie' : 'stato dei cookie non determinabile'}` : ''}`;
  const rows: TextualRow[] = [
    ...[...observed.keys()].map((v): TextualRow => ({ vendor: v, status: cited.has(v) ? 'osservato e citato' : 'osservato, non citato', note: note(v) })),
    ...[...cited].filter((v) => !observed.has(v)).map((v): TextualRow => ({ vendor: v, status: 'citato, non osservato', note: t.vendors.find((x) => x.name === v)!.quote })),
  ];
  const claims: string[] = [];
  const nonTech = [
    ...new Set(sessions.flatMap((s) => [
      ...s.cookies.filter((c) => NON_TECHNICAL.has(c.classification.category)).map((c) => `cookie ${c.name} (${c.domain})`),
      ...s.storage.filter((st) => NON_TECHNICAL.has(st.classification.category)).map((st) => `${st.kind} ${st.key} (${st.origin})`),
    ])),
  ];
  for (const c of t.claims.filter((x) => x.claim !== 'terze-parti')) {
    claims.push(
      `"${CLAIM_LABEL[c.claim]}": ${nonTech.length ? `osservati ${nonTech.length === 1 ? '1 cookie o storage non tecnico' : `${nonTech.length} cookie o storage non tecnici`}: ${nonTech.slice(0, 10).join(', ')}${nonTech.length > 10 ? ', …' : ''}` : 'nessun cookie o storage non tecnico osservato'}`,
    );
  }
  return { rows, claims };
}
