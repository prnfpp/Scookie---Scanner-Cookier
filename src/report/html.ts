import type { ExitInfo } from '../browser/exit.js';
import type { AuditConfig } from '../config/schema.js';
import type { DiscoveryResult } from '../discovery/discover.js';
import { CATEGORY_LABEL, EVIDENCE_LABEL, groupBy } from '../rules/helpers.js';
import type { ComparisonRow, DeclaredSet, Finding, SessionResult, Severity } from '../types.js';
import { NON_TECHNICAL } from '../types.js';
import { repeatsText } from './repeats.js';
import { summaryItems } from './summary.js';

export interface ReportInput {
  config: AuditConfig;
  /** Nome del file di configurazione usato (distinto dal nome del cliente). */
  configFile?: string;
  toolVersion: string;
  browserVersion: string;
  userAgent: string;
  startedAt: string;
  endedAt: string;
  discovery: DiscoveryResult[];
  sessions: SessionResult[];
  declared: DeclaredSet[];
  comparison: ComparisonRow[];
  findings: Finding[];
  files: { path: string; sha256: string; bytes: number }[];
  normsPath: string;
  exit: ExitInfo;
  /** Revisione manuale (revisione.csv compilato): esito e nota per scheda, per chiave stabile. */
  review?: Map<string, ReviewEntry>;
}

export type ReviewOutcome = 'confermato' | 'falso positivo' | 'da verificare' | '';
export interface ReviewEntry {
  esito: ReviewOutcome;
  nota: string;
}

/** Chiave stabile di una scheda (anche per esecuzioni precedenti all'introduzione di "key"). */
export const findingKey = (f: Finding) => f.key ?? `${f.ruleId}|${f.site}|${f.scenario ?? ''}|${f.headline ?? f.description.slice(0, 160)}`;

export const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SEV: Severity[] = ['alta', 'media', 'bassa', 'informativa'];
export const sevBadge = (s: Severity) => `<span class="sev sev-${s}">${esc(s)}</span>`;
export const fmt = (iso: string) => new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

const LIMITS = [
  'Il controllo è campionario: sono state visitate solo le pagine elencate. Comportamenti presenti in altre pagine non sono coperti.',
  'Ogni scenario parte da un profilo browser pulito. Il risultato può variare con test A/B, aste pubblicitarie, geolocalizzazione e configurazioni del CMP diverse per paese.',
  'Il tracciamento lato server non è osservabile: se il sito invia dati a un proprio endpoint (es. /g/collect su un sottodominio proprio), i destinatari finali non sono visibili dal browser.',
  'La classificazione di cookie e domini si basa su Open Cookie Database e su un elenco di domini curato; gli elementi "non classificati" vanno valutati caso per caso.',
  'Il paese di uscita è rilevato una volta all\'avvio tramite un servizio esterno (vedi Perimetro e metodo); la geolocalizzazione per IP può essere imprecisa.',
  'Il tool documenta fatti tecnici e li collega a riferimenti normativi; la valutazione di conformità spetta al consulente legale o al DPO.',
];

export const CSS = `
:root{--fg:#1d1d1f;--muted:#5f6368;--line:#dadce0;--bg:#fff;--alt:#f6f7f9;--alta:#b3261e;--media:#b26a00;--bassa:#1a73e8;--info:#5f6368}
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px;max-width:1100px;margin:auto}
h1{font-size:26px;margin:0 0 4px}h2{font-size:20px;border-bottom:2px solid var(--fg);padding-bottom:4px;margin-top:40px;page-break-after:avoid}h3{font-size:16px;margin:18px 0 6px}
.muted{color:var(--muted)}.warn{border:1px solid var(--media);background:#fff4e5;padding:8px 12px;border-radius:6px}table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:12.5px}th,td{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top;word-break:break-word}th{background:var(--alt)}
.sev{display:inline-block;padding:1px 8px;border-radius:10px;color:#fff;font-size:12px;font-weight:600;text-transform:uppercase}.sev-alta{background:var(--alta)}.sev-media{background:var(--media)}.sev-bassa{background:var(--bassa)}.sev-informativa{background:var(--info)}
.card{border:1px solid var(--line);border-left:5px solid var(--info);border-radius:6px;padding:12px 16px;margin:14px 0;page-break-inside:avoid}.card.alta{border-left-color:var(--alta)}.card.media{border-left-color:var(--media)}.card.bassa{border-left-color:var(--bassa)}
.card h3{margin-top:0}.shots{display:flex;gap:8px;flex-wrap:wrap}.shots figure{margin:0;width:calc(50% - 4px)}.shots img{width:100%;border:1px solid var(--line)}figcaption{font-size:11px;color:var(--muted)}
pre{background:var(--alt);padding:8px;font-size:11.5px;white-space:pre-wrap;word-break:break-all;border-radius:4px}code{font-size:12px}
ul{margin:4px 0;padding-left:20px}.kv td:first-child{width:28%;font-weight:600;background:var(--alt)}
@page{size:A4;margin:14mm 12mm}@media print{body{padding:0 2px;max-width:none;width:auto}a{color:inherit}table{table-layout:fixed}}`;

