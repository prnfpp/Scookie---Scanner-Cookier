/**
 * Dati personali negli indirizzi e nei corpi delle richieste.
 * - Dati di prova dichiarati nella configurazione (qualsiasi tipo): riconosciuti in ogni forma, riportati in chiaro.
 * - Altri valori: per nome del parametro (targa=…, dataNascita=…, email=…) o, per email e codice fiscale, per forma;
 *   si riportano solo mascherati, perché il rapporto non diffonda a sua volta i dati.
 */

/** Tipo di dato: per i valori trovati per nome o forma (targa, data di nascita…); per i dati di prova, il tipo dichiarato. */
export type PiiKind = string;

export interface PiiHit {
  kind: PiiKind;
  /** Nome del parametro in cui è stato trovato, se c'è. */
  param: string | null;
  /** Valore mascherato (es. GA•••MD); in chiaro se è un dato di prova dichiarato. */
  masked: string;
  /** Coincide con un dato di prova dichiarato nella configurazione (inserito dall'operatore). */
  test?: boolean;
}

/** Tipi di dato di prova: decidono come riconoscere il valore nelle sue varianti (es. le date in più formati). */
export const TEST_TYPES = ['email', 'telefono', 'data', 'codice fiscale', 'targa', 'nome', 'indirizzo', 'altro'] as const;
export type TestType = (typeof TEST_TYPES)[number];
export interface TestEntry {
  tipo: TestType;
  valore: string;
  /** Come chiamarlo nel rapporto (es. "data di nascita"); predefinito: il tipo. */
  etichetta?: string;
}

const isDate = (k: string) => k === 'data' || k === 'data di nascita';
/** Testi liberi: si confrontano senza distinguere maiuscole e spazi multipli. */
const isText = (k: string) => k === 'nome' || k === 'indirizzo' || k === 'altro';

/** Forma canonica per il confronto: date come aaaammgg, testi in minuscolo, il resto senza spazi e separatori. */
function canon(kind: string, v: string): string {
  const t = v.trim();
  if (isDate(kind)) {
    let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
    if (m) return `${m[3]}${m[2].padStart(2, '0')}${m[1].padStart(2, '0')}`;
    m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(t);
    if (m) return `${m[1]}${m[2].padStart(2, '0')}${m[3].padStart(2, '0')}`;
  }
  if (kind === 'email') return t.toLowerCase();
  if (isText(kind)) return t.toLowerCase().replace(/\s+/g, ' ');
  return t.replace(/[\s.\-/]/g, '').toUpperCase();
}

/** Forme in cui un dato di prova può comparire in un testo (es. la data come 01/01/1990 o 1990-01-01). */
function variants(kind: string, v: string): string[] {
  const out = new Set([v.trim()]);
  if (isDate(kind)) {
    const c = canon(kind, v);
    if (/^\d{8}$/.test(c)) {
      const [y, m, d] = [c.slice(0, 4), c.slice(4, 6), c.slice(6)];
      for (const x of [`${d}/${m}/${y}`, `${y}-${m}-${d}`, `${d}-${m}-${y}`, `${d}.${m}.${y}`, `${y}${m}${d}`]) out.add(x);
    }
  }
  if (kind === 'targa' || kind === 'codice fiscale') out.add(v.trim().toUpperCase());
  if (kind === 'telefono') out.add(v.replace(/[\s.-]/g, ''));
  return [...out].filter((x) => x.length >= 4);
}

let testData: { kind: string; tipo: TestType; value: string; canon: string; forms: string[] }[] = [];

/** Dati di prova dell'esecuzione in corso (dalla configurazione). */
export function setTestData(entries: TestEntry[] | undefined) {
  testData = (entries ?? [])
    .filter((e) => typeof e.valore === 'string' && e.valore.trim().length >= 4)
    .map((e) => ({ kind: e.etichetta?.trim() || e.tipo, tipo: e.tipo, value: e.valore.trim(), canon: canon(e.tipo, e.valore), forms: variants(e.tipo, e.valore) }));
}

