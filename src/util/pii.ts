/**
 * Dati personali negli indirizzi e nei corpi delle richieste.
 * - Dati di prova dichiarati nella configurazione (qualsiasi tipo): riconosciuti in ogni forma, riportati in chiaro.
 * - Altri valori: per nome del parametro (targa=…, dataNascita=…, email=…) o, per email e codice fiscale, per forma;
 *   si riportano solo mascherati, perché il rapporto non diffonda a sua volta i dati.
 */

import { createHash } from 'node:crypto';

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
  const t = isDate(kind) ? v.trim().replace(/\s*([/.-])\s*/g, '$1') : v.trim();
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

/** Forma codificata di un dato di prova (hash o base64), come la inviano molti fornitori pubblicitari. */
interface EncodedForm {
  /** Valore da cercare nel testo (hash in minuscolo; base64 così com'è). */
  needle: string;
  /** Nome della codifica, per il rapporto (es. "SHA-256"). */
  how: string;
  /** Il confronto ignora le maiuscole (hash esadecimali). */
  ci: boolean;
}

/**
 * Valori da cui i fornitori calcolano l'hash: email in minuscolo e senza spazi (Gmail anche senza punti, come la
 * normalizza Google); telefono con sole cifre, con e senza prefisso internazionale e "+"; nome e cognome in minuscolo,
 * interi e parola per parola; data come aaaammgg.
 */
function hashInputs(tipo: string, v: string): string[] {
  const out = new Set<string>();
  const t = v.trim();
  if (tipo === 'email') {
    const e = t.toLowerCase().replace(/\s+/g, '');
    out.add(e);
    const [user, dom] = e.split('@');
    if (user && (dom === 'gmail.com' || dom === 'googlemail.com')) out.add(`${user.replace(/\./g, '').replace(/\+.*$/, '')}@${dom}`);
  } else if (tipo === 'telefono') {
    const digits = t.replace(/\D/g, '').replace(/^00/, '');
    if (digits.length >= 8) {
      const national = digits.length > 10 && digits.startsWith('39') ? digits.slice(2) : digits;
      const full = digits.length > 10 ? digits : `39${digits}`;
      for (const x of [digits, national, full, `+${full}`]) out.add(x);
    }
  } else if (tipo === 'nome') {
    const n = t.toLowerCase().replace(/\s+/g, ' ');
    out.add(n);
    out.add(n.replace(/ /g, ''));
    for (const w of n.split(' ')) if (w.length >= 3) out.add(w);
  } else if (isDate(tipo)) {
    const c = canon(tipo, t);
    if (/^\d{8}$/.test(c)) for (const x of [c, `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6)}`]) out.add(x);
  } else if (tipo === 'codice fiscale' || tipo === 'targa') {
    const c = canon(tipo, t);
    out.add(c);
    out.add(c.toLowerCase());
  }
  return [...out].filter((x) => x.length >= 3);
}

/** Hash (SHA-256, SHA-1, MD5, in esadecimale e in base64) e base64 del valore: le forme in cui un dato viaggia "pseudonimizzato". */
function encodedForms(tipo: string, v: string): EncodedForm[] {
  const out = new Map<string, EncodedForm>();
  const add = (needle: string, how: string, ci: boolean) => {
    if (needle.length >= 12 && !out.has(needle)) out.set(needle, { needle, how, ci });
  };
  for (const input of hashInputs(tipo, v)) {
    for (const [algo, how] of [['sha256', 'SHA-256'], ['sha1', 'SHA-1'], ['md5', 'MD5']] as const) {
      const h = createHash(algo).update(input, 'utf8');
      const buf = h.digest();
      add(buf.toString('hex'), how, true);
      const b64 = buf.toString('base64');
      add(b64, how, false);
      add(b64.replace(/=+$/, ''), how, false);
      add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), how, false);
    }
  }
  // base64 del valore in chiaro: solo per i valori abbastanza lunghi da non coincidere per caso
  if (tipo === 'email' || v.trim().length >= 9) {
    for (const input of new Set([v.trim(), v.trim().toLowerCase()])) {
      const b64 = Buffer.from(input, 'utf8').toString('base64').replace(/=+$/, '');
      // gli ultimi caratteri dipendono da ciò che segue il valore: si cerca la parte certa
      add(b64.slice(0, b64.length - (b64.length % 4 ? 1 : 0)), 'base64', false);
    }
  }
  return [...out.values()];
}

