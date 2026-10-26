#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { chromium } from 'playwright';
import { loadConfig } from './config/load.js';
import { discoverSite } from './discovery/discover.js';
import { writeComparison } from './report/compare.js';
import { applyReview } from './report/review.js';
import { launchOptions, regenerateRun, resolveUserAgent, runAudit } from './run.js';
import { openInBrowser, startUi } from './ui/server.js';
import { TOOL_VERSION } from './version.js';

const program = new Command();
program.name('scookie').description("Audit tecnico di cookie e tracciamenti rispetto al consenso dell'utente").version(TOOL_VERSION);

program
  .command('run')
  .description('Esegue l\'audit completo e produce report, dati ed evidenze')
  .requiredOption('-c, --config <file>', 'file YAML di configurazione')
  .option('-o, --out <dir>', 'cartella di output (sostituisce "output" della configurazione)')
  .option('--no-pdf', 'non generare il PDF')
  .action(async (opts: { config: string; out?: string; pdf: boolean }) => {
    const loaded = loadConfig(opts.config);
    await runAudit(loaded, { outDir: opts.out, pdf: opts.pdf ? undefined : false });
  });

program
  .command('scopri')
  .alias('discover')
  .description('Mostra le pagine che verrebbero campionate, senza eseguire gli scenari')
  .requiredOption('-c, --config <file>', 'file YAML di configurazione')
  .action(async (opts: { config: string }) => {
    const { config } = loadConfig(opts.config);
    const browser = await chromium.launch(launchOptions(config));
    try {
      const ua = await resolveUserAgent(browser, config);
      for (const site of config.siti) {
        const d = await discoverSite(browser, site, config, ua);
        console.log(`\n${d.site}: ${d.found} URL trovate`);
        for (const n of d.notes) console.log(`  · ${n}`);
        console.log(`  Tipi: ${Object.entries(d.byType).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`);
        d.sample.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. [${p.type}] ${p.url} (${p.source})`));
      }
    } finally {
      await browser.close();
    }
  });

program
  .command('verifica-config')
  .description('Controlla la validità del file di configurazione')
  .requiredOption('-c, --config <file>', 'file YAML di configurazione')
  .action((opts: { config: string }) => {
    const { config } = loadConfig(opts.config);
    console.log(`Configurazione valida: ${config.siti.length} siti per "${config.cliente}".`);
  });

program
  .command('confronta')
  .description('Confronta due esecuzioni: rilievi non più osservati, nuovi e ancora presenti')
  .argument('<prima>', 'cartella della prima esecuzione (es. runs/2026-10-01_…)')
  .argument('<dopo>', 'cartella della seconda esecuzione')
  .option('-o, --out <file>', 'file HTML da scrivere (predefinito: nella cartella della seconda esecuzione)')
  .action((prima: string, dopo: string, opts: { out?: string }) => {
    const { path, comparison: c } = writeComparison(prima, dopo, opts.out);
    console.log(`${c.risolte.length} non più osservate, ${c.rimaste.length} ancora presenti, ${c.nuove.length} nuove.`);
    console.log(`Confronto: ${path}`);
  });

program
  .command('revisione')
  .description('Applica la revisione manuale (revisione.csv compilato) e produce report-rivisto.html/pdf')
  .argument('<cartella>', "cartella dell'esecuzione (es. runs/2026-10-24_…)")
  .option('--no-pdf', 'non generare il PDF')
  .action(async (dir: string, opts: { pdf: boolean }) => {
    const r = await applyReview(dir, { pdf: opts.pdf });
    const v = [...r.review.values()];
    console.log(`${v.filter((e) => e.esito === 'confermato').length} confermate, ${v.filter((e) => e.esito === 'falso positivo').length} falsi positivi, ${v.filter((e) => e.esito === 'da verificare').length} da verificare, ${v.filter((e) => !e.esito).length} non revisionate.`);
    console.log(`Report rivisto: ${r.html}${r.pdf ? ` e ${r.pdf}` : ''}`);
  });

program
  .command('rigenera')
  .description('Rigenera regole e rapporto dai dati già raccolti, senza visitare di nuovo i siti')
  .argument('<cartella>', 'cartella della rilevazione (es. runs/2026-10-24_…)')
  .option('--copia', 'se il rapporto esiste già, rigenera in una copia della cartella (es. per applicare le regole attuali a una rilevazione passata)')
  .option('--no-pdf', 'non generare il PDF')
  .action(async (dir: string, opts: { copia?: boolean; pdf: boolean }) => {
    const r = await regenerateRun(dir, { copy: !!opts.copia, pdf: opts.pdf });
    console.log(`Rapporto: ${join(r.runDir, 'report.html')}`);
  });

program
  .command('interfaccia')
  .alias('ui')
  .description('Apre l\'interfaccia visuale nel browser (resta attiva finché non si chiude il terminale)')
  .option('--clienti <cartella>', 'cartella delle configurazioni dei clienti', 'clienti')
  .option('--esecuzioni <cartella>', 'cartella dei risultati', 'runs')
  .option('-p, --porta <numero>', 'porta locale (se occupata, ad esempio da un altro utente del computer, si prova la successiva)', '4777')
  .option('--no-apri', 'non aprire il browser automaticamente')
  .action(async (opts: { clienti: string; esecuzioni: string; porta: string; apri: boolean }) => {
    let ui: Awaited<ReturnType<typeof startUi>> | null = null;
    const first = Number(opts.porta);
    for (let port = first; port < first + 20 && !ui; port++) {
      ui = await startUi({ clientsDir: opts.clienti, runsDir: opts.esecuzioni, port, onQuit: () => process.exit(0) }).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') {
          console.log(`La porta ${port} è già in uso (forse da un'altra finestra o da un altro utente del computer): si prova la ${port + 1}.`);
          return null;
        }
        throw e;
      });
    }
    if (!ui) throw new Error(`Nessuna porta libera tra ${first} e ${first + 19}: chiudere le altre interfacce aperte`);
    writeSessionFile(ui.url);
    console.log(`Interfaccia Scookie attiva su ${ui.url}`);
    console.log('È raggiungibile solo da questo computer e solo con questo indirizzo. Per chiuderla: Ctrl+C in questa finestra.');
    if (opts.apri) openInBrowser(ui.url);
  });

/**
 * Indirizzo dell'interfaccia aperta (con la chiave), in un file leggibile solo da questo utente: l'icona lo usa
 * per riaprire la propria interfaccia invece di avviarne un'altra, senza mai finire su quella di un altro utente.
 */
function writeSessionFile(url: string) {
  try {
    const dir = join(homedir(), '.scookie');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'interfaccia.json');
    writeFileSync(file, JSON.stringify({ url, pid: process.pid, cartella: process.cwd() }), { mode: 0o600 });
    process.on('exit', () => {
      try {
        rmSync(file, { force: true });
      } catch {
        // file già rimosso
      }
    });
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
  } catch {
    // senza il file l'icona avvierà semplicemente una nuova interfaccia
  }
}

program.parseAsync().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
