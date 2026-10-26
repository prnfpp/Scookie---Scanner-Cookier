import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../config/load.js';
import { configSchema } from '../config/schema.js';
import { discoverSite, type DiscoveryResult } from '../discovery/discover.js';
import { writeComparison } from '../report/compare.js';
import { applyReview, readReview, readReviewRows, REVIEW_FILE, writeReviewRows } from '../report/review.js';
import type { Progress } from '../progress.js';
import { COLLECTED_FILE, launchOptions, recordingFile, regenerateRun, resolveUserAgent, runAudit } from '../run.js';
import { closeSafely } from '../util/misc.js';
import { TOOL_VERSION } from '../version.js';
import { checkUpdates, restartWithUpdate } from './update.js';

const PAGE_FILE = fileURLToPath(new URL('../../../ui/index.html', import.meta.url));
const EXAMPLE_FILE = fileURLToPath(new URL('../../../config/esempio.yaml', import.meta.url));

const FILE_RE = /^[\w.-]+\.ya?ml$/i;
const RUN_RE = /^[\w.-]+$/;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.har': 'application/json; charset=utf-8',
  '.gz': 'application/gzip',
  '.sha256': 'text/plain; charset=utf-8',
};

export interface UiOptions {
  /** Cartella dei file di configurazione dei clienti. */
  clientsDir: string;
  /** Cartella in cui l'interfaccia salva le esecuzioni. */
  runsDir: string;
  port: number;
  log?: (msg: string) => void;
  /** Chiusura del programma dall'interfaccia ("Chiudi Scookie"); senza, i pulsanti di chiusura e riavvio sono disattivi. */
  onQuit?: () => void;
}

