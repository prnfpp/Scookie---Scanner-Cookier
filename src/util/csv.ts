/** Parser CSV minimale (RFC 4180): virgolette, separatori e a capo dentro i campi. */
export function parseCsv(text: string, separator = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === separator) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Indovina il separatore guardando l'intestazione. */
export function detectSeparator(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((sep) => [sep, header.split(sep).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

/** CSV con separatore ";" e BOM, così si apre correttamente in Excel con impostazioni italiane. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    const str = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v);
    return /[";\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return '﻿' + [headers, ...rows].map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}
