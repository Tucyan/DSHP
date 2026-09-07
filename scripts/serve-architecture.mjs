import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

// Serve only the three public assets, never the repository or runtime data.
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const port = Number(process.env.PGA_ARCHITECTURE_PORT || 3181);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PGA_ARCHITECTURE_PORT');
const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
  const pathname = (request.url || '/').split('?')[0];
  const asset = assets.get(pathname);
  if (!asset) { response.writeHead(404).end('Not found'); return; }
  try {
    const body = await readFile(new URL(`../docs/explorer/${asset[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(500).end('Unable to read page asset'); }
});
server.on('error', error => { process.stderr.write(`Architecture server: ${error.message}\n`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => process.stdout.write(`Architecture explorer: http://127.0.0.1:${port}\nPress Ctrl+C to stop.\n`));
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
