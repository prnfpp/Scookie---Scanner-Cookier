import { z } from 'zod';

const bannerSchema = z
  .object({
    /** Selettore CSS (o Playwright) del pulsante di rifiuto al primo livello. */
    rifiuta: z.string().optional(),
    /** Selettore del pulsante "accetta tutti". */
    accetta: z.string().optional(),
    /** Selettore del pulsante che apre le preferenze (secondo livello). */
    preferenze: z.string().optional(),
    /** Selettore del pulsante di rifiuto/salvataggio dentro le preferenze. */
    rifiutaNellePreferenze: z.string().optional(),
    /** Selettore dell'iframe che contiene il banner, se c'è. */
    frame: z.string().optional(),
    /** Selettore di un elemento che indica che il banner è visibile. */
    contenitore: z.string().optional(),
    /** Attesa extra (ms) prima di cercare il banner. */
    attesa: z.number().int().nonnegative().optional(),
  })
  .strict();

const siteSchema = z
  .object({
    url: z.url(),
    /** Etichetta leggibile nel report. */
    nome: z.string().optional(),
    /** Legge robots.txt e sitemap.xml per scoprire le pagine. */
    sitemap: z.boolean().default(true),
    /** Segue i link interni della home per scoprire le pagine. */
    seguiLink: z.boolean().default(true),
    /** URL aggiunte a mano (es. step del preventivo). Sempre incluse. */
    pagineExtra: z.array(z.string()).default([]),
    /**
     * Esplorazione con clic (pulsanti, menu, schede) per trovare pagine assenti da sitemap e link:
     * auto = solo se la scoperta trova poche pagine; sempre; no.
     */
    esplora: z.enum(['auto', 'sempre', 'no']).default('auto'),
    /** Se true usa solo la home e le pagine extra. */
    soloPagineExtra: z.boolean().default(false),
    /** Esclude dal campione automatico le pagine vietate da robots.txt (le pagine extra restano). */
    rispettaRobots: z.boolean().default(true),
    /** Pattern (regex sul path) da escludere dal campione. */
    escludi: z.array(z.string()).default([]),
    /** URL della cookie policy (documentata nel report). */
    cookiePolicy: z.string().optional(),
    /** File CSV o YAML con l'elenco dichiarato, se non leggibile dal CMP. */
    dichiarati: z.string().optional(),
    /** Selettori manuali del banner: hanno la precedenza su adattatori ed euristica. */
    banner: bannerSchema.optional(),
    /**
     * Navigazione manuale assistita, per i flussi che il tool non sa percorrere (es. preventivo con moduli):
     * il browser si apre visibile, il tool esegue la scelta sul banner e poi l'operatore naviga a mano
     * seguendo le istruzioni, fino al pulsante "Ho finito". Tutto viene registrato come nelle altre sessioni.
     */
    navigazioneManuale: z
      .object({
        istruzioni: z.string().min(1),
        /** Pagina da cui partire (percorso o URL); predefinita: la prima del campione. */
        partenza: z.string().optional(),
        scenari: z.array(z.enum(['nessuna-azione', 'rifiuta', 'accetta'])).min(1).default(['rifiuta', 'accetta']),
        maxMinuti: z.number().positive().max(60).default(10),
      })
      .strict()
      .optional(),
  })
  .strict();