/** Il valore coincide con un dato di prova dichiarato (in una qualsiasi delle sue forme)? */
const testMatch = (v: string) => testData.find((t) => t.canon === canon(t.tipo, v));

const PARAMS: { kind: PiiKind; re: RegExp; value: RegExp }[] = [
  { kind: 'targa', re: /^(targa|plate|license_?plate|licence_?plate|numero_?targa)$/i, value: /^[A-Z]{2}\s?\d{3}\s?[A-Z]{2}$|^[A-Z0-9]{5,8}$/i },
  { kind: 'data di nascita', re: /^(data_?(di_?)?nascita|nascita|birth_?date|date_?of_?birth|dob|birthday)$/i, value: /\d/ },
  { kind: 'email', re: /^(e-?mail|mail|email_?address)$/i, value: /@/ },
  { kind: 'codice fiscale', re: /^(codice_?fiscale|cod_?fisc|cf|tax_?code|fiscal_?code)$/i, value: /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i },
  { kind: 'telefono', re: /^(telefono|tel|cellulare|cell|phone|phone_?number|mobile)$/i, value: /^\+?[\d\s.-]{8,}$/ },
];
const EMAIL = /[A-Z0-9._%+-]{2,}@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const CF = /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/gi;
/** Targa nel percorso dell'indirizzo (es. /quotazione/auto/AB123CD/1990-01-01), con l'eventuale data che la segue. */
const PATH_PLATE = /\/([A-Z]{2}\d{3}[A-Z]{2})(?:\/(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4}))?(?=[/?#&"'\s]|$)/g;
/** Estensioni di file: "logo@2x.png" non è un indirizzo email. */
const FILE_EXT = /^(png|jpe?g|gif|svg|webp|avif|ico|bmp|js|mjs|css|json|map|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|html?|php|xml|txt)$/i;

const isEmail = (v: string) => !FILE_EXT.test(v.split('.').pop() ?? '');

/** Carattere di controllo del codice fiscale: scarta le sequenze casuali che ne hanno solo la forma. */
function cfValid(cf: string): boolean {
  const c = cf.toUpperCase();
  const ODD: Record<string, number> = {};
  const oddVals = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((ch, i) => (ODD[ch] = oddVals[i]));
  '0123456789'.split('').forEach((ch, i) => (ODD[ch] = oddVals[i]));
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = c[i];
    if (i % 2 === 0) sum += ODD[ch];
    else sum += /\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26)) === c[15];
}

/** Valori trovati per forma, fuori da coppie nome=valore. */
function shapeHits(text: string): (PiiHit & { raw: string })[] {
  const out: (PiiHit & { raw: string })[] = [];
  for (const m of text.matchAll(EMAIL)) if (isEmail(m[0])) out.push({ kind: 'email', param: null, masked: maskValue(m[0]), raw: m[0] });
  for (const m of text.matchAll(CF)) if (cfValid(m[0])) out.push({ kind: 'codice fiscale', param: null, masked: maskValue(m[0]), raw: m[0] });
  for (const m of text.matchAll(PATH_PLATE)) {
    out.push({ kind: 'targa', param: null, masked: maskValue(m[1]), raw: m[1] });
    if (m[2]) out.push({ kind: 'data di nascita', param: null, masked: maskValue(m[2]), raw: m[2] });
  }
  return out;
}

export function maskValue(v: string): string {
  // i dati di prova dichiarati sono fittizi o concordati: restano in chiaro
  if (testMatch(v)) return v;
  if (v.includes('@')) {
    const [user, dom] = v.split('@');
    return `${user.slice(0, 1)}•••@${dom}`;
  }
  if (v.length <= 4) return '•'.repeat(v.length);
  return `${v.slice(0, 2)}${'•'.repeat(Math.min(6, v.length - 4))}${v.slice(-2)}`;
}

