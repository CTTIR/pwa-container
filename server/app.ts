import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { compactAnswers, validateAnswers } from '../shared/schema.ts';
import type { AdminAuth } from './auth.ts';
import type { Store } from './db.ts';
import { STATIC_LIMITS, type AppEntry, type AppRegistry } from './registry.ts';
import { buildCsv, exportKeys, fieldInfos, summarize } from './report.ts';

export interface AppDeps {
  store: Store;
  registry: AppRegistry;
  auth: AdminAuth;
  distDir: string;
  themesDir: string;
  log: (msg: string) => void;
  now?: () => Date;
  /** With an app domain every app is served on `<label>.<appDomain>`. */
  appDomain?: string;
  adminHost?: string;
  publicScheme?: string;
}

const MAX_BODY = 64 * 1024;
const MAX_DEFINITION = 1024 * 1024;
const SUBMISSION_ID = /^[A-Za-z0-9-]{16,64}$/;
const REALM = 'pwa-container administration';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
};

const BASE_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
];
const CSP = [...BASE_CSP, "script-src 'self'", "style-src 'self' 'unsafe-inline'", "worker-src 'self'"].join('; ');
// Uploaded web apps are trusted admin content and are often single-file HTML apps with inline code.
const STATIC_APP_CSP = [
  ...BASE_CSP,
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join('; ');

function securityHeaders(res: ServerResponse, csp = CSP): void {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function sendJson(res: ServerResponse, status: number, body: unknown, cache = 'no-store'): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/** Resolves a request path inside a root directory, refusing anything that escapes it. */
function safeJoin(root: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

function serveFile(req: IncomingMessage, res: ServerResponse, file: string, cacheControl: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return false;
  const lastModified = stat.mtime.toUTCString();
  const since = req.headers['if-modified-since'];
  if (since && Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(since) / 1000)) {
    res.writeHead(304, { 'Cache-Control': cacheControl, 'Last-Modified': lastModified });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
    'Last-Modified': lastModified,
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage, res: ServerResponse, limit: number): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    sendJson(res, 415, { error: 'unsupported_media_type' });
    return { ok: false };
  }
  const body = await readBody(req, limit);
  if (body === null) {
    sendJson(res, 413, { error: 'too_large' });
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return { ok: false };
  }
}

function localDate(d: Date): string {
  // Calendar day only, in the container's time zone (TZ). Times are never stored.
  return d.toLocaleDateString('sv-SE');
}

export function createApp(deps: AppDeps) {
  const { store, registry, auth, distDir, themesDir, log } = deps;
  const now = deps.now ?? (() => new Date());
  const appDomain = deps.appDomain ?? '';
  const adminHost = deps.adminHost ?? '';
  const scheme = deps.publicScheme ?? 'https';

  function requestHost(req: IncomingMessage): string {
    return String(req.headers.host ?? '')
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, '');
  }

  /** The app addressed by its own subdomain, or null for the administration host. */
  function hostApp(req: IncomingMessage): AppEntry | null | 'unknown' {
    if (!appDomain) return null;
    const host = requestHost(req);
    if (host === adminHost || !host.endsWith('.' + appDomain)) return null;
    const label = host.slice(0, -(appDomain.length + 1));
    if (!label || label.includes('.')) return 'unknown';
    return registry.byHostLabel(label) ?? 'unknown';
  }

  function publicUrl(app: AppEntry): string {
    if (appDomain) return `${scheme}://${app.hostLabel}.${appDomain}/`;
    return app.type === 'survey' ? `/s/${app.id}` : `/a/${app.id}/`;
  }
  const indexHtml = path.join(distDir, 'index.html');
  const adminHtml = path.join(distDir, 'admin.html');

  function surveyPublic(app: AppEntry) {
    const def = app.survey!.def;
    return { status: registry.statusOf(app, now()), opensAt: def.opensAt ?? null, closesAt: def.closesAt ?? null };
  }

  async function handleSubmit(req: IncomingMessage, res: ServerResponse, app: AppEntry): Promise<void> {
    const def = app.survey!.def;
    const body = await readJson(req, res, MAX_BODY);
    if (!body.ok) return;
    const payload = (body.value ?? {}) as { submissionId?: unknown; answers?: unknown };
    const status = registry.statusOf(app, now());
    if (status !== 'open') {
      sendJson(res, 409, { error: status });
      return;
    }
    if (typeof payload.submissionId !== 'string' || !SUBMISSION_ID.test(payload.submissionId)) {
      sendJson(res, 400, { error: 'invalid_submission_id' });
      return;
    }
    const problems = validateAnswers(def, payload.answers);
    if (Object.keys(problems).length > 0) {
      sendJson(res, 422, { error: 'invalid', fields: problems, version: def.version });
      return;
    }
    const answers = compactAnswers(def, payload.answers as Record<string, never>);
    const result = store.insert(def.id, def.version, payload.submissionId, answers, localDate(now()), def.maxResponses);
    if (result === 'full') sendJson(res, 409, { error: 'full' });
    else sendJson(res, result === 'stored' ? 201 : 200, { status: result });
  }

  /** Basic authentication for /admin. Resolves to the granted role, or null after answering. */
  function authorize(req: IncomingMessage, res: ServerResponse, surveyId?: string): Promise<'global' | 'survey' | null> {
    return new Promise((resolve) => {
      if (auth.throttled()) {
        sendText(res, 429, 'Too many failed sign-in attempts. Try again in a few minutes.');
        resolve(null);
        return;
      }
      const role = auth.authenticate(req.headers.authorization, surveyId);
      if (role === 'global' || role === 'survey') {
        resolve(role);
        return;
      }
      if (role === 'other') {
        sendText(res, 403, 'Diese Zugangsdaten gelten nicht für diese Seite.');
        resolve(null);
        return;
      }
      // A short pause slows down password guessing.
      setTimeout(() => {
        res.writeHead(401, {
          'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end('Authentication required');
        resolve(null);
      }, 600);
    });
  }

  /** State-changing admin requests must come from the admin page itself (CSRF guard). */
  function sameOriginWrite(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const originOk = !origin || (() => {
      try {
        return new URL(origin).host === host;
      } catch {
        return false;
      }
    })();
    if (req.headers['x-requested-with'] !== 'pwa-container' || !originOk) {
      sendJson(res, 403, { error: 'forbidden' });
      return false;
    }
    return true;
  }

  function appInfo(app: AppEntry) {
    const base = {
      id: app.id,
      type: app.type,
      source: app.source,
      title: app.title,
      enabled: app.enabled,
      installedOn: app.installedOn,
      hostLabel: app.hostLabel,
      url: publicUrl(app),
    };
    if (app.type !== 'survey' || !app.survey) return base;
    const def = app.survey.def;
    return {
      ...base,
      version: def.version,
      status: registry.statusOf(app, now()),
      statusOverride: app.statusOverride,
      opensAt: def.opensAt ?? null,
      closesAt: def.closesAt ?? null,
      responses: store.count(app.id),
      subtitle: def.subtitle ?? null,
    };
  }

  async function handleAdminApi(req: IncomingMessage, res: ServerResponse, parts: string[], method: string): Promise<void> {
    // parts: ['admin', 'api', ...]
    const area = parts[2];

    if (area === 'results') {
      const id = parts[3];
      const app = id ? registry.get(id) : undefined;
      if (!app || app.type !== 'survey' || !app.survey) {
        sendText(res, 404, 'Not found');
        return;
      }
      if (!(await authorize(req, res, app.id))) return;
      const def = app.survey.def;
      const rows = store.list(def.id);
      switch (parts[4]) {
        case 'summary':
          sendJson(res, 200, {
            survey: { ...appInfo(app), title: def.title, subtitle: def.subtitle ?? null },
            definition: def,
            responses: rows.length,
            fields: fieldInfos(def),
            summary: summarize(def, rows),
          });
          return;
        case 'responses':
          sendJson(res, 200, { survey: { id: def.id, version: def.version, title: def.title }, keys: exportKeys(def, rows), fields: fieldInfos(def), rows });
          return;
        case 'export.csv':
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${def.id}_responses.csv"`,
            'Cache-Control': 'no-store',
          });
          res.end(buildCsv(def, rows));
          return;
        default:
          sendText(res, 404, 'Not found');
      }
      return;
    }

    // Everything else needs global administrator access.
    const role = await authorize(req, res);
    if (!role) return;
    if (role !== 'global') {
      sendText(res, 403, 'Kein Zugriff auf die Verwaltung.');
      return;
    }

    if (area === 'whoami' && method === 'GET') {
      sendJson(res, 200, { role });
      return;
    }

    if (area !== 'apps') {
      sendText(res, 404, 'Not found');
      return;
    }

    if (parts.length === 3 && method === 'GET') {
      let themes: string[] = [];
      try {
        themes = fs.readdirSync(themesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
      } catch {
        /* no themes */
      }
      sendJson(res, 200, {
        apps: registry.list().map(appInfo),
        problems: registry.problems,
        themes,
        limits: STATIC_LIMITS,
        appDomain: appDomain || null,
      });
      return;
    }

    if (method !== 'GET' && !sameOriginWrite(req, res)) return;

    if (parts.length === 4 && parts[3] === 'surveys' && method === 'POST') {
      const body = await readJson(req, res, MAX_DEFINITION);
      if (!body.ok) return;
      const error = registry.installSurvey(body.value);
      if (error) sendJson(res, 422, { error });
      else sendJson(res, 201, { status: 'installed' });
      return;
    }

    const id = parts[3];
    const app = id ? registry.get(id) : undefined;

    // Static app upload: begin (also for new ids), files, publish.
    if (parts[4] === 'static' && id) {
      if (parts[5] === 'begin' && method === 'POST') {
        const body = await readJson(req, res, MAX_BODY);
        if (!body.ok) return;
        const title = String((body.value as { title?: unknown })?.title ?? id).trim() || id;
        const error = registry.beginStatic(id, title);
        if (error) sendJson(res, 422, { error });
        else sendJson(res, 200, { status: 'ready' });
        return;
      }
      if (parts[5] === 'files' && method === 'PUT' && parts.length > 6) {
        const body = await readBody(req, STATIC_LIMITS.maxFileBytes);
        if (body === null) {
          sendJson(res, 413, { error: 'file too large' });
          return;
        }
        let rel: string;
        try {
          rel = parts.slice(6).map(decodeURIComponent).join('/');
        } catch {
          sendJson(res, 400, { error: 'invalid path' });
          return;
        }
        const error = registry.putStaticFile(id, rel, body);
        if (error) sendJson(res, 422, { error });
        else sendJson(res, 200, { status: 'stored' });
        return;
      }
      if (parts[5] === 'publish' && method === 'POST') {
        const error = registry.publishStatic(id);
        if (error) sendJson(res, 422, { error });
        else sendJson(res, 200, { status: 'published' });
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (!app) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (parts.length === 4 && method === 'PATCH') {
      const body = await readJson(req, res, MAX_BODY);
      if (!body.ok) return;
      const patch = (body.value ?? {}) as { enabled?: unknown; statusOverride?: unknown; hostLabel?: unknown; randomHost?: unknown };
      if (patch.hostLabel !== undefined || patch.randomHost === true) {
        if (patch.hostLabel !== undefined && typeof patch.hostLabel !== 'string') return sendJson(res, 400, { error: 'hostLabel must be a string' });
        const error = registry.setHostLabel(app.id, patch.randomHost === true ? null : (patch.hostLabel as string));
        if (error) return sendJson(res, 422, { error });
      }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled must be boolean' });
        registry.setEnabled(app.id, patch.enabled);
      }
      if (patch.statusOverride !== undefined) {
        const v = patch.statusOverride;
        if (v !== null && v !== 'open' && v !== 'closed') return sendJson(res, 400, { error: 'statusOverride must be open, closed or null' });
        if (app.type !== 'survey') return sendJson(res, 400, { error: 'only surveys can be opened or closed' });
        registry.setStatusOverride(app.id, v);
      }
      sendJson(res, 200, appInfo(registry.get(app.id)!));
      return;
    }

    if (parts.length === 4 && method === 'DELETE') {
      const error = registry.remove(app.id);
      if (error) sendJson(res, 409, { error });
      else sendJson(res, 200, { status: 'removed' });
      return;
    }

    if (parts.length === 5 && parts[4] === 'purge' && method === 'POST') {
      const body = await readJson(req, res, MAX_BODY);
      if (!body.ok) return;
      if ((body.value as { confirm?: unknown })?.confirm !== app.id) {
        sendJson(res, 400, { error: 'confirmation does not match the app id' });
        return;
      }
      const removed = store.purge(app.id);
      registry.reload();
      log(`purged ${removed} response(s) of ${app.id}`);
      sendJson(res, 200, { removed });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  function serveStaticApp(req: IncomingMessage, res: ServerResponse, app: AppEntry, rest: string): void {
    securityHeaders(res, STATIC_APP_CSP);
    const root = app.staticDir!;
    const file = safeJoin(root, rest || '/');
    if (file) {
      const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file;
      if (serveFile(req, res, target, 'no-cache')) return;
    }
    // Single-page apps: unknown paths without a file extension get the app's index.html.
    if (!path.extname(rest) && serveFile(req, res, path.join(root, 'index.html'), 'no-cache')) return;
    sendText(res, 404, 'Not found');
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    securityHeaders(res);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const parts = pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (pathname === '/healthz') return sendText(res, 200, 'ok');

      const onHost = hostApp(req);
      if (onHost === 'unknown') return sendText(res, 404, 'Not found');
      if (onHost) {
        if (!onHost.enabled) return sendText(res, 404, 'Not found');
        if (onHost.type === 'static') {
          if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
          return serveStaticApp(req, res, onHost, pathname);
        }
        // Survey host: the participant app at "/", its own API, the shared app assets and themes.
        if (pathname === '/api/context') return sendJson(res, 200, { app: { id: onHost.id, type: onHost.type } }, 'no-cache');
        if (parts[0] === 'admin' || (parts[0] === 'api' && parts[2] !== onHost.id) || parts[0] === 'a' || parts[0] === 's') {
          return sendText(res, 404, 'Not found');
        }
      } else if (pathname === '/api/context') {
        return sendJson(res, 200, { app: null }, 'no-cache');
      }

      if (parts[0] === 'api' && parts[1] === 'surveys' && parts[2]) {
        const app = registry.publicSurvey(parts[2]);
        if (!app) return sendJson(res, 404, { error: 'not_found' });
        if (parts.length === 3 && (method === 'GET' || method === 'HEAD')) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify({ definition: JSON.parse(app.survey!.json), ...surveyPublic(app) }));
          return;
        }
        if (parts.length === 4 && parts[3] === 'responses' && method === 'POST') return handleSubmit(req, res, app);
        return sendJson(res, 405, { error: 'method_not_allowed' });
      }

      if (parts[0] === 'admin' && parts[1] === 'api') {
        res.setHeader('Cache-Control', 'no-store');
        return handleAdminApi(req, res, parts, method);
      }

      if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed');

      if (parts[0] === 'admin') {
        // /admin  -> dashboard (global access);  /admin/results/<id> -> results of one survey
        const resultsId = parts[1] === 'results' ? parts[2] : undefined;
        if (parts.length > 1 && !(parts[1] === 'results' && parts.length === 3)) return sendText(res, 404, 'Not found');
        if (resultsId && registry.get(resultsId)?.type !== 'survey') return sendText(res, 404, 'Not found');
        const role = await authorize(req, res, resultsId);
        if (!role) return;
        if (!resultsId && role !== 'global') return sendText(res, 403, 'Kein Zugriff auf die Verwaltung.');
        if (!serveFile(req, res, adminHtml, 'no-store')) sendText(res, 503, 'App not built');
        return;
      }

      if (parts[0] === 'a' && parts[1] && !appDomain) {
        const app = registry.publicStatic(parts[1]);
        if (!app) return sendText(res, 404, 'Not found');
        if (parts.length === 2 && !pathname.endsWith('/')) {
          res.writeHead(301, { Location: `/a/${app.id}/` });
          res.end();
          return;
        }
        return serveStaticApp(req, res, app, pathname.slice(`/a/${app.id}`.length));
      }

      if (parts[0] === 'themes' && parts.length >= 3) {
        const file = safeJoin(themesDir, parts.slice(1).join('/'));
        if (file && serveFile(req, res, file, 'no-cache')) return;
        return sendText(res, 404, 'Not found');
      }

      if (pathname === '/' || (parts[0] === 's' && parts.length === 2)) {
        if (serveFile(req, res, indexHtml, 'no-cache')) return;
        return sendText(res, 503, 'App not built');
      }
      // On a survey's own host every other page path also opens the survey (single-page app).
      if (onHost && !path.extname(pathname) && parts[0] !== 'api' && parts[0] !== 'themes') {
        if (serveFile(req, res, indexHtml, 'no-cache')) return;
      }

      if (pathname === '/admin.html') return sendText(res, 404, 'Not found');

      const file = safeJoin(distDir, pathname);
      if (file) {
        const immutable = pathname.startsWith('/assets/');
        if (serveFile(req, res, file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache')) return;
      }
      sendText(res, 404, 'Not found');
    } catch (err) {
      log(`request failed: ${(err as Error).message}`);
      if (!res.headersSent) sendText(res, 500, 'Internal error');
      else res.end();
    }
  };
}
