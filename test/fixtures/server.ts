import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cartella dei siti di prova (sorgenti, non compilati). */
export const FIXTURES = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
};
const TYPES_EXTRA: Record<string, string> = { '.css': 'text/css', '.svg': 'image/svg+xml' };
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Server di prova: risponde a qualsiasi host (Chromium usa --host-resolver-rules per mandare
 * tutto a 127.0.0.1). I siti sono in fixtures/sites/<host>/, i tracker finti in fixtures/trackers/.
 */
export async function startFixtureServer(): Promise<{ server: Server; port: number; httpsPort: number; close: () => Promise<void> }> {
  let port = 0;
  let httpsPort = 0;
  let flakyFailed = false;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? '').split(':')[0];
    // Host "instabile": la prima richiesta non riceve risposta (come uno script di CMP che non si carica)
    if (host === 'cdn.flaky.example' && !flakyFailed) {
      flakyFailed = true;
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const siteDir = join(FIXTURES, 'sites', host);
    const send = (status: number, body: string | Buffer, type: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (existsSync(siteDir)) {
      let file = normalize(join(siteDir, url.pathname));
      if (!file.startsWith(siteDir)) return send(403, '', 'text/plain');
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      // Applicazione a pagina singola: ogni percorso senza file risponde con la pagina principale
      if (!existsSync(file) && existsSync(join(siteDir, '_spa')) && !extname(file)) file = join(siteDir, 'index.html');
      if (!existsSync(file)) {
        // Pagina d'errore del tema: 404 con una pagina HTML completa (intestazione, piè di pagina)
        const page404 = join(siteDir, '_404.html');
        if (existsSync(page404)) return send(404, readFileSync(page404, 'utf8').replaceAll('{{PORT}}', String(port)).replaceAll('{{HTTPS_PORT}}', String(httpsPort)), TYPES['.html']);
        return send(404, 'non trovato', 'text/plain');
      }
      // senza estensione: testo semplice, come il servizio reale /cdn-cgi/trace
      const type = TYPES[extname(file)] ?? TYPES_EXTRA[extname(file)] ?? 'text/plain';
      const body = readFileSync(file, 'utf8').replaceAll('{{PORT}}', String(port)).replaceAll('{{HTTPS_PORT}}', String(httpsPort));
      // Intestazioni e stato personalizzati per sito (es. pagina di verifica anti-bot)
      const meta = join(siteDir, '_risposta.json');
      if (existsSync(meta) && extname(file) === '.html') {
        const m = JSON.parse(readFileSync(meta, 'utf8')) as { status: number; headers: Record<string, string> };
        res.writeHead(m.status, { 'content-type': type, ...m.headers });
        return res.end(body);
      }
      return send(200, body, type);
    }
    // Host di terze parti: script finti o pixel
    const tracker = join(FIXTURES, 'trackers', url.pathname.split('/').pop() ?? '');
    if (url.pathname.endsWith('.js')) {
      return send(200, existsSync(tracker) ? readFileSync(tracker, 'utf8') : '', 'application/javascript');
    }
    return send(200, GIF, 'image/gif');
  };
  const server = createServer(handler);
  // Stessi siti anche in HTTPS (certificato di prova in fixtures/tls): serve ai contenuti incorporati che scrivono
  // cookie SameSite=None; Secure, che il browser accetta solo in HTTPS
  const tls = join(FIXTURES, 'tls');
  const secure = createHttpsServer({ key: readFileSync(join(tls, 'chiave.pem')), cert: readFileSync(join(tls, 'certificato.pem')) }, handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => secure.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  httpsPort = (secure.address() as AddressInfo).port;
  return {
    server,
    port,
    httpsPort,
    close: () => Promise.all([new Promise<void>((r) => server.close(() => r())), new Promise<void>((r) => secure.close(() => r()))]).then(() => {}),
  };
}