/**
 * Righe della tabella delle interazioni: le sessioni consecutive "nessuna azione" dello stesso sito con lo stesso esito
 * (una per pagina del campione) diventano una riga sola; l'elenco completo resta in sessioni.csv.
 */
/** Una riga per sito e scenario (sessioni manuali a parte): il dettaglio di ogni sessione è in sessioni.csv. */
function sessionRows(sessions: SessionResult[]) {
  const groups = new Map<string, SessionResult[]>();
  for (const s of sessions) {
    const k = `${s.site}|${s.scenario}|${s.manual ? 'manuale' : ''}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  /** Valori distinti con il conteggio, il più frequente per primo: "eseguito (3)". */
  const tally = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([v, n]) => (m.size > 1 || xs.length > 1 ? `${v} (${n})` : v));
  };
  return [...groups.values()].map((list) => ({
    s: list[0],
    n: list.length,
    pages: [...new Set(list.map((x) => x.pages.length))].join('/'),
    cmps: tally(list.map((x) => x.interaction.detectedCmps.join(', ') || 'nessun CMP')),
    banner: tally(list.map((x) => (x.interaction.bannerVisibleBefore ? 'visibile' : 'non rilevato'))),
    method: tally(list.map((x) => x.interaction.method)),
    outcome: tally(list.map((x) => x.interaction.outcome)),
    verification: tally(list.map((x) => x.interaction.verification)),
  }));
}

export function renderHtml(r: ReportInput): string {
  const { config, sessions } = r;
  // Con la revisione manuale, le schede segnate come falso positivo escono dal corpo del report e vanno in coda
  const reviewOf = (f: Finding) => r.review?.get(findingKey(f));
  const findings = r.findings.filter((f) => reviewOf(f)?.esito !== 'falso positivo');
  const excluded = r.findings.filter((f) => reviewOf(f)?.esito === 'falso positivo');
  const sites = [...new Set(sessions.map((s) => s.site))];
  const parts: string[] = [];

  parts.push(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audit cookie – ${esc(config.cliente)}</title><style>${CSS}</style></head><body>
<h1>Audit tecnico cookie e tracciamenti</h1>
<p class="muted">${esc(config.cliente)} · esecuzione del ${esc(fmt(r.startedAt))} · Scookie ${esc(r.toolVersion)}</p>
${r.review ? `<p class="warn"><strong>Report rivisto.</strong> È stata applicata la revisione manuale delle schede (file <code>revisione.csv</code>): ${r.findings.filter((f) => reviewOf(f)?.esito === 'confermato').length} confermate, ${excluded.length} escluse come falso positivo (elencate in fondo alla sezione 3), ${r.findings.filter((f) => !reviewOf(f)?.esito).length} non revisionate. I dati raccolti e le prove non cambiano.</p>` : ''}
${!r.exit.matches ? `<p class="warn"><strong>Attenzione — paese di uscita.</strong> ${esc(r.exit.note)}</p>` : ''}
<p>Questo documento descrive cosa avviene nel browser dell'utente rispetto alle scelte sul banner di consenso, con le relative prove. Non contiene valutazioni di conformità né indicazioni correttive.</p>`);

  parts.push(`<h2>Come leggere questo report</h2>
<ul>
<li><strong>Cosa è.</strong> Una documentazione tecnica di quanto avviene nel browser di un visitatore, raccolta in modo automatico e ripetibile, con le relative prove (screenshot, file HAR, dati grezzi). Non è una perizia, né un parere legale: la valutazione di conformità spetta al consulente legale o al DPO.</li>
<li><strong>Le criticità</strong> sono fatti osservati che una regola tecnica segnala come meritevoli di verifica, ciascuno collegato ai riferimenti normativi pertinenti.</li>
<li><strong>La gravità</strong> (alta, media, bassa, informativa) indica la <em>priorità di verifica suggerita</em>, definita nella tabella delle regole e modificabile; non è una qualificazione giuridica.
  <ul><li><em>alta</em>: tracciamenti di marketing, statistica o registrazione sessioni prima della scelta o dopo il rifiuto;</li>
  <li><em>media</em>: aspetti del banner o dell'informativa che possono incidere sulla validità del consenso;</li>
  <li><em>bassa</em>: incoerenze documentali o elementi da classificare;</li>
  <li><em>informativa</em>: contesto utile alla lettura (es. tracciamento lato server, banner assente senza tracciamenti).</li></ul></li>
<li><strong>Le prove</strong> sono nella cartella <code>evidenze/</code>; i nomi dei file richiamano il numero della criticità. L'impronta SHA-256 di ogni file è in <code>manifest.json</code>, insieme alla configurazione usata: permette di verificare che i file non siano stati modificati dopo la raccolta.</li>
<li><strong>Il perimetro</strong> è un campione di pagine visitate in una certa data, da un certo paese e con un certo browser (sezione 1): pagine non visitate, aree riservate e momenti diversi possono dare risultati diversi.</li>
</ul>`);

  // Sintesi per il legale: i fatti principali in una frase, con rimando alle schede.
  const host = (s: string) => {
    try {
      return new URL(s).hostname;
    } catch {
      return s;
    }
  };
  const top = summaryItems(findings).slice(0, 10);
  const inTop = new Set(top.flatMap((i) => i.findings.map((f) => f.id)));
  const blockedSites = [...new Set(sessions.filter((s) => s.blocked).map((s) => host(s.site)))];
  const unreachable = sessions.filter((s) => s.unreachable);
  const unreachableSites = [...new Set(unreachable.map((s) => host(s.site)))];
  const allUnreachable = unreachableSites.filter((h) => sessions.filter((s) => host(s.site) === h).every((s) => s.unreachable || s.blocked));
  parts.push(`<h2>Sintesi per il legale</h2>
${top.length ? `<p>I fatti principali, raggruppati per causa e in ordine di priorità di verifica (gravità, forza della prova e ripetibilità). Le schede che derivano dallo stesso fatto sono riunite in un punto solo; il dettaglio e le prove sono nelle schede indicate.</p>
<ol>${top.map((i) => `<li>${esc(i.title)} <span class="muted">(${esc(i.hosts.join(', '))}${i.repeats ? ` · ${esc(i.repeats)}` : ''})</span> — ${sevBadge(i.severity)} ${i.findings.map((f) => `<a href="#${f.id}">${f.id}</a>`).join(', ')}</li>`).join('')}</ol>` : '<p>Non sono emersi fatti con priorità alta o media.</p>'}
${findings.length > inTop.size ? `<p class="muted">Altre ${findings.length - inTop.size} schede, di priorità minore o di contesto, sono elencate nella sezione 3.</p>` : ''}
${blockedSites.length ? `<p class="warn"><strong>Attenzione.</strong> Su ${esc(blockedSites.join(', '))} la navigazione è stata intercettata da un sistema anti-bot: le sessioni coinvolte non sono valide e non sono state usate per le criticità.</p>` : ''}
${unreachable.length ? `<p class="warn"><strong>Attenzione — pagine non caricate.</strong> ${unreachable.length} sessioni non hanno potuto caricare il sito (${esc(unreachableSites.join(', '))}), per esempio per connessione assente o computer in stop: non sono valide e non sono state usate per le criticità.${allUnreachable.length ? ` Per ${esc(allUnreachable.join(', '))} non c'è nessun dato: il report non dice nulla su ${allUnreachable.length === 1 ? 'questo sito' : 'questi siti'} e l'audit va ripetuto.` : ''}</p>` : ''}`);

  // 1. Perimetro e metodo
  parts.push(`<h2>1. Perimetro e metodo</h2><table class="kv">
<tr><td>Cliente</td><td>${esc(config.cliente)}</td></tr>
${r.configFile ? `<tr><td>Configurazione</td><td><code>${esc(r.configFile)}</code></td></tr>` : ''}
<tr><td>Inizio / fine</td><td>${esc(fmt(r.startedAt))} — ${esc(fmt(r.endedAt))}</td></tr>
<tr><td>Strumento</td><td>Scookie ${esc(r.toolVersion)}; browser ${esc(r.browserVersion)} (${config.browser.canale === 'chromium' ? 'Chromium incluso nel tool' : `${esc(config.browser.canale)} installato sul computer`}, ${config.browser.headless ? 'senza finestra (headless)' : 'con finestra visibile'}${config.browser.headless && r.sessions.some((s) => s.manual) ? '; navigazioni manuali con finestra visibile' : ''})</td></tr>
<tr><td>User agent</td><td><code>${esc(r.userAgent)}</code>${config.browser.uaNormale ? '<br><span class="muted">Esecuzione di controllo: user agent di un browser normale, senza la dichiarazione dell\'audit.</span>' : ''}</td></tr>
<tr><td>Lingua / fuso orario</td><td>${esc(config.browser.locale)} / ${esc(config.browser.timezone)}</td></tr>
<tr><td>Paese di uscita</td><td>dichiarato ${esc(r.exit.declared)}; ${r.exit.verified ? `rilevato <strong>${esc(r.exit.country)}</strong> (IP ${esc(r.exit.ip)}, fonte ${esc(r.exit.source)})` : 'non rilevato'}${config.browser.proxy ? ' — tramite proxy' : ''}<br><span class="muted">${esc(r.exit.note)}</span></td></tr>
<tr><td>Scenari</td><td>${esc(config.scenari.attivi.join(', '))} — modalità "${esc(config.scenari.modalita)}", ${config.scenari.pagineDopoScelta} pagine visitate dopo la scelta${config.scenari.ripetizioni > 1 ? `; ogni scenario ripetuto ${config.scenari.ripetizioni} volte con un profilo browser nuovo` : ''}</td></tr>
${(() => {
  const t = Object.entries(config.datiDiProva ?? {}).filter(([, v]) => v);
  const label: Record<string, string> = { targa: 'targa', dataNascita: 'data di nascita', email: 'email', codiceFiscale: 'codice fiscale', telefono: 'telefono' };
  return t.length ? `<tr><td>Dati di prova</td><td>Inseriti dall'operatore nelle navigazioni manuali, fittizi o concordati col cliente: ${t.map(([k, v]) => `${esc(label[k] ?? k)} <code>${esc(String(v))}</code>`).join('; ')}. Nelle schede sono riportati in chiaro; gli altri valori che somigliano a dati personali sono mascherati.</td></tr>` : '';
})()}
<tr><td>Protocollo di osservazione</td><td>Per ogni pagina: caricamento completo, attesa della rete inattiva (max 5 s), attesa fissa di ${config.protocollo.attesaDopoCaricamento} ms${config.protocollo.scroll ? `, scroll fino a fondo pagina e attesa di ${config.protocollo.attesaDopoScroll} ms` : ''}. Sulla prima pagina il banner viene fotografato e l'eventuale scelta avviene <em>prima</em> dello scroll; dopo la scelta si attendono ${config.protocollo.attesaDopoScelta} ms. In tutti gli scenari con scelta il percorso dopo la scelta è lo stesso: si ricarica la pagina di partenza e si visitano le stesse pagine nello stesso ordine; nello scenario di revoca lo stesso percorso si ripete dopo la revoca. Pausa tra sessioni: ${config.protocollo.pausaTraSessioni} ms. Ogni sessione usa un profilo browser nuovo.</td></tr>
<tr><td>File HAR</td><td>Uno per sessione, con URL, intestazioni, cookie, tempi e corpi delle richieste. Corpi delle risposte: ${config.report.harContenuti === 'tutti' ? 'tutti' : config.report.harContenuti === 'testo' ? 'solo testuali fino a 512 KB (immagini, font e video omessi)' : 'omessi'}${config.report.harCompressi ? ', e solo per le sessioni citate nelle schede. File compressi (.har.gz): su Mac un doppio clic restituisce il .har, che si apre negli strumenti per sviluppatori del browser' : ''}.</td></tr>
<tr><td>Tabella norme</td><td>${esc(r.normsPath)}</td></tr>
</table>`);

  parts.push('<h3>Pagine campionate</h3>');
  for (const d of r.discovery) {
    parts.push(`<p><strong>${esc(d.site)}</strong> — ${d.found} URL scoperte; tipi: ${esc(Object.entries(d.byType).map(([k, v]) => `${k} (${v})`).join(', ') || '—')}</p>
