import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  surveysDir: string;
  themesDir: string;
  distDir: string;
  credentialsFile: string;
  /** Apps get `<label>.<appDomain>`; empty = path-based URLs only (local use). */
  appDomain: string;
  /** Host name of the administration (and fallback path-based app URLs). */
  adminHost: string;
  publicScheme: string;
  trustProxy: boolean;
  reservedLabels: string[];
  traefik: { dynamicFile: string; serviceUrl: string; entrypoint: string; certResolver: string } | null;
  /** If set, only a JSON list of subdomain labels is written here (rendered into Traefik config on the host). */
  routesJsonFile: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number');
  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    dataDir: path.resolve(env.DATA_DIR ?? '/data'),
    surveysDir: path.resolve(env.SURVEYS_DIR ?? '/surveys'),
    themesDir: path.resolve(env.THEMES_DIR ?? '/themes'),
    distDir: path.resolve(env.DIST_DIR ?? path.join(here, '..', 'dist')),
    credentialsFile: path.resolve(env.ADMIN_CREDENTIALS_FILE ?? '/config/admins.json'),
    appDomain: (env.APP_DOMAIN ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, ''),
    adminHost: (env.ADMIN_HOST ?? '').trim().toLowerCase(),
    publicScheme: env.PUBLIC_SCHEME === 'http' ? 'http' : 'https',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    reservedLabels: (env.RESERVED_SUBDOMAINS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    traefik: env.TRAEFIK_DYNAMIC_FILE
      ? {
          dynamicFile: path.resolve(env.TRAEFIK_DYNAMIC_FILE),
          serviceUrl: env.TRAEFIK_SERVICE_URL ?? 'http://pwa-container:8080',
          entrypoint: env.TRAEFIK_ENTRYPOINT ?? 'websecure',
          certResolver: env.TRAEFIK_CERT_RESOLVER ?? 'letsencrypt',
        }
      : null,
    routesJsonFile: env.ROUTES_JSON_FILE ? path.resolve(env.ROUTES_JSON_FILE) : null,
  };
}