/** Decodifica ripetuta: i dati spesso viaggiano dentro un indirizzo a sua volta codificato in un parametro. */
function decodeDeep(s: string): string {
  let cur = s;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(cur.replace(/\+/g, ' '));
      if (next === cur) break;
      cur = next;
    } catch {
      break;
    }
  }
  return cur;
}

export function detectPii(...texts: (string | null | undefined)[]): PiiHit[] {
  const out = new Map<string, PiiHit>();
  const add = (h: PiiHit) => out.set(`${h.kind}|${h.param}|${h.masked}`, h);
  for (const raw of texts) {
    if (!raw) continue;
    const text = decodeDeep(raw.slice(0, 20000));
    // coppie nome=valore (query, form, frammenti) e "nome":"valore" (JSON)
    for (const m of text.matchAll(/(?:^|[?&;#,{\s"'])([A-Za-z_][\w-]{1,30})"?\s*[=:]\s*"?([^&;,"'\s}?]{2,60})/g)) {
      const [, name, value] = m;
      const p = PARAMS.find((x) => x.re.test(name));
      const v = value.trim();
      const t = testMatch(v);
      if (t) add({ kind: t.kind, param: name, masked: t.value, test: true });
      else if (p && p.value.test(v) && (p.kind !== 'email' || isEmail(v)) && (p.kind !== 'codice fiscale' || cfValid(v))) add({ kind: p.kind, param: name, masked: maskValue(v) });
    }
    for (const { raw, ...h } of shapeHits(text)) {
      const t = testMatch(raw);
      add(t ? { kind: t.kind, param: null, masked: t.value, test: true } : h);
    }
    // i dati di prova si cercano anche come valori nudi (es. dentro un JSON o un percorso); i testi liberi
    // (nomi, indirizzi) senza distinguere le maiuscole
    const lower = text.toLowerCase();
    for (const t of testData) {
      const hay = isText(t.tipo) ? lower : text;
      if (t.forms.some((f) => hay.includes(isText(t.tipo) ? f.toLowerCase() : f))) add({ kind: t.kind, param: null, masked: t.value, test: true });
    }
  }
  // la stessa email trovata per nome di parametro e per forma conta una volta
  const hits = [...out.values()];
  const other = hits.filter((h) => !h.test && (h.param || !hits.some((o) => o !== h && o.param && o.kind === h.kind && o.masked === h.masked)));
  // un dato di prova conta una volta per tipo, nella forma dichiarata, col nome del parametro se c'è
  const tests = [...new Set(hits.filter((h) => h.test).map((h) => h.kind))].map((kind) => {
    const hs = hits.filter((h) => h.test && h.kind === kind);
    const value = testData.find((t) => t.kind === kind)?.value ?? hs[0].masked;
    return { kind, param: hs.find((h) => h.param)?.param ?? null, masked: value, test: true };
  });
  return [...tests, ...other];
}

/** Sostituisce nel testo i valori dei dati personali con la loro versione mascherata. */
export function maskPii(text: string): string {
  if (!text) return text;
  let out = text;
  const decoded = decodeDeep(text);
  const values = new Set<string>();
  for (const m of decoded.matchAll(/(?:^|[?&;#,{\s"'])([A-Za-z_][\w-]{1,30})"?\s*[=:]\s*"?([^&;,"'\s}?]{2,60})/g)) {
    const p = PARAMS.find((x) => x.re.test(m[1]));
    if (p && p.value.test(m[2].trim())) values.add(m[2].trim());
  }
  for (const h of shapeHits(decoded)) values.add(h.raw);
  for (const v of values) {
    // il valore può comparire in chiaro o codificato (una o due volte)
    for (const form of new Set([v, encodeURIComponent(v), encodeURIComponent(encodeURIComponent(v))])) out = out.split(form).join(maskValue(v));
  }
  return out;
}