interface TestDatum {
  kind: string;
  tipo: TestType;
  value: string;
  canon: string;
  forms: string[];
  encoded: EncodedForm[];
  typed?: boolean;
  /** Campo da cui viene il valore digitato: un nuovo valore nello stesso campo sostituisce il precedente. */
  field?: string;
}

const datum = (tipo: TestType, value: string, kind: string, typed?: boolean): TestDatum => ({
  kind,
  tipo,
  value: value.trim(),
  canon: canon(tipo, value),
  forms: variants(tipo, value),
  encoded: encodedForms(tipo, value),
  ...(typed ? { typed } : {}),
});

let testData: TestDatum[] = [];

/** Dati di prova dell'esecuzione in corso (dalla configurazione). */
export function setTestData(entries: TestEntry[] | undefined) {
  testData = (entries ?? [])
    .filter((e) => typeof e.valore === 'string' && e.valore.trim().length >= 4)
    .map((e) => datum(e.tipo, e.valore, e.etichetta?.trim() || e.tipo));
}

/** Tipo di un valore digitato dall'operatore, dalla sua forma e dal nome o etichetta del campo. */
/** Data scritta con spazi attorno ai separatori (campi con maschera: "09 / 05 / 1997"). */
const tidyDate = (v: string) => v.trim().replace(/\s*([/.-])\s*/g, '$1');

/** Anno plausibile: scarta le date parziali che un campo data emette mentre si digita (0002-05-01, 0020-05-01…). */
function plausibleDate(v: string): boolean {
  const y = Number(/(\d{4})/.exec(v)?.[1]);
  return y >= 1900 && y <= 2100;
}