interface Job {
  id: number;
  kind: 'audit' | 'scopri';
  file: string;
  status: 'in-corso' | 'completato' | 'errore';
  startedAt: string;
  endedAt: string | null;
  log: string[];
  error: string | null;
  runName: string | null;
  discovery: DiscoveryResult[] | null;
  /** Avanzamento dell'audit (fase, sessioni, tempo stimato). */
  progress: Progress | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Contenuto di un file YAML di configurazione, letto in modo tollerante (anche se non valido). */
function readClient(dir: string, file: string) {
  const yaml = readFileSync(join(dir, file), 'utf8');
  let data: unknown = null;
  try {
    data = parse(yaml);
  } catch {
    // YAML non leggibile: l'interfaccia mostra il testo grezzo
  }
  const check = configSchema.safeParse(data);
  return {
    file,
    yaml,
    data,
    valid: check.success,
    errors: check.success ? [] : check.error.issues.map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`),
  };
}

/** Riepilogo dell'esecuzione (riepilogo.json) e avanzamento della revisione (revisione.csv). */
function summaryOf(dir: string) {
  let r: { configurazione?: string; gravita?: Record<string, number>; sitiSenzaDati?: string[]; durataSec?: number } = {};
  try {
    r = JSON.parse(readFileSync(join(dir, 'riepilogo.json'), 'utf8'));
  } catch {
    // esecuzione precedente all'introduzione del riepilogo
  }
  let revisionate: number | null = null;
  try {
    const rev = readReview(dir);
    if (rev) revisionate = [...rev.values()].filter((e) => e.esito).length;
  } catch {
    revisionate = null;
  }
  return { configurazione: r.configurazione ?? null, gravita: r.gravita ?? null, sitiSenzaDati: r.sitiSenzaDati ?? [], durataSec: r.durataSec ?? null, revisionate };
}

function listRuns(runsDir: string) {
  if (!existsSync(runsDir)) return [];
  // Rilevazioni interrotte nella fase finale: i dati raccolti ci sono (raccolta.json), il rapporto no
  const incomplete = readdirSync(runsDir)
    .filter((n) => RUN_RE.test(n) && existsSync(join(runsDir, n, COLLECTED_FILE)) && !existsSync(join(runsDir, n, 'manifest.json')))
    .map((name) => ({
      name,
      incompleta: true,
      cliente: name.replace(/^[\d_T-]+_/, '').replace(/-/g, ' '),
      inizio: statSync(join(runsDir, name, COLLECTED_FILE)).mtime.toISOString(),
    }));
  const complete = readdirSync(runsDir)
    .filter((n) => RUN_RE.test(n) && existsSync(join(runsDir, n, 'manifest.json')))
    .map((name) => {
      try {
        const m = JSON.parse(readFileSync(join(runsDir, name, 'manifest.json'), 'utf8')) as {
          cliente?: string;
          inizio?: string;
          fine?: string;
          sessioni?: number;
          criticita?: number;
          ambiente?: { uscita?: { country?: string | null; verified?: boolean } };
        };
        return {
          name,
          cliente: m.cliente ?? name,
          inizio: m.inizio ?? null,
          fine: m.fine ?? null,
          sessioni: m.sessioni ?? null,
          criticita: m.criticita ?? null,
          paese: m.ambiente?.uscita?.verified ? m.ambiente.uscita.country : null,
          pdf: existsSync(join(runsDir, name, 'report.pdf')),
          csv: existsSync(join(runsDir, name, 'rilievi.csv')) ? 'rilievi.csv' : 'criticita.csv',
          revisione: existsSync(join(runsDir, name, REVIEW_FILE)),
          rivisto: existsSync(join(runsDir, name, 'report-rivisto.html')),
          ...summaryOf(join(runsDir, name)),
        };
      } catch {
        return null;
      }
    })
    .filter((r) => r !== null);
  return [...incomplete, ...complete].sort((a, b) => String(b.inizio).localeCompare(String(a.inizio)));
}

/**
 * Interfaccia visuale locale: un piccolo server raggiungibile solo da questo computer.
 * Protezioni: ascolto su 127.0.0.1, controllo dell'intestazione Host (contro il DNS rebinding),
 * cookie di sessione SameSite=Strict e intestazione personalizzata per le API (contro richieste da altri siti).
 */
export async function startUi(opts: UiOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const clientsDir = resolve(opts.clientsDir);
  const runsDir = resolve(opts.runsDir);
  mkdirSync(clientsDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  const token = randomBytes(24).toString('hex');
  let job: Job | null = null;
  let jobSeq = 0;
  /** Chiude la navigazione manuale in corso (pulsante "Ho finito" dell'interfaccia). */
  let manualFinish: (() => void) | null = null;
  let port = opts.port;

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data));

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((ok, ko) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 2_000_000) {
          ko(new HttpError(413, 'Richiesta troppo grande'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          ko(new HttpError(400, 'JSON non valido'));
        }
      });
      req.on('error', ko);
    });

  const hasCookie = (req: IncomingMessage) => (req.headers.cookie ?? '').split(/;\s*/).includes(`scookie=${token}`);

  const startJob = (kind: Job['kind'], file: string, work: (j: Job) => Promise<void>) => {
    if (job?.status === 'in-corso') throw new HttpError(409, 'È già in corso un\'altra operazione: attendere che finisca.');
    const j: Job = {
      id: ++jobSeq,
      kind,
      file,
      status: 'in-corso',
      startedAt: new Date().toISOString(),
      endedAt: null,
      log: [],
      error: null,
      runName: null,
      discovery: null,
      progress: null,
    };
    job = j;
    work(j)
      .then(() => {
        j.status = 'completato';
      })
      .catch((e: Error) => {
        j.status = 'errore';
        j.error = e.message;
        j.log.push(`Errore: ${e.message}`);
      })
      .finally(() => {
        j.endedAt = new Date().toISOString();
      });
    return j;
  };

  const clientPath = (file: unknown) => {
    if (typeof file !== 'string' || !FILE_RE.test(file)) throw new HttpError(400, 'Nome file non valido (lettere, numeri, - _ . e estensione .yaml)');
    return join(clientsDir, file);
  };

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? 'GET';

    if (path === '/api/info' && method === 'GET') {
      return json(res, 200, { versione: TOOL_VERSION, clienti: clientsDir, esecuzioni: runsDir });
    }
    if (path === '/api/clienti' && method === 'GET') {
      const files = readdirSync(clientsDir).filter((f) => FILE_RE.test(f));
      return json(
        res,
        200,
        files.map((f) => {
          const c = readClient(clientsDir, f);
          const d = c.data as { cliente?: string; siti?: { url?: string }[] } | null;
          return { file: f, cliente: d?.cliente ?? f, siti: (d?.siti ?? []).map((s) => s?.url).filter(Boolean), valido: c.valid, modificato: statSync(join(clientsDir, f)).mtime.toISOString() };
        }),
      );
    }
    if (path === '/api/esempio' && method === 'GET') {
      return json(res, 200, { yaml: readFileSync(EXAMPLE_FILE, 'utf8'), data: parse(readFileSync(EXAMPLE_FILE, 'utf8')) });
    }
    // Percorsi registrati nelle navigazioni manuali (si rigiocano in automatico); "Registra di nuovo" li elimina
    const rec = /^\/api\/percorsi\/([^/]+)$/.exec(path);
    if (rec) {
      const p = clientPath(decodeURIComponent(rec[1]));
      const d = existsSync(p) ? (readClient(clientsDir, decodeURIComponent(rec[1])).data as { siti?: { url?: string }[] } | null) : null;
      const sites = (d?.siti ?? []).map((s) => s?.url).filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
      if (method === 'GET') {
        return json(
          res,
          200,
          sites.flatMap((site) => {
            const f = recordingFile(p, site);
            if (!existsSync(f)) return [];
            try {
              const r = JSON.parse(readFileSync(f, 'utf8')) as { savedAt: string; steps: unknown[] };
              return [{ sito: site, passi: r.steps.length, registrato: r.savedAt }];
            } catch {
              return [];
            }
          }),
        );
      }
      if (method === 'POST') {
        const body = (await readBody(req)) as { sito?: string };
        if (!body.sito || !sites.includes(body.sito)) throw new HttpError(400, 'Sito non presente nella configurazione');
        rmSync(recordingFile(p, body.sito), { force: true });
        return json(res, 200, { ok: true });
      }
    }
    const one = /^\/api\/clienti\/([^/]+)$/.exec(path);
    if (one && method === 'GET') {
      const p = clientPath(decodeURIComponent(one[1]));
      if (!existsSync(p)) throw new HttpError(404, 'Configurazione non trovata');
      return json(res, 200, readClient(clientsDir, decodeURIComponent(one[1])));
    }
    if (path === '/api/clienti' && method === 'POST') {
      // Salva dal modulo (data) o dal testo YAML (yaml). Si salva solo se la configurazione è valida.
      const body = (await readBody(req)) as { file?: string; data?: unknown; yaml?: string; nuovo?: boolean };
      const p = clientPath(body.file);
      if (body.nuovo && existsSync(p)) throw new HttpError(409, 'Esiste già una configurazione con questo nome');
      let data: unknown;
      try {
        data = typeof body.yaml === 'string' ? parse(body.yaml) : body.data;
      } catch (e) {
        throw new HttpError(400, `YAML non valido: ${(e as Error).message.split('\n')[0]}`);
      }
      const check = configSchema.safeParse(data);
      if (!check.success) {
        return json(res, 422, { errori: check.error.issues.map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`) });
      }
      const text = typeof body.yaml === 'string' ? body.yaml : stringify(data, { lineWidth: 0 });
      writeFileSync(p, text);
      return json(res, 200, { file: body.file });
    }
    if ((path === '/api/scopri' || path === '/api/avvia') && method === 'POST') {
      const body = (await readBody(req)) as { file?: string; pdf?: boolean; siti?: unknown };
      const onlySites = Array.isArray(body.siti) ? body.siti.filter((x): x is string => typeof x === 'string' && /^https?:\/\//.test(x)) : undefined;
      const p = clientPath(body.file);
      if (!existsSync(p)) throw new HttpError(404, 'Configurazione non trovata');
      const loaded = loadConfig(p); // lancia un errore leggibile se la configurazione non è valida
      if (path === '/api/scopri') {
        const j = startJob('scopri', body.file!, async (jj) => {
          const { config } = loaded;
          const browser = await chromium.launch(launchOptions(config));
          try {
            const ua = await resolveUserAgent(browser, config);
            jj.discovery = [];
            for (const site of config.siti) {
              jj.log.push(`Scoperta pagine di ${site.url}…`);
              const d = await discoverSite(browser, site, config, ua);
              jj.discovery.push(d);
              jj.log.push(`  ${d.found} URL trovate, campione di ${d.sample.length} pagine`);
            }
          } finally {
            await closeSafely(browser, 30000);
          }
        });
        return json(res, 202, { id: j.id });
      }
      const j = startJob('audit', body.file!, async (jj) => {
        const result = await runAudit(loaded, {
          onManualFinisher: (f) => {
            manualFinish = f;
          },
          outDir: runsDir,
          pdf: body.pdf === false ? false : undefined,
          onlySites,
          onProgress: (pr) => {
            jj.progress = pr;
          },
          log: (m) => {
            for (const line of m.split('\n')) if (line.trim()) jj.log.push(line);
            if (jj.log.length > 2000) jj.log.splice(0, jj.log.length - 2000);
          },
        });
        jj.runName = result.runDir.split(sep).pop() ?? null;
      });
      return json(res, 202, { id: j.id });
    }
    if (path === '/api/aggiornamenti' && method === 'GET') {
      return json(res, 200, { ...(await checkUpdates()), canQuit: !!opts.onQuit });
    }
    if ((path === '/api/esci' || path === '/api/aggiorna') && method === 'POST') {
      if (!opts.onQuit) throw new HttpError(404, 'Chiusura dall\'interfaccia non disponibile');
      if (job?.status === 'in-corso') throw new HttpError(409, 'Un audit è in corso: aspetta la fine prima di chiudere Scookie.');
      if (path === '/api/aggiorna') {
        if (!(await checkUpdates()).canRestart) throw new HttpError(409, 'Aggiornamento automatico disponibile solo avviando Scookie dall\'icona su Mac.');
        restartWithUpdate();
      }
      json(res, 200, { ok: true });
      setTimeout(() => opts.onQuit!(), 300);
      return;
    }
    // "Ho finito" dall'interfaccia, se il riquadro nella finestra del browser non è raggiungibile
    if (path === '/api/manuale/fatto' && method === 'POST') {
      if (!manualFinish) throw new HttpError(409, 'Nessuna navigazione manuale in corso');
      manualFinish();
      manualFinish = null;
      return json(res, 200, { ok: true });
    }
    if (path === '/api/lavoro' && method === 'GET') {
      return json(res, 200, job);
    }
    if (path === '/api/esecuzioni' && method === 'GET') {
      return json(res, 200, listRuns(runsDir));
    }
    const rev = /^\/api\/revisione\/([^/]+)$/.exec(path);
    if (rev) {
      const n = decodeURIComponent(rev[1]);
      if (!RUN_RE.test(n) || n === '.' || n === '..' || !existsSync(join(runsDir, n, REVIEW_FILE))) throw new HttpError(404, 'Esecuzione non valida o senza modulo di revisione');
      if (method === 'GET') return json(res, 200, readReviewRows(join(runsDir, n)));
      if (method === 'POST') {
        const body = (await readBody(req)) as { righe?: { chiave: string; esito: string; nota: string }[] };
        try {
          return json(res, 200, writeReviewRows(join(runsDir, n), Array.isArray(body.righe) ? body.righe : []));
        } catch (e) {
          throw new HttpError(422, (e as Error).message);
        }
      }
    }
    if (path === '/api/revisione' && method === 'POST') {
      const body = (await readBody(req)) as { esecuzione?: unknown };
      const n = body.esecuzione;
      if (typeof n !== 'string' || !RUN_RE.test(n) || n === '.' || n === '..' || !existsSync(join(runsDir, n, REVIEW_FILE))) throw new HttpError(400, 'Esecuzione non valida o senza revisione.csv');
      const r = await applyReview(join(runsDir, n)).catch((e: Error) => {
        throw new HttpError(422, e.message);
      });
      const v = [...r.review.values()];
      return json(res, 200, {
        html: 'report-rivisto.html',
        pdf: r.pdf ? 'report-rivisto.pdf' : null,
        confermate: v.filter((e) => e.esito === 'confermato').length,
        falsiPositivi: v.filter((e) => e.esito === 'falso positivo').length,
        nonRevisionate: v.filter((e) => !e.esito).length,
      });
    }
    // Rapporto rigenerato dai dati raccolti: per una rilevazione interrotta nella fase finale, oppure (copia) per
    // applicare le regole della versione attuale a una rilevazione passata
    if (path === '/api/rigenera' && method === 'POST') {
      const body = (await readBody(req)) as { esecuzione?: unknown; copia?: unknown };
      const n = body.esecuzione;
      if (typeof n !== 'string' || !RUN_RE.test(n) || n === '.' || n === '..' || !existsSync(join(runsDir, n))) throw new HttpError(400, 'Esecuzione non valida');
      const j = startJob('audit', n, async (jj) => {
        const result = await regenerateRun(join(runsDir, n), {
          copy: body.copia === true,
          log: (m) => {
            for (const line of m.split('\n')) if (line.trim()) jj.log.push(line);
          },
        });
        jj.runName = result.runDir.split(sep).pop() ?? null;
      });
      return json(res, 202, { id: j.id });
    }
    if (path === '/api/confronta' && method === 'POST') {
      const body = (await readBody(req)) as { prima?: unknown; dopo?: unknown };
      const dirOf = (n: unknown) => {
        if (typeof n !== 'string' || !RUN_RE.test(n) || n === '.' || n === '..' || !existsSync(join(runsDir, n, 'dati.json'))) throw new HttpError(400, 'Esecuzione non valida');
        return join(runsDir, n);
      };
      const { path: out, comparison: c } = writeComparison(dirOf(body.prima), dirOf(body.dopo));
      return json(res, 200, { file: out.split(sep).pop(), risolte: c.risolte.length, rimaste: c.rimaste.length, nuove: c.nuove.length });
    }
    throw new HttpError(404, 'Risorsa non trovata');
  }

  /** File delle esecuzioni (report, immagini, CSV): solo dentro la cartella esecuzioni. */
  function serveRunFile(res: ServerResponse, rel: string) {
    const parts = rel.split('/').map(decodeURIComponent);
    if (!parts.length || !RUN_RE.test(parts[0]) || parts.some((x) => x === '..' || x === '' || x.includes('\\'))) {
      throw new HttpError(400, 'Percorso non valido');
    }
    const abs = resolve(runsDir, ...parts);
    if (!abs.startsWith(runsDir + sep) || !existsSync(abs) || !statSync(abs).isFile()) throw new HttpError(404, 'File non trovato');
    const ext = extname(abs).toLowerCase();
    const download = ['.har', '.gz', '.csv', '.json', '.sha256'].includes(ext);
    // I report contengono testi presi dai siti verificati: nella stessa origine dell'interfaccia non devono
    // poter eseguire script né caricare risorse esterne, anche se un testo sfuggisse all'escape.
    const headers: Record<string, string> = {
      'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    };
    if (download) headers['content-disposition'] = `attachment; filename="${parts[parts.length - 1].replace(/[^\w.-]/g, '_')}"`;
    send(res, 200, readFileSync(abs), TYPES[ext] ?? 'application/octet-stream', headers);
  }

  const server = createServer(async (req, res) => {
    try {
      // Contro il DNS rebinding: si accettano solo richieste indirizzate a questo computer.
      if (!allowedHosts().has(req.headers.host ?? '')) throw new HttpError(403, 'Host non consentito');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = url.pathname;
      if (path === '/' && req.method === 'GET') {
        // La pagina si apre solo con la chiave di questa sessione (nell'indirizzo aperto dall'icona o dal Terminale)
        // o con il cookie già ricevuto: sullo stesso computer un altro utente non può usare questa interfaccia.
        if (url.searchParams.get('t') !== token && !hasCookie(req)) {
          return send(
            res,
            403,
            '<!doctype html><meta charset="utf-8"><title>Scookie</title><body style="font:16px/1.5 system-ui;max-width:560px;margin:80px auto;padding:0 16px"><h1>Scookie</h1><p>Questa interfaccia appartiene a un\'altra sessione o va aperta dall\'icona Scookie sulla Scrivania (o dal Terminale con <code>npm run interfaccia</code>).</p></body>',
            'text/html; charset=utf-8',
          );
        }
        const page = readFileSync(PAGE_FILE, 'utf8');
        return send(res, 200, page, 'text/html; charset=utf-8', {
          'set-cookie': `scookie=${token}; HttpOnly; SameSite=Strict; Path=/`,
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
          'x-frame-options': 'DENY',
        });
      }
      if (!hasCookie(req)) throw new HttpError(401, 'Sessione non valida: ricaricare la pagina iniziale');
      if (path.startsWith('/api/')) {
        // Intestazione personalizzata: una pagina di un altro sito non può inviarla senza permesso (CORS).
        if (req.headers['x-scookie'] !== '1') throw new HttpError(403, 'Richiesta non consentita');
        return await api(req, res, path);
      }
      if (path.startsWith('/esecuzioni/')) return serveRunFile(res, path.slice('/esecuzioni/'.length));
      throw new HttpError(404, 'Risorsa non trovata');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`Errore interfaccia: ${(e as Error).message}`);
      if (!res.headersSent) json(res, status, { errore: (e as Error).message.split('\n')[0] });
    }
  });

  await new Promise<void>((ok, ko) => {
    server.once('error', ko);
    server.listen(opts.port, '127.0.0.1', () => ok());
  });
  port = (server.address() as AddressInfo).port;
  // indirizzo con la chiave della sessione: solo chi lo riceve (questo utente) può aprire l'interfaccia
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  return { server, url, close: () => new Promise((ok) => server.close(() => ok())) };
}

/** Apre l'indirizzo nel browser predefinito del sistema. */
export function openInBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // nessun browser disponibile: l'indirizzo è comunque stampato nel terminale
  }
}
