import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { parse } from 'yaml';
import type { ExitInfo } from '../browser/exit.js';
import { configSchema } from '../config/schema.js';
import type { DiscoveryResult } from '../discovery/discover.js';
import type { ComparisonRow, DeclaredSet, Finding, SessionResult } from '../types.js';
import { parseCsv, toCsv } from '../util/csv.js';
import { sha256File } from '../util/misc.js';
import { findingKey, renderHtml, type ReviewEntry, type ReviewOutcome } from './html.js';

export const REVIEW_FILE = 'revisione.csv';
const HEADERS = ['scheda', 'chiave', 'regola', 'sito', 'gravita', 'titolo', 'esito', 'nota'];

/** Esiti ammessi nella colonna "esito" (maiuscole e minuscole indifferenti). */
function normalizeOutcome(v: string): ReviewOutcome {
  const s = v.trim().toLowerCase();
  if (!s) return '';
  if (/^(confermat[ao]|ok|vero|si|sì)$/.test(s)) return 'confermato';
  if (/^(falso positivo|falso|fp|no)$/.test(s)) return 'falso positivo';
  if (/^(da verificare|dubbio|\?)$/.test(s)) return 'da verificare';
  throw new Error(`Esito non riconosciuto in ${REVIEW_FILE}: "${v}" (ammessi: confermato, falso positivo, da verificare, oppure vuoto)`);
}

export function readReview(runDir: string): Map<string, ReviewEntry> | null {
  const path = join(runDir, REVIEW_FILE);
  if (!existsSync(path)) return null;
  const rows = parseCsv(readFileSync(path, 'utf8'), ';');
  const [head, ...data] = rows;
  const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const [iKey, iEsito, iNota] = [col('chiave'), col('esito'), col('nota')];
  if (iKey < 0 || iEsito < 0) throw new Error(`${REVIEW_FILE}: mancano le colonne "chiave" ed "esito"`);
  const out = new Map<string, ReviewEntry>();
  for (const r of data) {
    const key = r[iKey]?.trim();
    if (key) out.set(key, { esito: normalizeOutcome(r[iEsito] ?? ''), nota: (iNota >= 0 ? r[iNota] : '')?.trim() ?? '' });
  }
  return out;
}

/**
 * Revisione dell'esecuzione precedente dello stesso cliente nella stessa cartella dei risultati:
 * i giudizi già dati si riportano sulle schede con la stessa chiave.
 */
function previousReview(runDir: string, cliente: string): { run: string; review: Map<string, ReviewEntry> } | null {
  const parent = dirname(runDir);
  const candidates = readdirSync(parent)
    .filter((n) => n !== basename(runDir) && n < basename(runDir) && existsSync(join(parent, n, REVIEW_FILE)) && existsSync(join(parent, n, 'manifest.json')))
    .filter((n) => {
      try {
        return (JSON.parse(readFileSync(join(parent, n, 'manifest.json'), 'utf8')) as { cliente?: string }).cliente === cliente;
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
  for (const run of candidates) {
    try {
      const review = readReview(join(parent, run));
      if (review && [...review.values()].some((e) => e.esito)) return { run, review };
    } catch {
      // revisione non leggibile: si passa alla precedente
    }
  }
  return null;
}

/** Scrive il modulo di revisione: una riga per scheda, con esito e nota da compilare (in Excel o in un editor). */
export function writeReviewTemplate(runDir: string, findings: Finding[], cliente: string): { prefilled: number; from: string | null } {
  const prev = previousReview(runDir, cliente);
  let prefilled = 0;
  const rows = findings.map((f) => {
    const old = prev?.review.get(findingKey(f));
    if (old?.esito) prefilled++;
    return [
      f.id,
      findingKey(f),
      f.ruleTitle,
      f.site,
      f.severity,
      f.headline ?? f.description.slice(0, 200),
      old?.esito ?? '',
      old?.esito ? `${old.nota}${old.nota ? ' ' : ''}(da revisione ${prev!.run})` : '',
    ];
  });
  writeFileSync(join(runDir, REVIEW_FILE), toCsv(HEADERS, rows));
  return { prefilled, from: prefilled ? prev!.run : null };
}

interface Manifest {
  strumento: { versione: string };
  inizio: string;
  fine: string;
  ambiente: { browser: string; userAgent: string; uscita: ExitInfo };
  configurazione: { contenuto: string };
  norme: { file: string };
  file: { path: string; sha256: string; bytes: number }[];
}

/**
 * Applica la revisione: genera report-rivisto.html (e .pdf) dai dati dell'esecuzione, con l'esito di ogni scheda
 * e i falsi positivi spostati in coda. Report, dati e prove originali non vengono toccati.
 */
export async function applyReview(runDir: string, opts: { pdf?: boolean } = {}): Promise<{ html: string; pdf: string | null; review: Map<string, ReviewEntry> }> {
  const review = readReview(runDir);
  if (!review) throw new Error(`Nella cartella ${runDir} manca ${REVIEW_FILE}`);
  const dati = JSON.parse(readFileSync(join(runDir, 'dati.json'), 'utf8')) as {
    discovery: DiscoveryResult[];
    sessions: SessionResult[];
    declared: DeclaredSet[];
    comparison: ComparisonRow[];
    findings: Finding[];
  };
  const m = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as Manifest;
  const config = configSchema.parse(parse(m.configurazione.contenuto));
  const html = renderHtml({
    config,
    toolVersion: m.strumento.versione,
    browserVersion: m.ambiente.browser,
    userAgent: m.ambiente.userAgent,
    startedAt: m.inizio,
    endedAt: m.fine,
    discovery: dati.discovery,
    sessions: dati.sessions,
    declared: dati.declared,
    comparison: dati.comparison,
    findings: dati.findings,
    files: m.file.filter((f) => f.path.startsWith('evidenze/')),
    normsPath: m.norme.file,
    exit: m.ambiente.uscita,
    review,
  });
  const htmlPath = join(runDir, 'report-rivisto.html');
  writeFileSync(htmlPath, html);
  let pdfPath: string | null = null;
  if (opts.pdf !== false) {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(htmlPath).toString(), { waitUntil: 'load' });
      pdfPath = join(runDir, 'report-rivisto.pdf');
      await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    } finally {
      await browser.close();
    }
  }
  // Traccia della revisione: impronte del modulo compilato e dei report rivisti
  const files = [REVIEW_FILE, 'report-rivisto.html', ...(pdfPath ? ['report-rivisto.pdf'] : [])];
  const traccia = { applicata: new Date().toISOString(), file: await Promise.all(files.map(async (f) => ({ path: f, sha256: await sha256File(join(runDir, f)) }))) };
  writeFileSync(join(runDir, 'revisione-applicata.json'), JSON.stringify(traccia, null, 2));
  return { html: htmlPath, pdf: pdfPath, review };
}