function guessType(raw: string, rawHint: string): { tipo: TestType; label?: string } | null {
  const v = /^\d{1,4}\s*[/.-]/.test(raw) ? tidyDate(raw) : raw;
  // il selettore del campo contiene i nomi degli attributi (es. [name="citta"]): contano solo i valori
  const hint = rawHint.replace(/\[[\w-]+=/g, '[');
  if (/^[A-Z0-9._%+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}$/i.test(v)) return { tipo: 'email' };
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$|^\d{4}-\d{2}-\d{2}$/.test(v)) return !plausibleDate(v) ? null : { tipo: 'data', label: /nasc|birth|dob/i.test(hint) ? 'data di nascita' : undefined };
  if (/^[A-Z]{2}\s?\d{3}\s?[A-Z]{2}$/i.test(v)) return { tipo: 'targa' };
  if (/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i.test(v)) return { tipo: 'codice fiscale' };
  if (/^\+?[\d\s.-]{8,}$/.test(v) && v.replace(/\D/g, '').length >= 8) return { tipo: 'telefono' };
  if (/nome|name|cognome|surname/i.test(hint) && /^[\p{L}' -]{2,60}$/u.test(v)) return { tipo: 'nome', label: /cognome|surname|last/i.test(hint) ? 'cognome' : 'nome' };
  return null;
}

/**
 * Valore inserito dall'operatore in un campo durante una navigazione manuale: vale come dato di prova (riconosciuto in
 * ogni forma e riportato in chiaro), anche se non è stato dichiarato nella configurazione o è stato digitato diverso.
 * Restituisce il dato aggiunto, o null se il valore non ha la forma di un dato personale o è già noto.
 */
export function registerTypedValue(value: string, hint = '', field?: string): TestEntry | null {
  let v = value.trim();
  // Lo stesso campo modificato di nuovo (correzione, o data digitata una cifra alla volta): vale l'ultimo valore
  if (field) testData = testData.filter((t) => !(t.typed && t.field === field));
  if (v.length < 4 || v.length > 80) return null;
  const g = guessType(v, hint);
  if (!g) return null;
  if (g.tipo === 'data') v = tidyDate(v);
  if (testData.some((t) => t.tipo === g.tipo && t.canon === canon(g.tipo, v))) return null;
  const entry: TestEntry = { tipo: g.tipo, valore: v, ...(g.label ? { etichetta: g.label } : {}) };
  testData.push({ ...datum(entry.tipo, v, entry.etichetta ?? entry.tipo, true), ...(field ? { field } : {}) });
  return entry;
}

/**
 * Valori con nome di dato personale negli indirizzi delle pagine del sito durante una navigazione manuale (es. il
 * modulo della home che apre /preventivo?dataNascita=…&targa=…): li ha inseriti l'operatore, anche quando il campo non
 * li ha consegnati come testo digitato (calendari, campi composti, selettori). Solo pagine del dominio indicato.
 */
export function typedValuesFromUrl(url: string, siteDomain: (host: string) => boolean): { value: string; hint: string; field: string }[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if (!siteDomain(u.hostname)) return [];
  const out: { value: string; hint: string; field: string }[] = [];
  for (const [name, raw] of u.searchParams) {
    const v = raw.trim();
    if (PARAMS.some((p) => p.re.test(name) && p.value.test(v))) out.push({ value: v, hint: `[name="${name}"] ${name}`, field: `url|${name}` });
  }
  return out;
}

/** Dati digitati dall'operatore e riconosciuti come dati di prova (non dichiarati nella configurazione). */
export function typedTestData(): TestEntry[] {
  return testData.filter((t) => t.typed).map((t) => ({ tipo: t.tipo, valore: t.value, ...(t.kind !== t.tipo ? { etichetta: t.kind } : {}) }));
}

/** Codice del cognome o del nome nel codice fiscale. */
function cfPart(word: string, isName: boolean): string {
  const w = word
    .normalize('NFD')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  const cons = w.replace(/[AEIOU]/g, '');
  const vow = w.replace(/[^AEIOU]/g, '');
  if (isName && cons.length >= 4) return cons[0] + cons[2] + cons[3];
  return (cons + vow + 'XXX').slice(0, 3);
}

/**
 * Codici fiscali compatibili con i dati di prova (nome, cognome, data di nascita): le prime 11 posizioni (cognome,
 * nome, anno, mese, giorno; anche per il sesso femminile). Il sito calcola spesso il codice fiscale dai dati inseriti.
 */
function cfPrefixesFromTestData(): string[] {
  const words = testData.filter((t) => t.tipo === 'nome').flatMap((t) => t.value.split(/\s+/)).filter((w) => w.length >= 2);
  const dates = testData.filter((t) => isDate(t.tipo)).map((t) => canon(t.tipo, t.value)).filter((c) => /^\d{8}$/.test(c));
  const out: string[] = [];
  for (const sur of words)
    for (const nam of words) {
      if (sur === nam) continue;
      for (const d of dates) {
        const day = Number(d.slice(6));
        const base = cfPart(sur, false) + cfPart(nam, true) + d.slice(2, 4) + 'ABCDEHLMPRST'[Number(d.slice(4, 6)) - 1];
        out.push(base + String(day).padStart(2, '0'), base + String(day + 40));
      }
    }
  return out;
}

/** Il codice fiscale è quello calcolato dai dati di prova? */
export function cfFromTestData(cf: string): boolean {
  const c = cf.toUpperCase();
  return cfPrefixesFromTestData().some((p) => c.startsWith(p));
}

/** Cognomi di prova compatibili con le prime lettere di un codice fiscale mascherato (es. RS••••••3L). */
export function maskedCfMatchesTestSurname(masked: string): string | null {
  const head = masked.slice(0, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(head)) return null;
  for (const t of testData.filter((x) => x.tipo === 'nome'))
    for (const w of t.value.split(/\s+/)) if (w.length >= 2 && cfPart(w, false).startsWith(head)) return w;
  return null;
}

/** Mascheratura senza eccezioni (come nelle rilevazioni in cui il dato non era ancora noto come dato di prova). */
function rawMask(v: string): string {
  if (v.includes('@')) {
    const [user, dom] = v.split('@');
    return `${user.slice(0, 1)}•••@${dom}`;
  }
  if (v.length <= 4) return '•'.repeat(v.length);
  return `${v.slice(0, 2)}${'•'.repeat(Math.min(6, v.length - 4))}${v.slice(-2)}`;
}

/**
 * Valori mascherati in una rilevazione precedente che corrispondono a un dato di prova (dichiarato o digitato
 * dall'operatore): tornano in chiaro e certi. Serve a rigenerare un rapporto quando i dati di prova in configurazione
 * non coincidevano con quelli digitati.
 */
export function reviveTestHits(hits: PiiHit[]): PiiHit[] {
  return hits.map((h) => {
    if (h.test) return h;
    const t = testData.find((x) => (isDate(x.tipo) ? isDate(h.kind) || h.kind === 'data di nascita' : x.tipo === h.kind || x.kind === h.kind) && x.forms.some((f) => rawMask(f) === h.masked));
    return t ? { ...h, kind: t.kind, masked: t.value, test: true } : h;
  });
}

/** Il valore coincide con un dato di prova dichiarato (in una qualsiasi delle sue forme)? */
const testMatch = (v: string) => testData.find((t) => t.canon === canon(t.tipo, v));

const PARAMS: { kind: PiiKind; re: RegExp; value: RegExp }[] = [
  { kind: 'targa', re: /^(targa|plate|license_?plate|licence_?plate|numero_?targa)$/i, value: /^[A-Z]{2}\s?\d{3}\s?[A-Z]{2}$|^[A-Z0-9]{5,8}$/i },
  { kind: 'data di nascita', re: /^(data_?(di_?)?nascita|nascita|birth_?date|date_?of_?birth|dob|birthday)$/i, value: /\d/ },
  { kind: 'email', re: /^(e-?mail|mail|email_?address)$/i, value: /@/ },
  { kind: 'codice fiscale', re: /^(codice_?fiscale|cod_?fisc|cf|tax_?code|fiscal_?code)$/i, value: /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i },
  { kind: 'telefono', re: /^(telefono|tel|cellulare|cell|phone|phone_?number|mobile)$/i, value: /^\+?[\d\s.-]{8,}$/ },
  // identificativi con hash dichiarati dal nome del parametro (es. sha256_email_address, hashed_email, em): il valore
  // non è leggibile, ma il nome dice che deriva da un'email o da un telefono
  { kind: 'email con hash', re: /^(em|hem|sha256_?email(_?address)?|hashed_?email|email_?hash|email_?sha256|md5_?email|sha256_?em)$/i, value: /^[a-f0-9]{32}$|^[a-f0-9]{40}$|^[a-f0-9]{64}$/i },
  { kind: 'telefono con hash', re: /^(ph|sha256_?phone(_?number)?|hashed_?phone(_?number)?|phone_?hash)$/i, value: /^[a-f0-9]{32}$|^[a-f0-9]{40}$|^[a-f0-9]{64}$/i },
];
/** Oltre questa lunghezza un testo si analizza per coppie nome=valore solo nella prima parte; i dati di prova si cercano ovunque. */
const PAIR_SCAN_CHARS = 20000;
/** Limite della ricerca dei dati di prova nei corpi molto grandi (registrazioni di sessione, invii a lotti). */
const FULL_SCAN_CHARS = 4_000_000;
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
  if (/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i.test(v) && cfFromTestData(v)) return v;
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

/** `needle` compare in `hay` come parola intera: non preceduto né seguito da lettere o cifre. */
function wholeWord(hay: string, needle: string): boolean {
  const word = /[\p{L}\p{N}]/u;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    if (!word.test(hay[i - 1] ?? '') && !word.test(hay[i + needle.length] ?? '')) return true;
  }
  return false;
}

export function detectPii(...texts: (string | null | undefined)[]): PiiHit[] {
  const out = new Map<string, PiiHit>();
  const add = (h: PiiHit) => out.set(`${h.kind}|${h.param}|${h.masked}`, h);
  for (const raw of texts) {
    if (!raw) continue;
    const text = decodeDeep(raw.slice(0, PAIR_SCAN_CHARS));
    // i dati di prova si cercano in tutto il testo: nei corpi grandi stanno spesso oltre la prima parte
    const whole = raw.length > PAIR_SCAN_CHARS ? decodeDeep(raw.slice(0, FULL_SCAN_CHARS)) : text;
    // coppie nome=valore (query, form, frammenti) e "nome":"valore" (JSON)
    for (const m of text.matchAll(/(?:^|[?&;#,{\s"'])([A-Za-z_][\w-]{1,30})"?\s*[=:]\s*"?([^&;,"'\s}?]{2,80})/g)) {
      const [, name, value] = m;
      const p = PARAMS.find((x) => x.re.test(name));
      const v = value.trim();
      const t = testMatch(v);
      if (t) add({ kind: t.kind, param: name, masked: t.value, test: true });
      else if (p?.kind === 'codice fiscale' && p.value.test(v) && cfFromTestData(v)) add({ kind: 'codice fiscale calcolato dai dati di prova', param: name, masked: v.toUpperCase(), test: true });
      else if (p && p.value.test(v) && (p.kind !== 'email' || isEmail(v)) && (p.kind !== 'codice fiscale' || cfValid(v))) add({ kind: p.kind, param: name, masked: maskValue(v) });
    }
    for (const { raw, ...h } of shapeHits(text)) {
      const t = testMatch(raw);
      if (t) add({ kind: t.kind, param: null, masked: t.value, test: true });
      else if (h.kind === 'codice fiscale' && cfFromTestData(raw)) add({ kind: 'codice fiscale calcolato dai dati di prova', param: null, masked: raw.toUpperCase(), test: true });
      else add(h);
    }
    // i dati di prova si cercano anche come valori nudi (es. dentro un JSON o un percorso); i testi liberi
    // (nomi, indirizzi) senza distinguere le maiuscole
    const lower = whole.toLowerCase();
    for (const t of testData) {
      const hay = isText(t.tipo) ? lower : whole;
      // testi liberi (nomi, indirizzi): solo come parola intera, altrimenti "Test" scatta su "ab-testing" e "Rosa" su "prosa"
      const found = isText(t.tipo) ? t.forms.some((f) => wholeWord(hay, f.toLowerCase())) : t.forms.some((f) => hay.includes(f));
      if (found) add({ kind: t.kind, param: null, masked: t.value, test: true });
      // lo stesso dato come hash o in base64 (es. l'email in SHA-256 inviata ai fornitori pubblicitari)
      const enc = t.encoded.find((e) => (e.ci ? lower.includes(e.needle) : whole.includes(e.needle)));
      if (enc) add({ kind: `${t.kind} (${enc.how === 'base64' ? 'in base64' : `hash ${enc.how}`})`, param: null, masked: t.value, test: true });
    }
  }
  // la stessa email trovata per nome di parametro e per forma conta una volta
  const hits = [...out.values()];
  const other = hits.filter((h) => !h.test && (h.param || !hits.some((o) => o !== h && o.param && o.kind === h.kind && o.masked === h.masked)));
  // un dato di prova conta una volta per tipo, nella forma dichiarata, col nome del parametro se c'è
  const tests = [...new Set(hits.filter((h) => h.test).map((h) => h.kind))].map((kind) => {
    const hs = hits.filter((h) => h.test && h.kind === kind);
    const value = testData.find((t) => t.kind === kind)?.value ?? hs.find((h) => h.masked)?.masked ?? '';
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
  for (const m of decoded.matchAll(/(?:^|[?&;#,{\s"'])([A-Za-z_][\w-]{1,30})"?\s*[=:]\s*"?([^&;,"'\s}?]{2,80})/g)) {
    const p = PARAMS.find((x) => x.re.test(m[1]));
    if (p && p.value.test(m[2].trim())) values.add(m[2].trim());
  }
  for (const h of shapeHits(decoded)) values.add(h.raw);
  for (const v of values) {
    // dato di prova (dichiarato o digitato dall'operatore): resta com'è, anche nella forma codificata
    if (maskValue(v) === v) continue;
    // il valore può comparire in chiaro o codificato (una o due volte)
    for (const form of new Set([v, encodeURIComponent(v), encodeURIComponent(encodeURIComponent(v))])) out = out.split(form).join(maskValue(v));
  }
  return out;
}
