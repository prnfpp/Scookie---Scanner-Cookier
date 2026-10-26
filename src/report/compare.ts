import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import type { Finding, Severity } from '../types.js';
import { CSS, esc, fmt, sevBadge } from './html.js';

const SEV: Severity[] = ['alta', 'media', 'bassa', 'informativa'];

export interface RunSummary {
  dir: string;
  name: string;
  cliente: string;
  inizio: string | null;
  findings: Finding[];
  /** Condizioni della rilevazione: servono a dire se due rilevazioni sono confrontabili. */
  condizioni: { strumento: string; configurazione: string; impronta: string; scenari: string; ripetizioni: string; paese: string };
}

export interface RunComparison {
  prima: RunSummary;
  dopo: RunSummary;
  risolte: Finding[];
  nuove: Finding[];
  rimaste: { prima: Finding; dopo: Finding; gravita: 'uguale' | 'aumentata' | 'diminuita' }[];
  /** Siti presenti in una sola delle due esecuzioni: le loro schede non si possono confrontare. */
  sitiSoloPrima: string[];
  sitiSoloDopo: string[];
}

/** Chiave di confronto; per esecuzioni precedenti all'introduzione di "key" la si ricostruisce. */
const keyOf = (f: Finding) => f.key ?? `${f.ruleId}|${f.site}|${f.scenario ?? ''}|${f.headline ?? f.description.slice(0, 160)}`;

export function loadRun(dir: string): RunSummary {
  const dati = join(dir, 'dati.json');
  if (!existsSync(dati)) throw new Error(`Nella cartella ${dir} manca dati.json: non è un'esecuzione di scookie`);
  const data = JSON.parse(readFileSync(dati, 'utf8')) as { findings?: Finding[] };
  let cliente = '';
  let inizio: string | null = null;
  const condizioni = { strumento: '—', configurazione: '—', impronta: '—', scenari: '—', ripetizioni: '—', paese: '—' };
  const man = join(dir, 'manifest.json');
  if (existsSync(man)) {
    const m = JSON.parse(readFileSync(man, 'utf8')) as {
      cliente?: string;
      inizio?: string;
      strumento?: { versione?: string; commit?: string | null };
      configurazione?: { file?: string; sha256?: string; contenuto?: string };
      ambiente?: { uscita?: { country?: string | null } };
    };
    cliente = m.cliente ?? '';
    inizio = m.inizio ?? null;
    condizioni.strumento = `${m.strumento?.versione ?? '—'}${m.strumento?.commit ? ` (${m.strumento.commit})` : ''}`;
    condizioni.configurazione = m.configurazione?.file ?? '—';
    condizioni.impronta = m.configurazione?.sha256?.slice(0, 16) ?? '—';
    condizioni.paese = m.ambiente?.uscita?.country ?? '—';
    try {
      const cfg = parse(m.configurazione?.contenuto ?? '') as { scenari?: { attivi?: string[]; ripetizioni?: number } } | null;
      condizioni.scenari = cfg?.scenari?.attivi?.join(', ') ?? 'tutti';
      condizioni.ripetizioni = String(cfg?.scenari?.ripetizioni ?? 1);
    } catch {
      // configurazione non leggibile: restano i trattini
    }
  }
  return { dir, name: basename(dir), cliente, inizio, findings: data.findings ?? [], condizioni };
}

const sitesOf = (fs: Finding[]) => new Set(fs.flatMap((f) => (f.sites?.length ? f.sites : [f.site])));

/**
 * Confronta i rilievi di due esecuzioni: risolte (solo nella prima), nuove (solo nella seconda), rimaste.
 * Il confronto è per regola, oggetto e dominio, non per numero di scheda (i numeri cambiano tra rilevazioni).
 */
export function compareRuns(prima: RunSummary, dopo: RunSummary): RunComparison {
  const a = new Map(prima.findings.map((f) => [keyOf(f), f]));
  const b = new Map(dopo.findings.map((f) => [keyOf(f), f]));
  const sa = sitesOf(prima.findings);
  const sb = sitesOf(dopo.findings);
  const rimaste: RunComparison['rimaste'] = [];
  for (const [k, fb] of b) {
    const fa = a.get(k);
    if (!fa) continue;
    const d = SEV.indexOf(fb.severity) - SEV.indexOf(fa.severity);
    rimaste.push({ prima: fa, dopo: fb, gravita: d === 0 ? 'uguale' : d < 0 ? 'aumentata' : 'diminuita' });
  }
  const bySev = (x: Finding, y: Finding) => SEV.indexOf(x.severity) - SEV.indexOf(y.severity);
  return {
    prima,
    dopo,
    risolte: [...a].filter(([k]) => !b.has(k)).map(([, f]) => f).sort(bySev),
    nuove: [...b].filter(([k]) => !a.has(k)).map(([, f]) => f).sort(bySev),
    rimaste: rimaste.sort((x, y) => bySev(x.dopo, y.dopo)),
    sitiSoloPrima: [...sa].filter((s) => !sb.has(s)),
    sitiSoloDopo: [...sb].filter((s) => !sa.has(s)),
  };
}

const title = (f: Finding) => esc(f.headline ?? f.ruleTitle);

const COND: [keyof RunSummary['condizioni'], string][] = [
  ['strumento', 'Versione dello strumento'],
  ['configurazione', 'File di configurazione'],
  ['impronta', 'Impronta della configurazione'],
  ['scenari', 'Scenari'],
  ['ripetizioni', 'Ripetizioni'],
  ['paese', 'Paese di uscita'],
];

