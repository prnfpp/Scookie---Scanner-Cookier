#!/usr/bin/env node
import { Command } from 'commander';
import { chromium } from 'playwright';
import { loadConfig } from './config/load.js';
import { discoverSite } from './discovery/discover.js';
import { launchOptions, resolveUserAgent, runAudit } from './run.js';
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
  .command('interfaccia')
  .alias('ui')
  .description('Apre l\'interfaccia visuale nel browser (resta attiva finché non si chiude il terminale)')
  .option('--clienti <cartella>', 'cartella delle configurazioni dei clienti', 'clienti')
  .option('--esecuzioni <cartella>', 'cartella dei risultati', 'runs')
  .option('-p, --porta <numero>', 'porta locale', '4777')
  .option('--no-apri', 'non aprire il browser automaticamente')
  .action(async (opts: { clienti: string; esecuzioni: string; porta: string; apri: boolean }) => {
    const ui = await startUi({ clientsDir: opts.clienti, runsDir: opts.esecuzioni, port: Number(opts.porta) }).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        throw new Error(`La porta ${opts.porta} è già in uso: forse l'interfaccia è già aperta in un'altra finestra del terminale. In alternativa: npm run interfaccia -- --porta 4778`);
      }
      throw e;
    });
    console.log(`Interfaccia Scookie attiva su ${ui.url}`);
    console.log('È raggiungibile solo da questo computer. Per chiuderla: Ctrl+C in questa finestra.');
    if (opts.apri) openInBrowser(ui.url);
  });

program.parseAsync().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
