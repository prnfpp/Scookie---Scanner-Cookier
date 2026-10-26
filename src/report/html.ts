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
  /** Nome del file di configurazione usato (distinto dal nome del cliente) e sua impronta. */
  configFile?: string;
  configSha256?: string;
  /** Versione esatta del codice dello strumento (commit), se disponibile. */
  toolCommit?: string | null;
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
const SCENARIO_TEXT: Record<string, string> = {
  'nessuna-azione': 'prima di qualsiasi scelta',
  accetta: "dopo l'accettazione",
  rifiuta: 'dopo il rifiuto',
  personalizza: 'dopo una scelta per categoria',
  revoca: 'dopo la revoca del consenso',
};
const listIt = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);
export const fmt = (iso: string) => new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

const LIMITS = [
  'Campione: sono state visitate solo le pagine e i percorsi elencati nella sezione 2. Comportamenti presenti in altre pagine non sono coperti.',
  'Aree riservate: le pagine che richiedono un accesso (area clienti, account) non sono state visitate, salvo dove indicato.',
  'Variabilità: ogni sessione parte da un profilo browser pulito. Il risultato può variare con test A/B, aste pubblicitarie, geolocalizzazione, configurazioni del gestore del consenso diverse per paese e modifiche del sito nel tempo; la ripetibilità indicata in ogni rilievo misura questa variabilità nelle esecuzioni fatte.',
  'Tracciamento lato server: se il sito invia dati a un proprio endpoint (es. /g/collect su un sottodominio proprio), i destinatari finali non sono visibili dal browser.',
  'Classificazione: cookie e domini sono classificati con Open Cookie Database e un elenco di domini curato; gli elementi "non classificati" sono elencati e vanno valutati caso per caso.',
  'Paese di uscita: rilevato una volta all\'avvio tramite un servizio esterno; la geolocalizzazione per IP può essere imprecisa.',
  'Natura del documento: lo strumento documenta fatti tecnici e li collega a riferimenti normativi; la valutazione di conformità spetta al consulente legale.',
];