function table(rows: Finding[], empty: string) {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<table><tr><th style="width:8%">Rilievo</th><th style="width:10%">Priorità di verifica</th><th>Fatto osservato</th><th style="width:26%">Sito</th></tr>${rows
    .map((f) => `<tr><td>${esc(f.id)}</td><td>${sevBadge(f.severity)}</td><td>${title(f)}<br><span class="muted">${esc(f.ruleTitle)}</span></td><td>${esc(f.site)}</td></tr>`)
    .join('')}</table>`;
}

export function renderComparison(c: RunComparison): string {
  const when = (r: RunSummary) => (r.inizio ? fmt(r.inizio) : r.name);
  const cliente = c.dopo.cliente || c.prima.cliente;
  const parts: string[] = [];
  parts.push(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confronto tra rilevazioni – ${esc(cliente)}</title><style>${CSS}</style></head><body>
<h1>Confronto tra due rilevazioni</h1>
<p class="muted">Committente: ${esc(cliente)}</p>
<table class="kv">
<tr><td>Rilevazione precedente</td><td>${esc(when(c.prima))} — <code>${esc(c.prima.name)}</code> (${c.prima.findings.length} rilievi)</td></tr>
<tr><td>Rilevazione successiva</td><td>${esc(when(c.dopo))} — <code>${esc(c.dopo.name)}</code> (${c.dopo.findings.length} rilievi)</td></tr>
<tr><td>Esito</td><td><strong>${c.risolte.length}</strong> non più osservati · <strong>${c.rimaste.length}</strong> ancora presenti · <strong>${c.nuove.length}</strong> nuovi</td></tr>
</table>
<h2>Condizioni delle due rilevazioni</h2>
<table><tr><th>Condizione</th><th>Precedente</th><th>Successiva</th></tr>${COND.map(([k, label]) => {
    const a = c.prima.condizioni[k];
    const b = c.dopo.condizioni[k];
    return `<tr><td>${esc(label)}</td><td>${esc(a)}</td><td>${a === b ? esc(b) : `<strong>${esc(b)}</strong>`}</td></tr>`;
  }).join('')}</table>
${(() => {
  const diff = COND.filter(([k]) => k !== 'configurazione' && c.prima.condizioni[k] !== c.dopo.condizioni[k]).map(([, l]) => l.toLowerCase());
  return diff.length
    ? `<p class="warn"><strong>Condizioni diverse</strong> (${esc(diff.join(', '))}). Un rilievo "nuovo" o "non più osservato" può dipendere anche da queste differenze (per esempio da regole aggiornate nello strumento) e non solo da modifiche del sito. Per un confronto a parità di condizioni si ripete la rilevazione precedente con la stessa versione dello strumento e la stessa configurazione.</p>`
    : '<p class="muted">Stessa versione dello strumento, stessa configurazione e stesse condizioni di rilevazione.</p>';
})()}
<p class="muted">I rilievi sono abbinati per regola, oggetto (cookie, fornitore, categoria…) e dominio, non per numero: i numeri R-xxx (C-xxx nelle versioni precedenti del tool) si riferiscono al rapporto di ciascuna esecuzione.
"Non più osservato" significa che nella seconda esecuzione, sulle pagine visitate, il fatto non si è ripresentato; non è una verifica di conformità.</p>`);
  if (c.sitiSoloPrima.length || c.sitiSoloDopo.length) {
    parts.push(`<p class="warn">Le due esecuzioni non coprono gli stessi siti${c.sitiSoloPrima.length ? `; solo nella prima: ${esc(c.sitiSoloPrima.join(', '))}` : ''}${
      c.sitiSoloDopo.length ? `; solo nella seconda: ${esc(c.sitiSoloDopo.join(', '))}` : ''
    }. Per questi siti i rilievi risultano "non più osservati" o "nuovi" solo perché il sito non è stato controllato in entrambe.</p>`);
  }
  parts.push(`<h2>Non più osservati (${c.risolte.length})</h2>${table(c.risolte, 'Nessun rilievo della prima esecuzione è scomparso.')}`);
  parts.push(`<h2>Nuovi (${c.nuove.length})</h2>${table(c.nuove, 'Nessun rilievo nuovo.')}`);
  parts.push(`<h2>Ancora presenti (${c.rimaste.length})</h2>`);
  if (!c.rimaste.length) parts.push('<p class="muted">Nessuno.</p>');
  else
    parts.push(
      `<table><tr><th style="width:12%">Rilievi</th><th style="width:18%">Priorità di verifica</th><th>Fatto osservato</th><th style="width:26%">Sito</th></tr>${c.rimaste
        .map(
          (r) =>
            `<tr><td>${esc(r.prima.id)} → ${esc(r.dopo.id)}</td><td>${
              r.gravita === 'uguale' ? sevBadge(r.dopo.severity) : `${sevBadge(r.prima.severity)} → ${sevBadge(r.dopo.severity)}<br><span class="muted">${r.gravita}</span>`
            }</td><td>${title(r.dopo)}<br><span class="muted">${esc(r.dopo.ruleTitle)}</span></td><td>${esc(r.dopo.site)}</td></tr>`,
        )
        .join('')}</table>`,
    );
  parts.push('</body></html>');
  return parts.join('\n');
}

/** Scrive confronto.html nella cartella della seconda esecuzione e ne restituisce il percorso. */
export function writeComparison(primaDir: string, dopoDir: string, out?: string): { path: string; comparison: RunComparison } {
  const comparison = compareRuns(loadRun(primaDir), loadRun(dopoDir));
  const path = out ?? join(dopoDir, `confronto-con-${basename(primaDir)}.html`);
  writeFileSync(path, renderComparison(comparison));
  return { path, comparison };
}
