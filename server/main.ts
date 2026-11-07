import http from 'node:http';
import { createApp } from './app.ts';
import { AdminAuth } from './auth.ts';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { AppRegistry } from './registry.ts';
import { createTraefikWriter } from './traefik.ts';

// Files this process creates (databases, routes) are not readable for others on the host.
process.umask(0o027);

// Request logging is deliberately absent: the server never writes client addresses or
// request details anywhere. Only startup messages and internal errors are printed.
const log = (msg: string) => console.log(`[pwa-container] ${msg}`);

const config = loadConfig();
const store = new Store(config.dataDir);
const registry = new AppRegistry(store, config.surveysDir, config.dataDir, log, {
  reservedLabels: [...config.reservedLabels, config.adminHost.endsWith('.' + config.appDomain) ? config.adminHost.split('.')[0] : ''].filter(Boolean),
  onChange: createTraefikWriter(config, log),
});
const auth = new AdminAuth(config.credentialsFile);
const handler = createApp({
  store,
  registry,
  auth,
  distDir: config.distDir,
  themesDir: config.themesDir,
  log,
  appDomain: config.appDomain,
  adminHost: config.adminHost,
  publicScheme: config.publicScheme,
  trustProxy: config.trustProxy,
});
if (config.appDomain) log(`apps are served on <subdomain>.${config.appDomain}; administration on ${config.adminHost || '(any other host)'}`);

const server = http.createServer((req, res) => {
  handler(req, res).catch((err: unknown) => {
    log(`request failed: ${(err as Error)?.message ?? String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    } else {
      res.destroy();
    }
  });
});
// Backstop: an unexpected rejection is logged instead of ending the process.
process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${(reason as Error)?.message ?? String(reason)}`));
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;
server.maxConnections = 512;
server.listen(config.port, config.host, () => {
  log(`listening on ${config.host}:${config.port} with ${registry.list().length} app(s)`);
});

// Hourly maintenance: rewrites changed database files so no insertion order remains.
setInterval(() => {
  try {
    store.maintenance();
  } catch (err) {
    log(`maintenance failed: ${(err as Error).message}`);
  }
}, 60 * 60_000).unref();

// `docker kill -s HUP <container>` re-reads provisioned surveys after a deployment update.
process.on('SIGHUP', () => {
  registry.reload();
  log(`reloaded: ${registry.list().length} app(s)`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