export const CSS = `
:root{--fg:#1d1d1f;--muted:#5f6368;--line:#dadce0;--bg:#fff;--alt:#f6f7f9;--alta:#b3261e;--media:#b26a00;--bassa:#1a73e8;--info:#5f6368}
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px;max-width:1100px;margin:auto}
h1{font-size:24px;margin:0 0 4px}.subtitle{font-size:17px;margin:0 0 6px;font-weight:600}h2{font-size:20px;border-bottom:2px solid var(--fg);padding-bottom:4px;margin-top:40px;page-break-after:avoid}h3{font-size:16px;margin:18px 0 6px}
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
  // Con la revisione manuale, i rilievi segnati come falso positivo escono dal corpo del rapporto e vanno in coda
  const reviewOf = (f: Finding) => r.review?.get(findingKey(f));
  const findings = r.findings.filter((f) => reviewOf(f)?.esito !== 'falso positivo');
  const excluded = r.findings.filter((f) => reviewOf(f)?.esito === 'falso positivo');
  const sites = [...new Set(sessions.map((s) => s.site))];
  const host = (s: string) => {
    try {
      return new URL(s).hostname;
    } catch {
      return s;
    }
  };
  const reps = config.scenari.ripetizioni;
  const withForms = sessions.some((s) => s.manual || s.replay);
  const parts: string[] = [];

  parts.push(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rapporto tecnico di verifica – ${esc(config.cliente)}</title><style>${CSS}</style></head><body>
<h1>Rapporto tecnico di verifica sull'uso di cookie e altri strumenti di tracciamento</h1>
${config.report.sottotitolo ? `<p class="subtitle">${esc(config.report.sottotitolo)}</p>` : ''}
<p class="muted">Committente: ${esc(config.cliente)} · rilevazione del ${esc(fmt(r.startedAt))} · siti: ${esc(sites.map(host).join(', '))} · strumento Scookie ${esc(r.toolVersion)}</p>
${r.review ? `<p class="warn"><strong>Rapporto rivisto.</strong> È stata applicata la revisione manuale dei rilievi (file <code>revisione.csv</code>): ${r.findings.filter((f) => reviewOf(f)?.esito === 'confermato').length} confermati, ${excluded.length} esclusi come falso positivo (elencati in fondo alla sezione 3), ${r.findings.filter((f) => !reviewOf(f)?.esito).length} non revisionati. I dati raccolti e le prove non cambiano.</p>` : ''}
${!r.exit.matches ? `<p class="warn"><strong>Paese di uscita.</strong> ${esc(r.exit.note)}</p>` : ''}
<h2>Natura del documento</h2>
<p>Il rapporto documenta, con metodo tecnico ripetibile, il comportamento dei siti indicati rispetto alle scelte dell'utente sul banner di consenso: quali cookie, archivi locali e comunicazioni verso terze parti vengono attivati ${esc(listIt(config.scenari.attivi.map((a) => SCENARIO_TEXT[a] ?? a)))}. Confronta quanto osservato con quanto dichiarato nel banner e nella cookie policy, e segnala gli elementi che meritano verifica, ciascuno con le relative prove (screenshot, registrazioni del traffico, dati grezzi) e i riferimenti normativi pertinenti.</p>
<p>Il controllo è condotto su un campione di pagine e percorsi${withForms ? ', compresi percorsi con moduli' : ''}, ${reps > 1 ? `ripetuto ${reps} volte` : 'eseguito una volta'} con profili di navigazione puliti. Le prove sono conservate con impronta crittografica (SHA-256) che ne consente la verifica di integrità.</p>
<p>Il rapporto ha natura esclusivamente tecnica e descrittiva: non contiene valutazioni di conformità né indicazioni correttive. La qualificazione giuridica dei fatti rilevati spetta al consulente legale.</p>
<h3>Come leggere il rapporto</h3>
<ul>
<li><strong>Rilievo</strong>: un fatto osservato che una regola tecnica segnala come meritevole di verifica, con le prove e i riferimenti normativi pertinenti. I rilievi sono numerati (R-001…) e i file di prova ne riportano il numero.</li>
<li><strong>Priorità di verifica</strong> (alta, media, bassa, informativa): l'ordine in cui conviene esaminare i rilievi, definito nella tabella delle regole e modificabile; non è una qualificazione giuridica.
  <ul><li><em>alta</em>: tracciamenti di marketing, statistica o registrazione delle sessioni prima della scelta o dopo il rifiuto; dati inseriti nei moduli inviati a terze parti;</li>
  <li><em>media</em>: aspetti del banner o dell'informativa che riguardano le modalità della scelta;</li>
  <li><em>bassa</em>: differenze documentali o elementi da classificare;</li>
  <li><em>informativa</em>: contesto utile alla lettura.</li></ul></li>
<li><strong>Forza della prova</strong>: cosa è stato osservato (risorsa scaricata, dati inviati, identificativo scritto nel browser). <strong>Ripetibilità</strong>: in quante delle esecuzioni il fatto si è ripetuto.</li>
</ul>
<h3>Contenuto</h3>
<ol><li>Sintesi</li><li>Perimetro e metodo</li><li>Rilievi</li><li>Inventario e confronto con l'elenco dichiarato</li><li>Limiti</li><li>Allegati e verifica di integrità</li></ol>`);

  // 1. Sintesi: i fatti principali raggruppati per causa, con rimando ai rilievi
  const top = summaryItems(findings).slice(0, 10);
  const inTop = new Set(top.flatMap((i) => i.findings.map((f) => f.id)));
  const blockedSites = [...new Set(sessions.filter((s) => s.blocked).map((s) => host(s.site)))];
  const unreachable = sessions.filter((s) => s.unreachable);
  const unreachableSites = [...new Set(unreachable.map((s) => host(s.site)))];
  const allUnreachable = unreachableSites.filter((h) => sessions.filter((s) => host(s.site) === h).every((s) => s.unreachable || s.blocked));
  const bySite = new Map<string, Finding[]>();
  for (const f of findings) for (const s of f.sites?.length ? f.sites : [f.site]) bySite.set(s, [...(bySite.get(s) ?? []), f]);
  const byRule = groupBy(findings, (f) => f.ruleTitle);
  parts.push(`<h2>1. Sintesi</h2>
${top.length ? `<p>I fatti principali, raggruppati per causa e ordinati per priorità di verifica, forza della prova e ripetibilità. I rilievi che derivano dallo stesso fatto sono riuniti in un punto; il dettaglio e le prove sono nei rilievi indicati.</p>
<ol>${top.map((i) => `<li>${esc(i.title)} <span class="muted">(${esc(i.hosts.join(', '))}${i.repeats ? ` · ${esc(i.repeats)}` : ''})</span> — ${sevBadge(i.severity)} ${i.findings.map((f) => `<a href="#${f.id}">${f.id}</a>`).join(', ')}</li>`).join('')}</ol>` : '<p>Nessun rilievo con priorità di verifica alta o media.</p>'}
${findings.length > inTop.size ? `<p class="muted">Altri ${findings.length - inTop.size} rilievi, di priorità minore o di contesto, sono nella sezione 3.</p>` : ''}
${blockedSites.length ? `<p class="warn"><strong>Accesso intercettato.</strong> Su ${esc(blockedSites.join(', '))} la navigazione è stata intercettata da un sistema anti-bot: le sessioni coinvolte non sono valide e non sono state usate per i rilievi.</p>` : ''}
${unreachable.length ? `<p class="warn"><strong>Pagine non caricate.</strong> ${unreachable.length} sessioni non hanno potuto caricare il sito (${esc(unreachableSites.join(', '))}), per esempio per connessione assente o computer in stop: non sono valide e non sono state usate per i rilievi.${allUnreachable.length ? ` Per ${esc(allUnreachable.join(', '))} non ci sono dati: il rapporto non descrive ${allUnreachable.length === 1 ? 'questo sito' : 'questi siti'}.` : ''}</p>` : ''}
<h3>Rilievi per sito e priorità di verifica</h3>
<table><tr><th>Sito / dominio</th>${SEV.map((s) => `<th>${sevBadge(s)}</th>`).join('')}<th>Totale</th></tr>
${[...bySite].map(([site, fs]) => `<tr><td>${esc(site)}</td>${SEV.map((s) => `<td>${fs.filter((f) => f.severity === s).length}</td>`).join('')}<td>${fs.length}</td></tr>`).join('')}</table>
${findings.some((f) => (f.sites?.length ?? 1) > 1) ? `<p class="muted">Un rilievo che riguarda più siti (es. lo stesso fatto su www e app) è contato su ciascuno: per questo la somma per sito (${[...bySite.values()].reduce((a, fs) => a + fs.length, 0)}) supera il numero dei rilievi (${findings.length}).</p>` : ''}
<h3>Rilievi per tipo</h3>
<table><tr><th>Tipo</th><th>Numero</th><th>Rilievi</th></tr>${[...byRule]
    .map(([t, fs]) => `<tr><td>${esc(t)}</td><td>${fs.length}</td><td>${fs.map((f) => `<a href="#${f.id}">${f.id}</a>`).join(', ')}</td></tr>`)
    .join('')}</table>`);

  // 2. Perimetro e metodo
  parts.push(`<h2>2. Perimetro e metodo</h2><table class="kv">
<tr><td>Committente</td><td>${esc(config.cliente)}</td></tr>
<tr><td>Siti</td><td>${esc(config.siti.map((s) => s.url).join(', '))}</td></tr>
${r.configFile ? `<tr><td>Configurazione</td><td><code>${esc(r.configFile)}</code>${r.configSha256 ? `<br><span class="muted">impronta SHA-256 ${esc(r.configSha256)}; il contenuto completo è in <code>manifest.json</code></span>` : ''}</td></tr>` : ''}
<tr><td>Inizio / fine</td><td>${esc(fmt(r.startedAt))} — ${esc(fmt(r.endedAt))}</td></tr>
<tr><td>Strumento</td><td>Scookie ${esc(r.toolVersion)}${r.toolCommit ? ` (codice <code>${esc(r.toolCommit)}</code>)` : ''}; browser ${esc(r.browserVersion)} (${config.browser.canale === 'chromium' ? 'Chromium incluso nello strumento' : `${esc(config.browser.canale)} installato sul computer`}, ${config.browser.headless ? 'senza finestra (headless)' : 'con finestra visibile'}${config.browser.headless && r.sessions.some((s) => s.manual) ? '; navigazioni manuali con finestra visibile' : ''})</td></tr>
<tr><td>User agent</td><td><code>${esc(r.userAgent)}</code>${config.browser.uaNormale ? '<br><span class="muted">Esecuzione di controllo: user agent di un browser comune, senza la dichiarazione dello strumento.</span>' : ''}</td></tr>
<tr><td>Lingua / fuso orario</td><td>${esc(config.browser.locale)} / ${esc(config.browser.timezone)}</td></tr>
<tr><td>Paese di uscita</td><td>dichiarato ${esc(r.exit.declared)}; ${r.exit.verified ? `rilevato <strong>${esc(r.exit.country)}</strong> (IP ${esc(r.exit.ip)}, fonte ${esc(r.exit.source)})` : 'non rilevato'}${config.browser.proxy ? ' — tramite proxy' : ''}<br><span class="muted">${esc(r.exit.note)}</span></td></tr>
<tr><td>Scenari di consenso</td><td>${esc(config.scenari.attivi.join(', '))} — modalità "${esc(config.scenari.modalita)}", ${config.scenari.pagineDopoScelta} pagine visitate dopo la scelta</td></tr>
<tr><td>Ripetizioni</td><td>${reps > 1 ? `ogni scenario ripetuto ${reps} volte, ogni volta con un profilo browser nuovo` : 'ogni scenario eseguito una volta, con un profilo browser nuovo'}</td></tr>
${config.datiDiProva?.length ? `<tr><td>Dati di prova</td><td>Inseriti nei moduli durante le navigazioni manuali, fittizi o concordati con il committente: ${config.datiDiProva.map((t) => `${esc(t.etichetta || t.tipo)} <code>${esc(t.valore)}</code>`).join('; ')}. Nei rilievi sono riportati in chiaro; gli altri valori che somigliano a dati personali sono mascherati.</td></tr>` : ''}
<tr><td>Protocollo di osservazione</td><td>Per ogni pagina: caricamento completo, attesa della rete inattiva (max 5 s), attesa fissa di ${config.protocollo.attesaDopoCaricamento} ms${config.protocollo.scroll ? `, scroll fino a fondo pagina e attesa di ${config.protocollo.attesaDopoScroll} ms` : ''}. Sulla prima pagina il banner viene fotografato e l'eventuale scelta avviene <em>prima</em> dello scroll; dopo la scelta si attendono ${config.protocollo.attesaDopoScelta} ms. In tutti gli scenari con scelta il percorso dopo la scelta è lo stesso: si ricarica la pagina di partenza e si visitano le stesse pagine nello stesso ordine; nello scenario di revoca lo stesso percorso si ripete dopo la revoca. Pausa tra sessioni: ${config.protocollo.pausaTraSessioni} ms.</td></tr>
<tr><td>Registrazioni del traffico</td><td>Un file HAR per sessione, con URL, intestazioni, cookie, tempi e corpi delle richieste. Corpi delle risposte: ${config.report.harContenuti === 'tutti' ? 'tutti' : config.report.harContenuti === 'testo' ? 'solo testuali fino a 512 KB (immagini, font e video omessi)' : 'omessi'}${config.report.harCompressi ? ', e solo per le sessioni citate nei rilievi. File compressi (.har.gz): su Mac un doppio clic restituisce il .har, che si apre negli strumenti per sviluppatori del browser' : ''}.</td></tr>
<tr><td>Tabella delle regole e delle norme</td><td>${esc(r.normsPath)}</td></tr>
</table>`);

  parts.push('<h3>Pagine e percorsi campionati</h3>');
  for (const d of r.discovery) {
    parts.push(`<p><strong>${esc(d.site)}</strong> — ${d.found} URL scoperte; tipi: ${esc(Object.entries(d.byType).map(([k, v]) => `${k} (${v})`).join(', ') || '—')}</p>
<table><tr><th>#</th><th>Tipo</th><th>Origine</th><th>URL</th></tr>${d.sample.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.type)}</td><td>${esc(p.source)}</td><td>${esc(p.url)}</td></tr>`).join('')}</table>
${d.notes.length ? `<ul class="muted">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`);
    // Navigazione manuale dell'operatore: istruzioni, pagine percorse e come si è conclusa
    for (const s of sessions.filter((x) => x.site === d.site && x.manual)) {
      const m = s.manual!;
      const end = m.endedBy === 'operatore' ? "conclusa dall'operatore" : m.endedBy === 'tempo' ? 'interrotta allo scadere del tempo massimo' : 'interrotta: finestra chiusa';
      parts.push(`<p><strong>Navigazione manuale</strong> — sessione ${esc(s.id)}, scenario "${esc(s.scenario)}", ${end} dopo ${m.seconds} s. Istruzioni date all'operatore: "${esc(m.instructions)}".${m.pages.length <= 1 || m.seconds < 60 ? ' <strong>Probabilmente incompleta</strong> (breve o con una sola pagina): i fatti che ne derivano vanno confermati ripetendola.' : ''}</p>
<ol class="muted">${m.pages.map((u) => `<li>${esc(u)}</li>`).join('')}</ol>`);
    }
    // Percorso registrato in una navigazione manuale precedente e rigiocato in automatico
    const replays = sessions.filter((x) => x.site === d.site && x.replay);
    if (replays.length) {
      const rp = replays[0].replay!;
      const ok = replays.filter((x) => !x.replay!.stoppedAt).length;
      parts.push(`<p><strong>Percorso registrato</strong> — registrato il ${esc(new Date(rp.recordedAt).toLocaleDateString('it-IT'))} (sessione ${esc(rp.fromSession)}, ${rp.stepsTotal} azioni dell'operatore) e rigiocato in automatico dopo la scelta in ${replays.length} sessioni: completo in ${ok} su ${replays.length}.${ok < replays.length ? ` Interruzioni: ${esc([...new Set(replays.filter((x) => x.replay!.stoppedAt).map((x) => x.replay!.stoppedAt!))].join('; '))}.` : ''}</p>
<ol class="muted">${rp.pages.map((u) => `<li>${esc(u)}</li>`).join('')}</ol>`);
    }
  }

  parts.push(`<h3>Interazione con il banner</h3><p>Per ogni sito e scenario: gestori del consenso riconosciuti, metodo che ha eseguito la scelta (selettori indicati, adattatore del gestore, riconoscimento dei testi, API del gestore) e verifica dello stato del consenso registrato dopo la scelta.</p>
<p class="muted">Una riga per sito e scenario; tra parentesi il numero di sessioni con quel valore. Il dettaglio di ogni sessione (pagine, clic, verifica) è in <code>sessioni.csv</code>.</p>
<table><tr><th style="width:24%">Sito · scenario</th><th style="width:10%">Sessioni</th><th style="width:16%">Gestore / banner</th><th style="width:16%">Metodo</th><th>Esito (esempio)</th><th style="width:14%">Verifica</th></tr>
${sessionRows(sessions)
  .map(
    (g) => `<tr><td>${esc(host(g.s.site))}<br><span class="muted">${esc(g.s.scenario)}${g.s.manual ? ' · navigazione manuale' : g.s.replay ? ' · percorso registrato' : ''}</span></td><td>${g.n}<br><span class="muted">${esc(g.pages)} pag.</span></td><td>${esc(g.cmps.join('; '))}<br><span class="muted">banner ${esc(g.banner.join('; '))}</span></td>
<td>${esc(g.method.join('; '))}</td><td>${esc(g.outcome.join('; '))}<br><span class="muted">${esc(g.s.interaction.detail)}</span></td><td>${esc(g.verification.join('; '))}</td></tr>`,
  )
  .join('')}</table>`);

  const retried = sessions.filter((s) => s.retryOf);
  if (retried.length) {
    parts.push(`<p><strong>Sessioni ripetute.</strong> Quando un sito mostra il banner in alcune sessioni e non in altre, o la connessione cade, la sessione viene ripetuta una volta. La sessione originale resta nei dati (<code>dati.json</code>, voce <code>sessioniScartate</code>) e nelle evidenze.</p>
<ul>${retried.map((s) => `<li>${esc(s.retryOf)} → ${esc(s.id)}: ${esc(s.errors[0] ?? '')}</li>`).join('')}</ul>`);
  }
  parts.push(`<h3>Elenco dichiarato</h3><p class="muted">Fonte dell'elenco dei cookie dichiarati dal sito, usato per il confronto nella sezione 4.</p><table><tr><th>Sito</th><th>Fonte</th><th>Voci</th><th>Note</th></tr>${r.declared
    .map((d) => `<tr><td>${esc(d.site)}</td><td>${esc(d.source ?? 'non disponibile')}</td><td>${d.items.length}</td><td>${esc(d.note ?? '')}</td></tr>`)
    .join('')}</table>`);

  // 3. Rilievi
  parts.push('<h2>3. Rilievi</h2>');
  if (!findings.length) parts.push('<p>Nessun rilievo dalle regole attive.</p>');
  for (const f of findings) {
    const images = f.evidence.filter((e) => e.file.endsWith('.png'));
    const others = f.evidence.filter((e) => !e.file.endsWith('.png'));
    parts.push(`<div class="card ${f.severity}" id="${f.id}"><h3>${f.id} · ${esc(f.ruleTitle)}</h3>
<p class="muted">Priorità di verifica: ${sevBadge(f.severity)}</p>
<p><strong>Cosa succede.</strong> ${esc(f.description)}</p>
<p><strong>Dove.</strong> ${esc(f.site)}${f.scenario ? ` · scenario "${esc(f.scenario)}"` : ''}${f.pageUrl ? ` · ${esc(f.pageUrl)}` : ''}</p>
${f.evidenceLevel ? `<p><strong>Forza della prova.</strong> ${esc(EVIDENCE_LABEL[f.evidenceLevel])}.</p>` : ''}
${f.repeats ? `<p><strong>Ripetibilità.</strong> ${esc(repeatsText(f.repeats))}</p>` : ''}
${reviewOf(f)?.esito ? `<p><strong>Revisione manuale.</strong> ${esc(reviewOf(f)!.esito)}${reviewOf(f)!.nota ? ` — ${esc(reviewOf(f)!.nota)}` : ''}</p>` : ''}
${f.details.length ? `<ul>${f.details.slice(0, 40).map((d) => `<li>${esc(d)}</li>`).join('')}${f.details.length > 40 ? `<li class="muted">… altri ${f.details.length - 40} (elenco completo negli allegati: dati.json e CSV)</li>` : ''}</ul>` : ''}
${images.length ? `<p><strong>Prove.</strong></p><div class="shots">${images.map((e) => `<figure><img src="${esc(e.file)}" alt="${esc(e.label)}"><figcaption>${esc(e.label)} — ${esc(e.file)}</figcaption></figure>`).join('')}</div>` : ''}
${f.requestExcerpt ? `<p><strong>Estratto della richiesta</strong> (completa nel file HAR):</p><pre>${esc(JSON.stringify(f.requestExcerpt, null, 2))}</pre>` : ''}
${others.length ? `<p class="muted">File: ${others.map((e) => esc(e.file)).join(', ')}</p>` : ''}
${f.norms.length ? `<p><strong>Riferimenti normativi.</strong></p><ul>${f.norms.map((n) => `<li>${n.url ? `<a href="${esc(n.url)}">${esc(n.title)}</a>` : esc(n.title)} — ${esc(n.reference)}</li>`).join('')}</ul>` : ''}</div>`);
  }

  if (excluded.length) {
    parts.push(`<h3>Rilievi esclusi dopo la revisione manuale</h3><p class="muted">Segnalati dalle regole ma giudicati falsi positivi da chi ha revisionato il rapporto; restano nei dati (dati.json, rilievi.csv).</p>
<table><tr><th>Rilievo</th><th>Regola</th><th>Sito</th><th>Motivo</th></tr>${excluded.map((f) => `<tr><td>${esc(f.id)}</td><td>${esc(f.ruleTitle)}</td><td>${esc(f.site)}</td><td>${esc(reviewOf(f)!.nota || '—')}</td></tr>`).join('')}</table>`);
  }

  // 4. Inventario e confronto con l'elenco dichiarato
  parts.push(`<h2>4. Inventario e confronto con l'elenco dichiarato</h2>
<p>Tutti i cookie e le terze parti osservati nelle sessioni valide, con il confronto con l'elenco dichiarato dal sito (sezione 2). L'elenco completo, anche degli archivi locali, è in <code>cookie.csv</code>, <code>storage.csv</code>, <code>richieste.csv</code> e <code>confronto-dichiarati.csv</code>.</p>
<table><tr><th>Sito</th><th>Osservati e dichiarati</th><th>Osservati, non dichiarati</th><th>Dichiarati, non osservati</th></tr>${sites
    .map((site) => {
      const rows = r.comparison.filter((c) => c.site === site);
      const has = r.declared.some((d) => d.site === site && d.source);
      const n = (st: string) => rows.filter((c) => c.status === st).length;
      return `<tr><td>${esc(site)}</td>${has ? `<td>${n('dichiarato')}</td><td>${n('non-dichiarato')}</td><td>${n('dichiarato-non-osservato')}</td>` : '<td colspan="3" class="muted">elenco dichiarato non disponibile: confronto non eseguito</td>'}</tr>`;
    })
    .join('')}</table>`);
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
  .map(([h, list]) => {
    const t = list[0].q.tracker;
    return `<tr><td>${esc(h)}</td><td>${esc(t?.company ?? '—')}</td><td>${esc(t ? CATEGORY_LABEL[t.category] : 'non classificata')}</td><td>${list.length}</td><td>${list.filter((x) => x.q.stage === 'caricamento').length} / ${list.filter((x) => x.q.phase === 'prima' && x.q.stage === 'scroll').length}</td><td>${list.filter((x) => x.s.scenario === 'rifiuta' && x.q.phase === 'dopo').length}</td></tr>`;
  })
  .join('')}</table>`);
  }

  // 5. Limiti: generali e di questa rilevazione (cosa non è stato visto e perché)
  const notSeen: string[] = [];
  if (allUnreachable.length) notSeen.push(`Nessun dato per ${allUnreachable.join(', ')}: le pagine non si sono caricate.`);
  if (blockedSites.length) notSeen.push(`Su ${blockedSites.join(', ')} alcune sessioni sono state intercettate da un sistema anti-bot e non sono state usate.`);
  for (const d of r.declared.filter((x) => !x.source)) notSeen.push(`${host(d.site)}: elenco dichiarato non disponibile, confronto con i dichiarati non eseguito.`);
  for (const site of sites) {
    const ss = sessions.filter((s) => s.site === site);
    const notDone = (sc: string) => ss.filter((s) => s.scenario === sc && !s.manual && !s.replay && s.interaction.outcome !== 'eseguito' && !s.unreachable && !s.blocked);
    for (const sc of ['rifiuta', 'accetta', 'personalizza'] as const) {
      const list = notDone(sc);
      if (list.length) notSeen.push(`${host(site)}: scenario "${sc}" non eseguito in ${list.length} ${list.length === 1 ? 'sessione' : 'sessioni'} (${list[0].interaction.detail.slice(0, 160)}).`);
    }
    const rev = ss.filter((s) => s.scenario === 'revoca' && s.revocation && s.revocation.outcome !== 'eseguita');
    if (rev.length) notSeen.push(`${host(site)}: revoca non eseguita in ${rev.length} ${rev.length === 1 ? 'sessione' : 'sessioni'}: il comportamento dopo la revoca non è descritto.`);
    for (const s of ss.filter((x) => x.manual && (x.manual.pages.length <= 1 || x.manual.seconds < 60))) notSeen.push(`${host(site)}: navigazione manuale ${s.id} probabilmente incompleta.`);
    for (const s of ss.filter((x) => x.replay?.stoppedAt)) notSeen.push(`${host(site)}: percorso registrato interrotto in ${s.id} (${s.replay!.stoppedAt}).`);
  }
  const errBy = new Map<string, string[]>();
  for (const s of sessions) for (const e of new Set(s.errors)) errBy.set(e, [...(errBy.get(e) ?? []), s.id]);
  const errors = [...errBy].map(([e, ids]) => (ids.length === 1 ? `${ids[0]}: ${e}` : `${e} — in ${ids.length} sessioni (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', …' : ''})`));
  parts.push(`<h2>5. Limiti</h2>