export const configSchema = z
  .object({
    cliente: z.string(),
    /** Cartella in cui creare le esecuzioni. */
    output: z.string().default('./runs'),
    browser: z
      .object({
        headless: z.boolean().default(true),
        locale: z.string().default('it-IT'),
        timezone: z.string().default('Europe/Rome'),
        viewport: z
          .object({ width: z.number().int(), height: z.number().int() })
          .default({ width: 1366, height: 900 }),
        /** Testo aggiunto allo user agent standard per dichiarare l'audit. */
        userAgentSuffix: z.string().default('ScookieAudit/0.1'),
        /** User agent completo (sostituisce quello standard). */
        userAgent: z.string().optional(),
        /**
         * Esecuzione di controllo: user agent come quello di un browser normale (senza "HeadlessChrome" e senza
         * la dichiarazione dell'audit). Serve a verificare se sistemi anti-bot o verifiche alterano i risultati;
         * il report lo indica. Da usare insieme a headless: false.
         */
        uaNormale: z.boolean().default(false),
        /** Paese da cui deve partire la navigazione (codice ISO a 2 lettere). Viene verificato all'avvio. */
        paeseUscita: z.string().length(2).default('IT'),
        /**
         * Verifica del paese di uscita: avvisa (default) segnala la differenza nel report,
         * blocca interrompe l'esecuzione, no disattiva la verifica.
         */
        verificaUscita: z.enum(['avvisa', 'blocca', 'no']).default('avvisa'),
        /** Servizio che restituisce ip= e loc= (formato /cdn-cgi/trace di Cloudflare). */
        servizioUscita: z.string().default('https://www.cloudflare.com/cdn-cgi/trace'),
        /** Proxy opzionale, es. per uscire da un paese specifico. */
        proxy: z.string().optional(),
        /**
         * Browser da usare: chromium (incluso), chrome o msedge (installati sul computer).
         * Con headless: false il browser è visibile: alcuni siti protetti da sistemi anti-bot si comportano
         * diversamente con i browser "senza finestra". Lo user agent continua a dichiarare l'audit.
         */
        canale: z.enum(['chromium', 'chrome', 'msedge']).default('chromium'),
        /** Percorso dell'eseguibile Chromium, se diverso da quello di Playwright. */
        executablePath: z.string().optional(),
        /** Solo per test: regole di risoluzione host di Chromium. */
        hostResolverRules: z.string().optional(),
      })
      .strict()
      .default({
        headless: true,
        canale: 'chromium',
        uaNormale: false,
        locale: 'it-IT',
        timezone: 'Europe/Rome',
        viewport: { width: 1366, height: 900 },
        userAgentSuffix: 'ScookieAudit/0.1',
        paeseUscita: 'IT',
        verificaUscita: 'avvisa',
        servizioUscita: 'https://www.cloudflare.com/cdn-cgi/trace',
      }),
    /** Protocollo di osservazione: identico per ogni pagina e sessione. */
    protocollo: z
      .object({
        timeoutNavigazione: z.number().int().positive().default(45000),
        /** Durata massima di una sessione: oltre, viene interrotta e i dati raccolti fin lì restano nel report. */
        timeoutSessione: z.number().int().positive().default(300000),
        attesaDopoCaricamento: z.number().int().nonnegative().default(4000),
        scroll: z.boolean().default(true),
        attesaDopoScroll: z.number().int().nonnegative().default(2000),
        attesaDopoScelta: z.number().int().nonnegative().default(4000),
        /** Pausa tra una sessione e l'altra (navigazione lenta). */
        pausaTraSessioni: z.number().int().nonnegative().default(3000),
      })
      .strict()
      .default({
        timeoutNavigazione: 45000,
        timeoutSessione: 300000,
        attesaDopoCaricamento: 4000,
        scroll: true,
        attesaDopoScroll: 2000,
        attesaDopoScelta: 4000,
        pausaTraSessioni: 3000,
      }),
    scenari: z
      .object({
        /**
         * percorso: "nessuna azione" su ogni pagina; "rifiuta" e "accetta" una volta per sito
         * partendo dalla home e navigando le altre pagine del campione.
         * per-pagina: tutti e tre gli scenari su ogni pagina campionata.
         */
        modalita: z.enum(['percorso', 'per-pagina']).default('percorso'),
        /** Pagine da visitare dopo la scelta (minimo 1). */
        pagineDopoScelta: z.number().int().min(1).default(3),
        /**
         * Scenari da eseguire. personalizza = accetta solo la categoria statistica (per i CMP che lo consentono in modo
         * affidabile); revoca = accetta, poi revoca il consenso dal link nella pagina e rifiuta.
         */
        attivi: z
          .array(z.enum(['nessuna-azione', 'rifiuta', 'accetta', 'personalizza', 'revoca']))
          .default(['nessuna-azione', 'rifiuta', 'accetta', 'personalizza', 'revoca']),
      })
      .strict()
      .default({ modalita: 'percorso', pagineDopoScelta: 3, attivi: ['nessuna-azione', 'rifiuta', 'accetta', 'personalizza', 'revoca'] }),
    campionamento: z
      .object({
        /** Pagine per tipo nel primo giro di campionamento; se i tipi sono pochi, il campione si completa fino a maxPagine. */
        perTipo: z.number().int().positive().default(2),
        maxPagine: z.number().int().positive().default(15),
        /** Numero massimo di URL lette dalle sitemap. */
        maxUrlSitemap: z.number().int().positive().default(5000),
        /** Tipi di pagina: nome -> regex sul path. Il primo che corrisponde vince. */
        tipi: z.record(z.string(), z.string()).default({}),
        /** Limiti dell'esplorazione con clic. In modalità auto parte se si trovano meno di "sePaginaMeno" pagine. */
        esplorazione: z
          .object({
            sePaginaMeno: z.number().int().nonnegative().default(5),
            profondita: z.number().int().min(1).max(4).default(2),
            maxClic: z.number().int().positive().default(40),
            maxPagine: z.number().int().positive().default(25),
            maxSecondi: z.number().int().positive().default(240),
          })
          .strict()
          .default({ sePaginaMeno: 5, profondita: 2, maxClic: 40, maxPagine: 25, maxSecondi: 240 }),
      })
      .strict()
      .default({
        perTipo: 2,
        maxPagine: 15,
        maxUrlSitemap: 5000,
        tipi: {},
        esplorazione: { sePaginaMeno: 5, profondita: 2, maxClic: 40, maxPagine: 25, maxSecondi: 240 },
      }),
    /** Domini (registrabili) da considerare di prima parte oltre a quello del sito. */
    dominiPropri: z.array(z.string()).default([]),
    /** File YAML con norme e collegamento regole -> norme. */
    norme: z.string().optional(),
    /** File YAML aggiuntivo di domini tracker (si somma all'elenco incluso). */
    trackerExtra: z.string().optional(),
    report: z
      .object({
        pdf: z.boolean().default(true),
        /**
         * Corpi delle risposte nei file HAR: tutti, testo (solo risposte testuali fino a 512 KB) o nessuno.
         * I corpi delle richieste (dati inviati ai terzi) restano sempre.
         */
        harContenuti: z.enum(['tutti', 'testo', 'nessuno']).default('testo'),
        /** Testo libero da includere nella sezione "Limiti". */
        noteLimiti: z.array(z.string()).default([]),
      })
      .strict()
      .default({ pdf: true, harContenuti: 'testo', noteLimiti: [] }),
    siti: z.array(siteSchema).min(1),
  })
  .strict();

export type AuditConfig = z.infer<typeof configSchema>;
export type SiteConfig = z.infer<typeof siteSchema>;
export type BannerConfig = z.infer<typeof bannerSchema>;
