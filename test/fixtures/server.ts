import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
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
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Server di prova: risponde a qualsiasi host (Chromium usa --host-resolver-rules per mandare
 * tutto a 127.0.0.1). I siti sono in fixtures/sites/<host>/, i tracker finti in fixtures/trackers/.
 */
export async function startFixtureServer(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  let port = 0;
  let flakyFailed = false;
  const server = createServer((req, res) => {
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
      if (!existsSync(file)) return send(404, 'non trovato', 'text/plain');
      // senza estensione: testo semplice, come il servizio reale /cdn-cgi/trace
      const type = TYPES[extname(file)] ?? 'text/plain';
      const body = readFileSync(file, 'utf8').replaceAll('{{PORT}}', String(port));
      return send(200, body, type);
    }
    // Host di terze parti: script finti o pixel
    const tracker = join(FIXTURES, 'trackers', url.pathname.split('/').pop() ?? '');
    if (url.pathname.endsWith('.js')) {
      return send(200, existsSync(tracker) ? readFileSync(tracker, 'utf8') : '', 'application/javascript');
    }
    return send(200, GIF, 'image/gif');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  return { server, port, close: () => new Promise((r) => server.close(() => r())) };
}