<h3>Limiti del metodo</h3><ul>${[...LIMITS, ...config.report.noteLimiti].map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<h3>Cosa non è stato osservato in questa rilevazione</h3>${notSeen.length ? `<ul>${[...new Set(notSeen)].map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p>Tutti gli scenari previsti sono stati eseguiti su tutti i siti.</p>'}
${errors.length ? `<h3>Anomalie durante l'esecuzione</h3><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}`);

  // 6. Allegati: l'elenco delle impronte di ogni file sta in manifest.json (e l'impronta del manifest in
  // manifest.json.sha256): nel rapporto basta il riepilogo, per non occupare decine di pagine.
  const kinds = groupBy(r.files, (f) => (/\.har(\.gz)?$/.test(f.path) ? 'registrazioni del traffico (HAR)' : f.path.endsWith('.png') ? 'screenshot' : f.path.endsWith('.json') ? 'estratti delle richieste (JSON)' : 'altri file'));
  const mb = (n: number) => `${(n / 1048576).toLocaleString('it-IT', { maximumFractionDigits: 1 })} MB`;
  parts.push(`<h2>6. Allegati e verifica di integrità</h2>
<p>Le prove sono nella cartella <code>evidenze/</code>; quelle citate nei rilievi sono copiate in <code>evidenze/rilievi/</code> con il numero del rilievo nel nome. L'impronta SHA-256 di <strong>ogni file</strong> della cartella della rilevazione (compresi questo rapporto, i CSV e la configurazione usata) è in <code>manifest.json</code>; l'impronta di <code>manifest.json</code> è nel file <code>manifest.json.sha256</code>. Per verificare l'integrità si ricalcola l'impronta del manifest e la si confronta, poi quella dei singoli file.</p>
<table><tr><th>Tipo di evidenza</th><th>File</th><th>Dimensione</th></tr>${[...kinds].map(([k, fs]) => `<tr><td>${esc(k)}</td><td>${fs.length}</td><td>${mb(fs.reduce((a, f) => a + f.bytes, 0))}</td></tr>`).join('')}</table>
<p>Dati grezzi: <code>cookie.csv</code>, <code>storage.csv</code>, <code>richieste.csv</code>, <code>sessioni.csv</code>, <code>rilievi.csv</code>, <code>confronto-dichiarati.csv</code>, <code>dati.json</code>.</p>
<h3>Ripetibilità e confronto nel tempo</h3>
<p>Per ripetere la rilevazione si usano la stessa configurazione (${r.configFile ? `<code>${esc(r.configFile)}</code>, ` : ''}contenuto in <code>manifest.json</code>) e la stessa versione dello strumento (Scookie ${esc(r.toolVersion)}${r.toolCommit ? `, codice <code>${esc(r.toolCommit)}</code>` : ''}). Per il confronto con una rilevazione precedente lo strumento produce un documento separato che abbina i rilievi per regola, oggetto (cookie, fornitore, categoria) e dominio, e indica quelli non più osservati, nuovi e ancora presenti, con le eventuali differenze di versione e configurazione tra le due rilevazioni.</p>
</body></html>`);
  return parts.join('\n');
}