<table><tr><th>#</th><th>Tipo</th><th>Origine</th><th>URL</th></tr>${d.sample.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.type)}</td><td>${esc(p.source)}</td><td>${esc(p.url)}</td></tr>`).join('')}</table>
${d.notes.length ? `<ul class="muted">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`);
    // Navigazione manuale dell'operatore: istruzioni, pagine percorse e come si è conclusa
    for (const s of sessions.filter((x) => x.site === d.site && x.manual)) {
      const m = s.manual!;
      const end = m.endedBy === 'operatore' ? "conclusa dall'operatore" : m.endedBy === 'tempo' ? 'interrotta allo scadere del tempo massimo' : 'interrotta: finestra chiusa';
      parts.push(`<p><strong>Navigazione manuale</strong> — sessione ${esc(s.id)}, scenario "${esc(s.scenario)}", ${end} dopo ${m.seconds} s. Istruzioni date all'operatore: "${esc(m.instructions)}".${m.pages.length <= 1 || m.seconds < 60 ? ' <strong>Probabilmente incompleta</strong> (troppo breve o una sola pagina): i fatti che ne derivano vanno confermati rifacendola.' : ''}</p>
<ol class="muted">${m.pages.map((u) => `<li>${esc(u)}</li>`).join('')}</ol>`);
    }
  }

  parts.push(`<h3>Interazione con il banner</h3><p>Per ogni sito e scenario: CMP riconosciuti, metodo che ha eseguito la scelta (selettori manuali, adattatore del CMP, euristica sui testi, API del CMP) e verifica dello stato del consenso registrato dopo la scelta.</p>
<p class="muted">Una riga per sito e scenario; tra parentesi il numero di sessioni con quel valore. Il dettaglio di ogni sessione (pagine, clic, verifica) è in <code>sessioni.csv</code>.</p>
<table><tr><th style="width:24%">Sito · scenario</th><th style="width:10%">Sessioni</th><th style="width:16%">CMP / banner</th><th style="width:16%">Metodo</th><th>Esito (esempio)</th><th style="width:14%">Verifica</th></tr>
${sessionRows(sessions)
  .map(
    (g) => `<tr><td>${esc(new URL(g.s.site).hostname)}<br><span class="muted">${esc(g.s.scenario)}${g.s.manual ? ' · navigazione manuale' : ''}</span></td><td>${g.n}<br><span class="muted">${esc(g.pages)} pag.</span></td><td>${esc(g.cmps.join('; '))}<br><span class="muted">banner ${esc(g.banner.join('; '))}</span></td>
<td>${esc(g.method.join('; '))}</td><td>${esc(g.outcome.join('; '))}<br><span class="muted">${esc(g.s.interaction.detail)}</span></td><td>${esc(g.verification.join('; '))}</td></tr>`,
  )
  .join('')}</table>`);

  const retried = sessions.filter((s) => s.retryOf);
  if (retried.length) {
    parts.push(`<p><strong>Sessioni ripetute.</strong> Quando un sito mostra il banner in alcune sessioni e non in altre, le sessioni senza banner vengono ripetute una volta. La sessione originale resta nei dati (<code>dati.json</code>, voce <code>sessioniScartate</code>) e nelle evidenze.</p>
<ul>${retried.map((s) => `<li>${esc(s.retryOf)} → ${esc(s.id)}: ${esc(s.errors[0] ?? '')}</li>`).join('')}</ul>`);
  }
  parts.push(`<h3>Elenco dichiarato</h3><table><tr><th>Sito</th><th>Fonte</th><th>Voci</th><th>Note</th></tr>${r.declared
    .map((d) => `<tr><td>${esc(d.site)}</td><td>${esc(d.source ?? 'non disponibile')}</td><td>${d.items.length}</td><td>${esc(d.note ?? '')}</td></tr>`)
    .join('')}</table>`);

  // La stessa anomalia in più sessioni (es. lo stesso reindirizzamento in ogni scenario) si elenca una volta
  const errBy = new Map<string, string[]>();
  for (const s of sessions) for (const e of new Set(s.errors)) errBy.set(e, [...(errBy.get(e) ?? []), s.id]);
  const errors = [...errBy].map(([e, ids]) => (ids.length === 1 ? `${ids[0]}: ${e}` : `${e} — in ${ids.length} sessioni (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', …' : ''})`));
  parts.push(`<h3>Limiti</h3><ul>${[...LIMITS, ...config.report.noteLimiti].map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
${errors.length ? `<p><strong>Anomalie durante l'esecuzione:</strong></p><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}`);

  // 2. Sintesi
  // Una scheda raggruppata conta per ognuno dei siti a cui si riferisce.
  const bySite = new Map<string, Finding[]>();
  for (const f of findings) for (const s of f.sites?.length ? f.sites : [f.site]) bySite.set(s, [...(bySite.get(s) ?? []), f]);
  const byRule = groupBy(findings, (f) => f.ruleTitle);
  parts.push(`<h2>2. Sintesi</h2><p>Criticità rilevate: <strong>${findings.length}</strong>.</p>
<table><tr><th>Sito / dominio</th>${SEV.map((s) => `<th>${sevBadge(s)}</th>`).join('')}<th>Totale</th></tr>
${[...bySite].map(([site, fs]) => `<tr><td>${esc(site)}</td>${SEV.map((s) => `<td>${fs.filter((f) => f.severity === s).length}</td>`).join('')}<td>${fs.length}</td></tr>`).join('')}</table>
${findings.some((f) => (f.sites?.length ?? 1) > 1) ? `<p class="muted">Le schede che riguardano più siti (es. lo stesso fatto su www e app) sono contate su ciascuno di essi: per questo la somma per sito (${[...bySite.values()].reduce((a, fs) => a + fs.length, 0)}) supera il numero delle schede (${findings.length}).</p>` : ''}
<table><tr><th>Tipo</th><th>Numero</th><th>Criticità</th></tr>${[...byRule]
    .map(([t, fs]) => `<tr><td>${esc(t)}</td><td>${fs.length}</td><td>${fs.map((f) => `<a href="#${f.id}">${f.id}</a>`).join(', ')}</td></tr>`)
    .join('')}</table>`);

  // 3. Criticità
  parts.push('<h2>3. Criticità</h2>');
  if (!findings.length) parts.push('<p>Nessuna criticità rilevata dalle regole attive.</p>');
  for (const f of findings) {
    const images = f.evidence.filter((e) => e.file.endsWith('.png'));
    const others = f.evidence.filter((e) => !e.file.endsWith('.png'));
    parts.push(`<div class="card ${f.severity}" id="${f.id}"><h3>${f.id} · ${esc(f.ruleTitle)} ${sevBadge(f.severity)}</h3>
<p><strong>Cosa succede.</strong> ${esc(f.description)}</p>
${f.evidenceLevel ? `<p><strong>Forza della prova.</strong> ${esc(EVIDENCE_LABEL[f.evidenceLevel])}.</p>` : ''}
${f.repeats ? `<p><strong>Ripetibilità.</strong> ${esc(repeatsText(f.repeats))}</p>` : ''}
${reviewOf(f)?.esito ? `<p><strong>Revisione manuale.</strong> ${esc(reviewOf(f)!.esito)}${reviewOf(f)!.nota ? ` — ${esc(reviewOf(f)!.nota)}` : ''}</p>` : ''}
<p><strong>Dove.</strong> ${esc(f.site)}${f.scenario ? ` · scenario "${esc(f.scenario)}"` : ''}${f.pageUrl ? ` · ${esc(f.pageUrl)}` : ''}</p>
${f.details.length ? `<ul>${f.details.slice(0, 40).map((d) => `<li>${esc(d)}</li>`).join('')}${f.details.length > 40 ? `<li class="muted">… altri ${f.details.length - 40} (elenco completo negli allegati: dati.json e CSV)</li>` : ''}</ul>` : ''}
${images.length ? `<p><strong>Prova.</strong></p><div class="shots">${images.map((e) => `<figure><img src="${esc(e.file)}" alt="${esc(e.label)}"><figcaption>${esc(e.label)} — ${esc(e.file)}</figcaption></figure>`).join('')}</div>` : ''}
${f.requestExcerpt ? `<p><strong>Estratto della richiesta</strong> (completa nel file HAR):</p><pre>${esc(JSON.stringify(f.requestExcerpt, null, 2))}</pre>` : ''}
${others.length ? `<p class="muted">File: ${others.map((e) => esc(e.file)).join(', ')}</p>` : ''}
${f.norms.length ? `<p><strong>Riferimenti normativi.</strong></p><ul>${f.norms.map((n) => `<li>${n.url ? `<a href="${esc(n.url)}">${esc(n.title)}</a>` : esc(n.title)} — ${esc(n.reference)}</li>`).join('')}</ul>` : ''}</div>`);
  }

  if (excluded.length) {
    parts.push(`<h3>Schede escluse dopo la revisione manuale</h3><p class="muted">Segnalate dalle regole ma giudicate falsi positivi da chi ha revisionato il report; restano nei dati (dati.json, criticita.csv).</p>
<table><tr><th>Scheda</th><th>Regola</th><th>Sito</th><th>Motivo</th></tr>${excluded.map((f) => `<tr><td>${esc(f.id)}</td><td>${esc(f.ruleTitle)}</td><td>${esc(f.site)}</td><td>${esc(reviewOf(f)!.nota || '—')}</td></tr>`).join('')}</table>`);
  }

  // 4. Inventario
  parts.push('<h2>4. Inventario</h2>');
  const declaredStatus = new Map(r.comparison.map((c) => [`${c.site}|${c.name}|${c.domain}`, c]));
  for (const site of sites) {
    // L'inventario usa solo le sessioni valide (non intercettate da sistemi anti-bot).
    const ss = sessions.filter((s) => s.site === site && !s.blocked && !s.unreachable);
    const cookies = new Map<string, { c: SessionResult['cookies'][number]; scen: Set<string>; pre: '' | 'al caricamento' | 'dopo scroll'; afterReject: boolean }>();
    for (const s of ss) {
      for (const c of s.cookies) {
        const k = `${c.name}|${c.domain}`;
        const cur = cookies.get(k) ?? { c, scen: new Set<string>(), pre: '', afterReject: false };
        cur.scen.add(s.scenario);
        // "al caricamento" prevale su "dopo scroll" se il cookie compare in entrambi i modi
        if (c.phase === 'prima' && cur.pre !== 'al caricamento') cur.pre = c.stage === 'caricamento' ? 'al caricamento' : 'dopo scroll';
        if (s.scenario === 'rifiuta' && c.phase === 'dopo') cur.afterReject = true;
        cookies.set(k, cur);
      }
    }
    parts.push(`<h3>${esc(site)} — cookie (${cookies.size})</h3><table><tr><th>Nome</th><th>Dominio</th><th>Parte</th><th>Scadenza</th><th>Categoria (fonte)</th><th>Dichiarato</th><th>Prima della scelta</th><th>Dopo rifiuto</th><th>Scenari</th></tr>
${[...cookies.values()]
  .sort((a, b) => a.c.name.localeCompare(b.c.name))
  .map(({ c, scen, pre, afterReject }) => {
    const d = declaredStatus.get(`${site}|${c.name}|${c.domain.replace(/^\./, '')}`);
    return `<tr><td>${esc(c.name)}</td><td>${esc(c.domain)}</td><td>${esc(c.party)}</td><td>${esc(c.expires ? c.expires.slice(0, 10) : 'sessione')}</td><td>${esc(CATEGORY_LABEL[c.classification.category])}${c.classification.platform ? ` (${esc(c.classification.platform)})` : ''}<br><span class="muted">${esc(c.classification.source)}</span></td><td>${d ? `${esc(d.status)}${d.declaredCategories.length ? `<br><span class="muted">${esc(d.declaredCategories.join(', '))}</span>` : ''}` : '—'}</td><td>${esc(pre)}</td><td>${afterReject ? 'sì' : ''}</td><td>${esc([...scen].join(', '))}</td></tr>`;
  })
  .join('')}</table>`);

    const third = groupBy(
      ss.flatMap((s) => s.requests.filter((q) => q.party === 'terza').map((q) => ({ s, q }))),
      (x) => x.q.host,
    );
    parts.push(`<h3>${esc(site)} — terze parti contattate (${third.size})</h3><table><tr><th>Host</th><th>Fornitore</th><th>Categoria</th><th>Richieste</th><th>Prima della scelta (caricamento / dopo scroll)</th><th>Dopo rifiuto</th></tr>
${[...third]
  .sort((a, b) => Number(NON_TECHNICAL.has(b[1][0].q.tracker?.category ?? 'sconosciuta')) - Number(NON_TECHNICAL.has(a[1][0].q.tracker?.category ?? 'sconosciuta')) || a[0].localeCompare(b[0]))
  .map(([host, list]) => {
    const t = list[0].q.tracker;
    return `<tr><td>${esc(host)}</td><td>${esc(t?.company ?? '—')}</td><td>${esc(t ? CATEGORY_LABEL[t.category] : 'non classificata')}</td><td>${list.length}</td><td>${list.filter((x) => x.q.stage === 'caricamento').length} / ${list.filter((x) => x.q.phase === 'prima' && x.q.stage === 'scroll').length}</td><td>${list.filter((x) => x.s.scenario === 'rifiuta' && x.q.phase === 'dopo').length}</td></tr>`;
  })
  .join('')}</table>`);
  }

  // 5. Allegati
  // L'elenco delle impronte di ogni file sta in manifest.json (e l'impronta del manifest in manifest.json.sha256):
  // nel report basta il riepilogo, per non occupare decine di pagine.
  const kinds = groupBy(r.files, (f) => (/\.har(\.gz)?$/.test(f.path) ? 'registrazioni del traffico (HAR)' : f.path.endsWith('.png') ? 'screenshot' : f.path.endsWith('.json') ? 'estratti delle richieste (JSON)' : 'altri file'));
  const mb = (n: number) => `${(n / 1048576).toLocaleString('it-IT', { maximumFractionDigits: 1 })} MB`;
  parts.push(`<h2>5. Allegati</h2>
<p>Le prove sono nella cartella <code>evidenze/</code>. L'impronta SHA-256 di <strong>ogni file</strong> della cartella dell'esecuzione (compresi questo report, i CSV e la configurazione usata) è in <code>manifest.json</code>; l'impronta di <code>manifest.json</code> è nel file <code>manifest.json.sha256</code>. Per verificare l'integrità basta ricalcolare l'impronta del manifest e confrontarla.</p>
<table><tr><th>Tipo di evidenza</th><th>File</th><th>Dimensione</th></tr>${[...kinds].map(([k, fs]) => `<tr><td>${esc(k)}</td><td>${fs.length}</td><td>${mb(fs.reduce((a, f) => a + f.bytes, 0))}</td></tr>`).join('')}</table>
<p>Dati grezzi allegati: <code>cookie.csv</code>, <code>storage.csv</code>, <code>richieste.csv</code>, <code>sessioni.csv</code>, <code>criticita.csv</code>, <code>confronto-dichiarati.csv</code>, <code>dati.json</code>.</p>
</body></html>`);
  return parts.join('\n');
}
