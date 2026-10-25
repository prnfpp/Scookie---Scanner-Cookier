/**
 * Dati personali negli indirizzi e nei corpi delle richieste: targa, data di nascita, email, codice fiscale, telefono.
 * Si cercano sia per nome del parametro (targa=…, dataNascita=…) sia, per email e codice fiscale, per forma del valore.
 * I valori trovati si riportano solo mascherati: il report non deve diffondere a sua volta i dati.
 */

export type PiiKind = 'targa' | 'data di nascita' | 'email' | 'codice fiscale' | 'telefono';

export interface PiiHit {
  kind: PiiKind;
  /** Nome del parametro in cui è stato trovato, se c'è. */
  param: string | null;
  /** Valore mascherato (es. GA•••MD). */
  masked: string;
}

const PARAMS: { kind: PiiKind; re: RegExp; value: RegExp }[] = [
  { kind: 'targa', re: /^(targa|plate|license_?plate|licence_?plate|numero_?targa)$/i, value: /^[A-Z]{2}\s?\d{3}\s?[A-Z]{2}$|^[A-Z0-9]{5,8}$/i },
  { kind: 'data di nascita', re: /^(data_?(di_?)?nascita|nascita|birth_?date|date_?of_?birth|dob|birthday)$/i, value: /\d/ },
  { kind: 'email', re: /^(e-?mail|mail|email_?address)$/i, value: /@/ },
  { kind: 'codice fiscale', re: /^(codice_?fiscale|cod_?fisc|cf|tax_?code|fiscal_?code)$/i, value: /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i },
  { kind: 'telefono', re: /^(telefono|tel|cellulare|cell|phone|phone_?number|mobile)$/i, value: /^\+?[\d\s.-]{8,}$/ },
];
const EMAIL = /[A-Z0-9._%+-]{2,}@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const CF = /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/gi;

export function maskValue(v: string): string {
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
      if (p && p.value.test(value.trim())) add({ kind: p.kind, param: name, masked: maskValue(value.trim()) });
    }
    for (const m of text.matchAll(EMAIL)) add({ kind: 'email', param: null, masked: maskValue(m[0]) });
    for (const m of text.matchAll(CF)) add({ kind: 'codice fiscale', param: null, masked: maskValue(m[0]) });
  }
  // la stessa email trovata per nome di parametro e per forma conta una volta
  const hits = [...out.values()];
  return hits.filter((h) => h.param || !hits.some((o) => o !== h && o.param && o.kind === h.kind && o.masked === h.masked));
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
  for (const m of decoded.matchAll(EMAIL)) values.add(m[0]);
  for (const m of decoded.matchAll(CF)) values.add(m[0]);
  for (const v of values) {
    // il valore può comparire in chiaro o codificato (una o due volte)
    for (const form of new Set([v, encodeURIComponent(v), encodeURIComponent(encodeURIComponent(v))])) out = out.split(form).join(maskValue(v));
  }
  return out;
}
