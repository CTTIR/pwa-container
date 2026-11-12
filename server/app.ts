import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { compactAnswers, DEFAULT_TEXT_MAX, fieldsOf, formatCode, MAX_PHOTO_BYTES, normalizeCode, PHOTO_ID_PATTERN, photoIdsOf, validateAnswers, type SurveyDefinition } from '../shared/schema.ts';
import { PhotoStore, streamZip } from './photos.ts';
import type { AdminAuth } from './auth.ts';
import { MIN_GROUP, type Store } from './db.ts';
import { STATIC_LIMITS, validAppId, type AppEntry, type AppRegistry } from './registry.ts';
import { buildDataset, codebookCsv, datasetCsv, datasetRds, parseFilter } from './data.ts';
import { buildCsv, csvField, exportKeys, fieldInfos, ratingRows, summarize, textKeys, textsByKey, textsCsv } from './report.ts';
import { collectColumns, headerFor, rowFor, withinShape } from '../shared/records.ts';

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
  /** Behind a reverse proxy that sets X-Forwarded-For (Traefik): use its last entry as the source. */
  trustProxy?: boolean;
  adminHost?: string;
  publicScheme?: string;
}

const MAX_BODY = 64 * 1024;
/** Hard upper bound of one submitted answer set (surveys with many long free texts). */
const MAX_SUBMIT_BODY = 4 * 1024 * 1024;

/**
 * Body limit for one answer set of this survey: room for every text field at its maximum length
 * (UTF-8 and JSON escaping, up to 3 bytes per character) plus the other fields.
 */
function submitLimit(def: SurveyDefinition): number {
  let bytes = 4096;
  for (const f of fieldsOf(def)) {
    bytes += 64 + f.key.length;
    if (f.item.type === 'text') bytes += 3 * (f.item.maxLength ?? DEFAULT_TEXT_MAX);
    else if (f.item.type === 'photo') bytes += 40 * (f.item.max ?? 10);
    else if (f.item.type === 'choice') bytes += f.item.options.reduce((a, o) => a + 3 * o.length + 4, 0);
  }
  return Math.min(MAX_SUBMIT_BODY, Math.max(MAX_BODY, bytes));
}

function hasPhotoFields(def: SurveyDefinition): boolean {
  return fieldsOf(def).some((f) => f.item.type === 'photo');
}
const MAX_DEFINITION = 1024 * 1024;
const MAX_RECORD = 256 * 1024;
const MAX_RECORDS_PER_APP = 50_000;
const MAX_RECORD_BYTES_PER_APP = 25 * 1024 * 1024;
/** Surveys without their own maxResponses accept at most this many responses. */
const DEFAULT_MAX_RESPONSES = 5_000;
/** Stored answers per survey are capped in total size as well. */
const MAX_SURVEY_BYTES = 20 * 1024 * 1024;
export { MIN_GROUP };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CODES_PER_REQUEST = 1000;
const COLLECTION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
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
// Without own subdomains (path mode) uploaded apps share the administration's origin; the
// sandbox gives them an opaque origin so they cannot use an administrator's credentials.
const SANDBOXED_APP_CSP = `${STATIC_APP_CSP}; sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals`;

/** Simple token bucket (not tied to client addresses). */
class Bucket {
  private tokens: number;
  private last = Date.now();
  private capacity: number;
  private perMinute: number;
  constructor(capacity: number, perMinute: number) {
    this.capacity = capacity;
    this.perMinute = perMinute;
    this.tokens = capacity;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

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
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(file);
  // An unreadable file (permissions, removed meanwhile) must not crash the server.
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

/** Time allowed for receiving a request body; slow or stalled senders are dropped. */
const BODY_DEADLINE_MS = 20_000;

/**
 * Reads a request body. Never rejects: 'too_large' (answered by the caller) or 'aborted' (the
 * client went away or was too slow; nothing can be answered).
 */
function readBody(req: IncomingMessage, limit: number, deadlineMs = BODY_DEADLINE_MS): Promise<Buffer | 'too_large' | 'aborted'> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: Buffer | 'too_large' | 'aborted') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      resolve(value);
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish('aborted');
    }, deadlineMs);
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) finish('too_large');
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) finish(Buffer.concat(chunks));
    });
    req.on('aborted', () => finish('aborted'));
    req.on('error', () => finish('aborted'));
    req.on('close', () => {
      if (!req.complete) finish('aborted');
    });
  });
}

async function readJson(req: IncomingMessage, res: ServerResponse, limit: number): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    sendJson(res, 415, { error: 'unsupported_media_type' });
    return { ok: false };
  }
  const body = await readBody(req, limit);
  if (body === 'aborted') return { ok: false };
  if (body === 'too_large') {
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

export function createApp(deps: AppDeps) {
  const { store, registry, auth, distDir, themesDir, log } = deps;
  const now = deps.now ?? (() => new Date());
  const appDomain = deps.appDomain ?? '';
  const adminHost = deps.adminHost ?? '';
  const scheme = deps.publicScheme ?? 'https';
  const photos = new PhotoStore((id) => store.appFolder(id));

  /** Client address for the admin sign-in limiter only; never stored or logged. */
  let warnedProxy = false;
  function signInSource(req: IncomingMessage): string {
    if (!deps.trustProxy && req.headers['x-forwarded-for'] && !warnedProxy) {
      warnedProxy = true;
      log('requests arrive through a proxy (X-Forwarded-For) but TRUST_PROXY is not set; sign-in limits then apply to the proxy as one client');
    }
    if (deps.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (forwarded.length) return forwarded[forwarded.length - 1];
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function requestHost(req: IncomingMessage): string {
    let host = String(req.headers.host ?? '').trim().toLowerCase();
    if (host.length > 260) return '';
    host = host.replace(/:\d+$/, '');
    while (host.endsWith('.')) host = host.slice(0, -1);
    return host;
  }

  /**
   * The app addressed by its own subdomain, null for the administration host, or 'unknown'.
   * With ADMIN_HOST set, every host that is neither the administration nor an app is unknown.
   */
  function hostApp(req: IncomingMessage): AppEntry | null | 'unknown' {
    if (!appDomain) return null;
    const host = requestHost(req);
    if (host === adminHost) return null;
    if (!host.endsWith('.' + appDomain)) return adminHost ? 'unknown' : null;
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

  /** Path segment that addresses a gated survey on its own host instead of its (telling) id. */
  const GATED_ALIAS = 'app';

  /** What anyone with the link learns about a gated survey: that it needs a code, and its state. */
  function gatedStub(app: AppEntry) {
    const def = app.survey!.def;
    return { gated: true, locale: def.locale, ...surveyPublic(app) };
  }

  function surveyPublic(app: AppEntry) {
    const def = app.survey!.def;
    return { status: registry.statusOf(app, now()), opensAt: def.opensAt ?? null, closesAt: def.closesAt ?? null };
  }

  /**
   * Gated surveys answer nothing about their questions to requests without a valid code: the code
   * is checked before anything else of the request is looked at. Resolves true when the request
   * may go on; otherwise it has been answered. Used codes pass here (the insert refuses them), so
   * this check cannot tell which slip was used either.
   */
  function gateByCode(res: ServerResponse, app: AppEntry, raw: unknown): boolean {
    if (!app.survey?.def.gated) return true;
    const code = typeof raw === 'string' && raw.length <= 32 ? normalizeCode(raw) : '';
    if (!code) {
      sendJson(res, 422, { error: 'code_required' });
      return false;
    }
    const check = store.checkCode(app.id, code);
    if (check.status === 'ok' || check.status === 'used') return true;
    if (check.status === 'closed') {
      sendJson(res, 409, { error: 'course_closed' });
      return false;
    }
    if (!unknownCodeBucket(app.id).take()) sendJson(res, 429, { error: 'too_many_attempts' });
    else sendJson(res, 422, { error: 'code_unknown' });
    return false;
  }

  async function handleSubmit(req: IncomingMessage, res: ServerResponse, app: AppEntry): Promise<void> {
    const def = app.survey!.def;
    const body = await readJson(req, res, submitLimit(def));
    if (!body.ok) return;
    const payload = (body.value ?? {}) as { submissionId?: unknown; surveyVersion?: unknown; answers?: unknown; code?: unknown; noticeConfirmed?: unknown };
    // A resend of an answer that is already stored (its reply got lost) is always a success,
    // even if the survey has been closed or changed since.
    if (typeof payload.submissionId === 'string' && SUBMISSION_ID.test(payload.submissionId) && store.isDuplicate(def.id, payload.submissionId)) {
      sendJson(res, 200, { status: 'duplicate' });
      return;
    }
    const status = registry.statusOf(app, now());
    if (status !== 'open') {
      if (status === 'closed' && def.accessCodes) store.closeAllCourses(def.id);
      sendJson(res, 409, { error: status });
      return;
    }
    if (typeof payload.submissionId !== 'string' || !SUBMISSION_ID.test(payload.submissionId)) {
      sendJson(res, 400, { error: 'invalid_submission_id' });
      return;
    }
    // Gated: no version, field or photo detail before the code is known to be valid.
    if (!gateByCode(res, app, payload.code)) return;
    // Answers given to another version of the questions must be reviewed by the participant.
    if (payload.surveyVersion !== undefined && payload.surveyVersion !== def.version) {
      sendJson(res, 409, { error: 'version_changed', version: def.version });
      return;
    }
    // A survey with a notice only takes answers whose participant confirmed it on the start page.
    if (def.notice && payload.noticeConfirmed !== true) {
      sendJson(res, 422, { error: 'notice_not_confirmed', version: def.version });
      return;
    }
    const problems = validateAnswers(def, payload.answers);
    if (Object.keys(problems).length > 0) {
      sendJson(res, 422, { error: 'invalid', fields: problems, version: def.version });
      return;
    }
    // Photos are uploaded before the answers; the device sends missing ones again.
    const missingPhotos = photoIdsOf(def, payload.answers as Record<string, never>).filter((id) => !photos.has(def.id, id));
    if (missingPhotos.length > 0) {
      sendJson(res, 409, { error: 'photo_missing', photos: missingPhotos });
      return;
    }
    // One normalized code value for every decision below and for storing.
    if (payload.code !== undefined && payload.code !== null && typeof payload.code !== 'string') {
      sendJson(res, 422, { error: 'code_unknown' });
      return;
    }
    const code = typeof payload.code === 'string' ? normalizeCode(payload.code) : '';
    // Optional-code surveys whose code-less answers are released accept none without a code.
    if (def.accessCodes === 'optional' && !code && store.uncodedReleased(def.id)) {
      sendJson(res, 422, { error: 'code_required' });
      return;
    }
    // Answers without a code are open to anyone with the link: limit the pace per survey
    // (counted only for well-formed answers, so junk cannot use up the budget).
    if ((!def.accessCodes || !code) && !submitBucket(def.id).take()) {
      sendJson(res, 429, { error: 'busy' });
      return;
    }
    const answers = compactAnswers(def, payload.answers as Record<string, never>);
    const result = store.insert(
      def.id,
      def.version,
      payload.submissionId,
      answers,
      { maxResponses: def.maxResponses ?? DEFAULT_MAX_RESPONSES, maxBytes: MAX_SURVEY_BYTES },
      def.accessCodes,
      code || undefined,
    );
    switch (result) {
      case 'stored':
        return sendJson(res, 201, { status: result });
      case 'duplicate':
        return sendJson(res, 200, { status: result });
      case 'full':
      case 'course_closed':
        return sendJson(res, 409, { error: result });
      case 'code_unknown':
      case 'code_used':
        // Same answer for used and unknown codes (see handleCodeCheck).
        if (!unknownCodeBucket(def.id).take()) return sendJson(res, 429, { error: 'too_many_attempts' });
        return sendJson(res, 422, { error: 'code_unknown' });
      default:
        return sendJson(res, 422, { error: result });
    }
  }

  /** One photo of an answer set, sent before the answers. */
  async function handlePhotoUpload(req: IncomingMessage, res: ServerResponse, app: AppEntry, photoId: string): Promise<void> {
    const def = app.survey!.def;
    // Gated: nothing (not even whether the survey takes photos) before a valid code.
    if (def.gated && !gateByCode(res, app, req.headers['x-access-code'])) {
      req.resume();
      return;
    }
    if (!hasPhotoFields(def)) return sendJson(res, 404, { error: 'no_photos' });
    if (!PHOTO_ID_PATTERN.test(photoId)) return sendJson(res, 400, { error: 'invalid_photo_id' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'image/jpeg') return sendJson(res, 415, { error: 'jpeg_required' });
    // A resend of a stored photo is a success even if the survey closed meanwhile.
    if (photos.has(def.id, photoId)) {
      req.resume();
      return sendJson(res, 200, { status: 'exists' });
    }
    const status = registry.statusOf(app, now());
    if (status !== 'open') {
      req.resume();
      return sendJson(res, 409, { error: status });
    }
    if (!photoBucket(def.id).take()) {
      req.resume();
      return sendJson(res, 429, { error: 'busy' });
    }
    const body = await readBody(req, MAX_PHOTO_BYTES, 120_000);
    if (body === 'too_large') return sendJson(res, 413, { error: 'too_large' });
    if (body === 'aborted') return;
    const r = photos.put(def.id, photoId, body);
    if (r === 'invalid') return sendJson(res, 422, { error: 'invalid_photo' });
    if (r === 'full') return sendJson(res, 409, { error: 'full' });
    return sendJson(res, r === 'stored' ? 201 : 200, { status: r });
  }

  const photoBuckets = new Map<string, Bucket>();
  function photoBucket(surveyId: string): Bucket {
    let b = photoBuckets.get(surveyId);
    if (!b) photoBuckets.set(surveyId, (b = new Bucket(300, 300)));
    return b;
  }

  /** Photos no stored answer refers to (failed or deleted submissions) are removed. */
  function sweepPhotos(def: SurveyDefinition): void {
    if (!photos.ids(def.id).length) return;
    const referenced = new Set<string>();
    for (const r of store.rawResponses(def.id)) {
      for (const v of Object.values(r.answers)) if (Array.isArray(v)) for (const x of v) if (PHOTO_ID_PATTERN.test(x)) referenced.add(x);
    }
    const n = photos.sweep(def.id, referenced);
    if (n) log(`removed ${n} unreferenced photo(s) of ${def.id}`);
  }

  const submitBuckets = new Map<string, Bucket>();
  function submitBucket(surveyId: string): Bucket {
    let b = submitBuckets.get(surveyId);
    if (!b) submitBuckets.set(surveyId, (b = new Bucket(60, 120)));
    return b;
  }
  /** Unknown or used codes per survey are limited, so codes cannot be guessed or probed. */
  const unknownCodeBuckets = new Map<string, Bucket>();
  function unknownCodeBucket(surveyId: string): Bucket {
    let b = unknownCodeBuckets.get(surveyId);
    if (!b) unknownCodeBuckets.set(surveyId, (b = new Bucket(30, 30)));
    return b;
  }
  /** All code checks per survey (a course scanning its slips at once fits easily). */
  const codeCheckBuckets = new Map<string, Bucket>();
  function codeCheckBucket(surveyId: string): Bucket {
    let b = codeCheckBuckets.get(surveyId);
    if (!b) codeCheckBuckets.set(surveyId, (b = new Bucket(60, 60)));
    return b;
  }
  /** Records per app (anyone can post to an app that collects). */
  const recordBuckets = new Map<string, Bucket>();
  function recordBucket(appId: string): Bucket {
    let b = recordBuckets.get(appId);
    if (!b) recordBuckets.set(appId, (b = new Bucket(120, 300)));
    return b;
  }

  async function handleCodeCheck(req: IncomingMessage, res: ServerResponse, app: AppEntry): Promise<void> {
    const body = await readJson(req, res, 1024);
    if (!body.ok) return;
    const code = (body.value as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || code.length > 32 || !app.survey?.def.accessCodes) return sendJson(res, 400, { error: 'invalid' });
    const status = registry.statusOf(app, now());
    if (status !== 'open') {
      if (status === 'closed') store.closeAllCourses(app.id);
      return sendJson(res, 409, { error: 'closed' });
    }
    // Every check counts, and the check never tells whether a known code was already used:
    // a used code is only refused when answers are submitted with it. So nobody can find out
    // which slip was used by checking codes.
    if (!codeCheckBucket(app.id).take()) return sendJson(res, 429, { error: 'too_many_attempts' });
    const check = store.checkCode(app.id, code);
    if (check.status === 'ok' || check.status === 'used') {
      // Gated surveys hand out their definition only here, together with a valid code.
      // `status` is this check's answer here, so the survey's state goes as `surveyStatus`.
      let unlocked = {};
      if (app.survey.def.gated) {
        const { status: surveyStatus, ...dates } = surveyPublic(app);
        unlocked = { definition: JSON.parse(app.survey.json), surveyStatus, ...dates };
      }
      return sendJson(res, 200, { status: 'ok', course: check.course, ...unlocked });
    }
    if (check.status === 'closed') return sendJson(res, 409, { error: 'course_closed' });
    if (!unknownCodeBucket(app.id).take()) return sendJson(res, 429, { error: 'too_many_attempts' });
    sendJson(res, 404, { error: 'code_unknown' });
  }

  /** Data records sent by a web app (only when collecting is switched on for that app). */
  async function handleRecordPost(req: IncomingMessage, res: ServerResponse, app: AppEntry): Promise<void> {
    if (!store.collectsRecords(app.id)) return sendJson(res, 403, { error: 'records_disabled' });
    if (!recordBucket(app.id).take()) return sendJson(res, 429, { error: 'busy' });
    const body = await readJson(req, res, MAX_RECORD);
    if (!body.ok) return;
    const value = body.value as { collection?: unknown; data?: unknown; id?: unknown } | null;
    if (value === null || typeof value !== 'object') return sendJson(res, 400, { error: 'record must be a JSON object' });
    const collection = typeof value.collection === 'string' ? value.collection : 'default';
    if (!COLLECTION.test(collection)) return sendJson(res, 400, { error: 'invalid collection name' });
    const data = 'data' in value ? value.data : value;
    if (!withinShape(data)) return sendJson(res, 400, { error: 'record is nested too deeply or has too many values' });
    const clientId = typeof value.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value.id) ? value.id : undefined;
    const result = store.addRecord(app.id, collection, JSON.stringify(data), clientId, MAX_RECORDS_PER_APP, MAX_RECORD_BYTES_PER_APP);
    if (result === 'full') return sendJson(res, 409, { error: 'full' });
    sendJson(res, result === 'duplicate' ? 200 : 201, { status: result });
  }

  /** Writes a chunk; resolves false when the client went away, so the export stops. */
  function write(res: ServerResponse, chunk: string): Promise<boolean> {
    if (res.destroyed || res.writableEnded) return Promise.resolve(false);
    if (res.write(chunk)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        res.off('drain', onDrain);
        res.off('close', onClose);
        res.off('error', onClose);
        resolve(ok);
      };
      const onDrain = () => done(true);
      const onClose = () => done(false);
      // A reader that stops reading for a minute is dropped.
      const timer = setTimeout(() => {
        res.destroy();
        done(false);
      }, 60_000);
      res.once('drain', onDrain);
      res.once('close', onClose);
      res.once('error', onClose);
    });
  }

  /**
   * Streams records as JSON or CSV. Rows are read page by page between writes, so no database
   * statement stays open while waiting for a slow or vanished client.
   */
  async function streamRecords(res: ServerResponse, appId: string, collection: string | undefined, format: 'json' | 'csv', filename: string): Promise<void> {
    res.writeHead(200, {
      'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    });
    if (format === 'json') {
      if (!(await write(res, `{"app":${JSON.stringify(appId)},"collection":${JSON.stringify(collection ?? null)},"records":[`))) return;
      let first = true;
      for (const page of store.recordPages(appId, collection)) {
        const chunk = page.map((r) => {
          const text = (first ? '\n' : ',\n') + JSON.stringify(r);
          first = false;
          return text;
        });
        if (!(await write(res, chunk.join('')))) return;
      }
      res.end('\n]}\n');
      return;
    }
    // CSV: a first pass finds the columns, a second writes the rows.
    const all = function* () {
      for (const page of store.recordPages(appId, collection)) yield* page;
    };
    const { keys, overflow } = collectColumns(all());
    if (!(await write(res, '\uFEFF' + headerFor(keys, overflow).map(csvField).join(',') + '\r\n'))) return;
    let i = 0;
    for (const page of store.recordPages(appId, collection)) {
      const lines = page.map((r) => {
        i += 1;
        return rowFor(i, r, keys, overflow).map(csvField).join(',') + '\r\n';
      });
      if (!(await write(res, lines.join('')))) return;
    }
    res.end();
  }

  function download(res: ServerResponse, filename: string, type: string, body: string | Buffer): void {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  /** Largest PDF next to survey.json (`paper.pdf`, `manual.pdf`) the admin area hands out. */
  const MAX_SURVEY_PDF_BYTES = 20 * 1024 * 1024;

  /**
   * PDFs a survey folder may ship next to survey.json, with the name of the download:
   * the printable questionnaire and the manual for the survey's administration.
   */
  const SURVEY_PDFS = {
    'paper.pdf': 'fragebogen_papier',
    'manual.pdf': 'anleitung_verwaltung',
  } as const;
  type SurveyPdf = keyof typeof SURVEY_PDFS;
  const isSurveyPdf = (name: string | undefined): name is SurveyPdf =>
    name !== undefined && Object.hasOwn(SURVEY_PDFS, name);

  /** Path of one of the survey's PDFs, or null when it has none. */
  function surveyPdfFile(app: AppEntry, name: SurveyPdf): string | null {
    if (!app.survey) return null;
    const file = path.join(app.survey.dir, name);
    try {
      const st = fs.statSync(file);
      return st.isFile() && st.size > 0 && st.size <= MAX_SURVEY_PDF_BYTES ? file : null;
    } catch {
      return null;
    }
  }

  /** Basic authentication for /admin. Resolves to the granted role, or null after answering. */
  async function authorize(req: IncomingMessage, res: ServerResponse, surveyId?: string): Promise<'global' | 'survey' | null> {
    const role = await auth.authenticate(req.headers.authorization, surveyId, signInSource(req));
    if (role === 'global' || role === 'survey') return role;
    if (role === 'blocked') {
      sendText(res, 429, 'Zu viele fehlgeschlagene Anmeldeversuche von dieser Verbindung. Bitte später erneut versuchen.');
      return null;
    }
    if (role === 'busy') {
      sendText(res, 429, 'Zu viele gleichzeitige Anmeldeversuche. Bitte gleich noch einmal versuchen.');
      return null;
    }
    if (role === 'other') {
      sendText(res, 403, 'Diese Zugangsdaten gelten nicht für diese Seite.');
      return null;
    }
    // Failed attempts were already paused inside auth.authenticate.
    res.writeHead(401, {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('Authentication required');
    return null;
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

  /** Exact counts only for closed groups; open groups only as "below / at least MIN_GROUP". */
  function responseCounts(app: AppEntry, def: SurveyDefinition): { responses: number | null; responsesBand: 'belowMin' | 'atLeastMin' | null } {
    const total = store.count(app.id);
    if (def.accessCodes) {
      const releasedCount = store
        .listCourses(app.id)
        .filter((c) => c.released)
        .reduce((n, c) => n + c.responses, 0);
      const rest = total - releasedCount;
      return { responses: releasedCount, responsesBand: rest === 0 ? null : rest >= MIN_GROUP ? 'atLeastMin' : 'belowMin' };
    }
    if (registry.statusOf(app, now()) === 'closed') return { responses: total, responsesBand: null };
    return { responses: null, responsesBand: total >= MIN_GROUP ? 'atLeastMin' : 'belowMin' };
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
      collectRecords: store.collectsRecords(app.id),
      records: store.recordCount(app.id),
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
      ...responseCounts(app, def),
      subtitle: def.subtitle ?? null,
      accessCodes: def.accessCodes ?? null,
      courses: def.accessCodes ? store.listCourses(app.id).length : 0,
    };
  }

  /**
   * Which results may be shown: closed groups with at least MIN_GROUP responses. Release is
   * recorded permanently. While a group is open, its counts are only shown as "below / at least
   * MIN_GROUP", so nobody can watch single answers arrive.
   */
  function releaseView(app: AppEntry, def: SurveyDefinition) {
    if (def.accessCodes) {
      const courses = store.listCourses(def.id).map((c) => {
        let released = c.released;
        if (!released && c.closed && c.responses >= MIN_GROUP) {
          store.setCourseClosed(def.id, c.id, true);
          released = true;
        }
        const band = c.responses >= MIN_GROUP ? 'atLeastMin' : 'belowMin';
        // Exact numbers only for released groups; otherwise closing and reopening could be
        // used to count single submissions.
        return {
          ...c,
          released,
          responses: released ? c.responses : null,
          used: released ? c.used : null,
          responsesBand: released ? null : band,
        };
      });
      const releasedCourseIds = courses.filter((c) => c.released).map((c) => c.id);
      const closed = registry.statusOf(app, now()) === 'closed';
      let uncodedReleased = def.accessCodes === 'optional' && store.uncodedReleased(def.id);
      if (!uncodedReleased && def.accessCodes === 'optional' && closed && store.uncodedCount(def.id) >= MIN_GROUP) {
        store.setUncodedReleased(def.id); // permanent: no further answers without a code
        uncodedReleased = true;
      }
      return { courses, releasedCourseIds, uncodedReleased, released: releasedCourseIds.length > 0 || uncodedReleased };
    }
    const closed = registry.statusOf(app, now()) === 'closed';
    let released = store.appReleased(def.id);
    if (!released && closed && store.count(def.id) >= MIN_GROUP) {
      store.setAppReleased(def.id);
      registry.setStatusOverride(def.id, 'closed');
      released = true;
    }
    return { courses: [], releasedCourseIds: [] as string[], uncodedReleased: false, released };
  }

  /** A survey without codes whose results are released may never accept answers again. */
  function releasedForGood(app: AppEntry, def: SurveyDefinition): boolean {
    if (def.accessCodes) return false;
    return releaseView(app, def).released;
  }

  /** A calendar date that exists (2026-02-31 does not). */
  function realDate(v: string): boolean {
    if (!DATE.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }

  function courseProblem(v: { label?: unknown; eventDate?: unknown; eventDateEnd?: unknown }, creating: boolean): string | null {
    if (creating || v.label !== undefined) {
      if (typeof v.label !== 'string' || !v.label.trim() || v.label.length > 200) return 'event name required (max. 200 characters)';
    }
    if (creating || v.eventDate !== undefined) {
      if (typeof v.eventDate !== 'string' || !realDate(v.eventDate)) return 'event date required (YYYY-MM-DD)';
    }
    if (v.eventDateEnd !== undefined && v.eventDateEnd !== null && v.eventDateEnd !== '') {
      if (typeof v.eventDateEnd !== 'string' || !realDate(v.eventDateEnd)) return 'end date must be YYYY-MM-DD';
      if (typeof v.eventDate === 'string' && v.eventDateEnd < v.eventDate) return 'end date before start date';
    }
    return null;
  }

  /** Formats of the data endpoint; anything else is refused before any data is read. */
  const DATA_FORMATS = new Set(['json', 'json-file', 'csv', 'codebook.csv', 'rds']);

  const PASSWORD_ERRORS: Record<string, [number, string]> = {
    wrong_current: [403, 'Das bisherige Passwort stimmt nicht.'],
    mismatch: [422, 'Die beiden neuen Passwörter stimmen nicht überein.'],
    too_short: [422, 'Das neue Passwort braucht mindestens 16 Zeichen.'],
    too_long: [422, 'Das neue Passwort darf höchstens 256 Zeichen haben.'],
    same: [422, 'Das neue Passwort muss sich vom bisherigen unterscheiden.'],
    busy: [429, 'Gerade viele Anmeldeprüfungen – bitte gleich noch einmal versuchen.'],
    not_found: [403, 'Für diese Anmeldung kann das Passwort hier nicht geändert werden.'],
    unavailable: [503, 'Passwortänderung ist auf diesem Server nicht eingerichtet.'],
  };

  async function handlePasswordChange(req: IncomingMessage, res: ServerResponse, method: string, scope: string): Promise<void> {
    if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!sameOriginWrite(req, res)) return;
    const b = await readJson(req, res, 4096);
    if (!b.ok) return;
    const v = (b.value ?? {}) as { current?: unknown; next?: unknown; repeat?: unknown };
    if (typeof v.current !== 'string' || typeof v.next !== 'string' || typeof v.repeat !== 'string') {
      return sendJson(res, 400, { error: 'current, next and repeat are required' });
    }
    const result = await auth.changeOwnPassword(req.headers.authorization, scope, v.current, v.next, v.repeat);
    if (result === 'changed') {
      log(`administrator password changed (${scope === 'global' ? 'global' : 'survey ' + scope})`);
      return sendJson(res, 200, { status: 'changed' });
    }
    const [status, message] = PASSWORD_ERRORS[result];
    return sendJson(res, status, { error: result, message });
  }

  async function handleAdminApi(req: IncomingMessage, res: ServerResponse, parts: string[], method: string): Promise<void> {
    // parts: ['admin', 'api', ...]
    const area = parts[2];

    if (area === 'results') {
      const id = parts[3];
      if (!id || !validAppId(id)) return sendText(res, 404, 'Not found');
      // Authenticate before revealing whether the survey exists.
      const role = await authorize(req, res, id);
      if (!role) return;
      const app = registry.get(id);
      if (!app || app.type !== 'survey' || !app.survey) return sendText(res, 404, 'Not found');
      const def = app.survey.def;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const courseParam = url.searchParams.get('course') || undefined;
      if (courseParam && !store.courseExists(def.id, courseParam)) return sendJson(res, 404, { error: 'unknown course' });

      if (parts[4] === 'password' && parts.length === 5) {
        // Own password of the signed-in administrator (survey sign-in: the entry of this survey).
        return await handlePasswordChange(req, res, method, role === 'global' ? 'global' : def.id);
      }

      if (isSurveyPdf(parts[4]) && parts.length === 5) {
        // Printable questionnaire for pen-and-paper participation, or the manual for this
        // administration page, shipped next to survey.json.
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
        const name = parts[4];
        const file = surveyPdfFile(app, name);
        if (!file) return sendText(res, 404, 'Not found');
        let pdf: Buffer;
        try {
          pdf = fs.readFileSync(file);
        } catch {
          return sendText(res, 404, 'Not found');
        }
        if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') return sendText(res, 404, 'Not found');
        return download(res, `${def.id}_${SURVEY_PDFS[name]}.pdf`, 'application/pdf', pdf);
      }

      if (parts[4] === 'photos' && (parts.length === 5 || parts.length === 6)) {
        // Photos of this survey's answers: one photo by id, or all as a ZIP archive.
        if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
        if (parts.length === 6) {
          const id = parts[5].replace(/\.jpg$/, '');
          if (!PHOTO_ID_PATTERN.test(id)) return sendText(res, 404, 'Not found');
          const data = photos.read(def.id, id);
          if (!data) return sendText(res, 404, 'Not found');
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': data.length,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `inline; filename="${id}.jpg"`,
          });
          res.end(data);
          return;
        }
        // Named <field>_<photo id>.jpg: the photo id is the value in the data export.
        const entries: { name: string; load: () => Buffer | null }[] = [];
        const keys = new Set(fieldsOf(def).filter((f) => f.item.type === 'photo').map((f) => f.key));
        for (const r of store.rawResponses(def.id)) {
          for (const [key, v] of Object.entries(r.answers)) {
            if (!keys.has(key) || !Array.isArray(v)) continue;
            for (const id of v) if (PHOTO_ID_PATTERN.test(id)) entries.push({ name: `${key}_${id}.jpg`, load: () => photos.read(def.id, id) });
          }
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        log(`photo export of ${def.id} by the ${role} administration`);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Cache-Control': 'private, no-store',
          'Content-Disposition': `attachment; filename="${def.id}_fotos.zip"`,
        });
        await streamZip(res, entries);
        return;
      }

      if (parts[4] === 'data' && parts.length === 5) {
        // Full data of this one survey (its own database only): single responses with free
        // texts, version and course; filtered by course, version and field; JSON, CSV or RDS.
        if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
        const format = url.searchParams.get('format') ?? 'json';
        if (!DATA_FORMATS.has(format)) return sendJson(res, 400, { error: 'format must be json, json-file, csv, codebook.csv or rds' });
        const filter = parseFilter(url.searchParams);
        if (typeof filter === 'string') return sendJson(res, 400, { error: filter });
        const known = new Set(store.courseLabels(def.id).map((c) => c.id));
        if (filter.courses?.some((c) => c !== null && !known.has(c))) return sendJson(res, 404, { error: 'unknown course' });
        // Built synchronously: concurrent requests are handled one after another.
        const raw = store.rawResponses(def.id, { courses: filter.courses, versions: filter.versions });
        const data = buildDataset(def, raw, filter);
        const subset = filter.courses || filter.versions || filter.fields ? '_teilmenge' : '';
        const sep = url.searchParams.get('sep') === 'comma' ? ',' : ';';
        // No counts in the log: timestamped counts would tell when answers came in.
        if (format !== 'json') log(`data export of ${def.id} by the ${role} administration`);
        switch (format) {
          case 'json':
            return sendJson(res, 200, {
              ...data,
              courses: store.courseLabels(def.id),
              versions: store.versionsOf(def.id),
              role,
            });
          case 'json-file':
            return download(res, `${def.id}_daten${subset}.json`, 'application/json; charset=utf-8', JSON.stringify(data));
          case 'csv':
            return download(res, `${def.id}_daten${subset}.csv`, 'text/csv; charset=utf-8', datasetCsv(data, sep));
          case 'codebook.csv':
            return download(res, `${def.id}_codebuch.csv`, 'text/csv; charset=utf-8', codebookCsv(data, sep));
          default:
            return download(res, `${def.id}_daten${subset}.rds`, 'application/octet-stream', datasetRds(data));
        }
      }

      if (parts[4] === 'status' && parts.length === 5) {
        // Close or reopen the whole survey. Closing also closes every course: all codes expire.
        if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        if (!sameOriginWrite(req, res)) return;
        // Surveys with courses are closed course by course; closing the whole app (every course
        // at once) is left to the global administration.
        if (def.accessCodes && role !== 'global') return sendJson(res, 403, { error: 'close_per_course' });
        const b = await readJson(req, res, MAX_BODY);
        if (!b.ok) return;
        const closed = (b.value as { closed?: unknown } | null)?.closed;
        if (typeof closed !== 'boolean') return sendJson(res, 400, { error: 'closed must be boolean' });
        if (!closed && releasedForGood(app, def)) return sendJson(res, 409, { error: 'released_cannot_reopen' });
        registry.setStatusOverride(def.id, closed ? 'closed' : 'open');
        const coursesClosed = closed ? store.closeAllCourses(def.id) : 0;
        if (closed) releaseView(app, def); // records a release that this closing completes
        log(`survey ${def.id} ${closed ? 'closed' : 'reopened'}`);
        return sendJson(res, 200, { status: registry.statusOf(registry.get(def.id)!, now()), coursesClosed });
      }

      if (parts[4] === 'courses') {
        // Courses and their single-use access codes (also for the survey's own credentials).
        if (method === 'GET' && parts.length === 5) return sendJson(res, 200, { courses: releaseView(app, def).courses });
        if (method !== 'GET' && !sameOriginWrite(req, res)) return;
        if (method === 'POST' && parts.length === 5) {
          const b = await readJson(req, res, MAX_BODY);
          if (!b.ok) return;
          const v = (b.value ?? {}) as { label?: unknown; eventDate?: unknown; eventDateEnd?: unknown; count?: unknown };
          const problem = courseProblem(v, true);
          if (problem) return sendJson(res, 400, { error: problem });
          if (!Number.isInteger(v.count) || (v.count as number) < 1 || (v.count as number) > MAX_CODES_PER_REQUEST) {
            return sendJson(res, 400, { error: `count must be 1–${MAX_CODES_PER_REQUEST}` });
          }
          const label = (v.label as string).trim();
          if (store.courseLabelTaken(def.id, label)) return sendJson(res, 409, { error: 'a course with this name already exists' });
          const eventDateEnd = typeof v.eventDateEnd === 'string' && v.eventDateEnd ? v.eventDateEnd : null;
          const courseId = store.createCourse(def.id, label, v.eventDate as string, eventDateEnd);
          const codes = store.addCodes(def.id, courseId, v.count as number).map(formatCode);
          return sendJson(res, 201, { course: { id: courseId, label, eventDate: v.eventDate, eventDateEnd }, codes });
        }
        const courseId = parts[5];
        if (!courseId || !store.courseExists(def.id, courseId)) return sendJson(res, 404, { error: 'unknown course' });
        const current = store.listCourses(def.id).find((c) => c.id === courseId)!;
        if (method === 'POST' && parts[6] === 'codes' && parts.length === 7) {
          const b = await readJson(req, res, MAX_BODY);
          if (!b.ok) return;
          const count = (b.value as { count?: unknown } | null)?.count;
          if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_CODES_PER_REQUEST) {
            return sendJson(res, 400, { error: `count must be 1–${MAX_CODES_PER_REQUEST}` });
          }
          const codes = store.addCodes(def.id, courseId, count as number).map(formatCode);
          return sendJson(res, 201, {
            course: { id: courseId, label: current.label, eventDate: current.eventDate, eventDateEnd: current.eventDateEnd },
            codes,
          });
        }
        if (method === 'GET' && parts[6] === 'codes' && parts.length === 7) {
          return sendJson(res, 200, { codes: store.listCodes(def.id, courseId).map((c) => ({ ...c, code: formatCode(c.code) })) });
        }
        if (method === 'PATCH' && parts.length === 6) {
          const b = await readJson(req, res, MAX_BODY);
          if (!b.ok) return;
          const v = (b.value ?? {}) as { label?: unknown; eventDate?: unknown; eventDateEnd?: unknown; closed?: unknown };
          // Read the course again after the body arrived: its state may have changed meanwhile.
          const fresh = store.listCourses(def.id).find((c) => c.id === courseId);
          if (!fresh) return sendJson(res, 404, { error: 'unknown course' });
          const problem = courseProblem({ eventDate: fresh.eventDate, ...v, label: v.label ?? fresh.label }, false);
          if (problem) return sendJson(res, 400, { error: problem });
          if (v.closed !== undefined && typeof v.closed !== 'boolean') return sendJson(res, 400, { error: 'closed must be boolean' });
          if (typeof v.label === 'string' && store.courseLabelTaken(def.id, v.label.trim(), courseId)) {
            return sendJson(res, 409, { error: 'a course with this name already exists' });
          }
          // Release is one-way: reopening a released course would let organisers isolate single
          // new answers by comparing results before and after.
          if (v.closed === false && (fresh.released || (fresh.closed && fresh.responses >= MIN_GROUP))) {
            return sendJson(res, 409, { error: 'released_cannot_reopen' });
          }
          store.updateCourse(def.id, courseId, {
            label: typeof v.label === 'string' ? v.label.trim() : undefined,
            eventDate: typeof v.eventDate === 'string' ? v.eventDate : undefined,
            eventDateEnd: v.eventDateEnd === undefined ? undefined : typeof v.eventDateEnd === 'string' && v.eventDateEnd ? v.eventDateEnd : null,
          });
          if (typeof v.closed === 'boolean' && store.setCourseClosed(def.id, courseId, v.closed) === 'released') {
            return sendJson(res, 409, { error: 'released_cannot_reopen' });
          }
          return sendJson(res, 200, { course: releaseView(app, def).courses.find((c) => c.id === courseId) });
        }
        if (method === 'POST' && parts[6] === 'revoke' && parts.length === 7) {
          const b = await readJson(req, res, MAX_BODY);
          if (!b.ok) return;
          const { codes, revoked } = (b.value ?? {}) as { codes?: unknown; revoked?: unknown };
          if (!Array.isArray(codes) || !codes.every((c) => typeof c === 'string') || typeof revoked !== 'boolean' || codes.length > MAX_CODES_PER_REQUEST) {
            return sendJson(res, 400, { error: 'codes (list) and revoked (boolean) required' });
          }
          return sendJson(res, 200, { changed: store.setCodesRevoked(def.id, courseId, codes as string[], revoked) });
        }
        if (method === 'DELETE' && parts.length === 6) {
          const withResponses = url.searchParams.get('withResponses') === '1';
          // The survey's own administration may delete small courses with their answers (test runs,
          // wrongly created courses). Released courses and courses with MIN_GROUP or more answers
          // are left to the global administration, so real evaluations cannot be removed by those
          // they evaluate.
          if (withResponses && role !== 'global') {
            const fresh = store.listCourses(def.id).find((c) => c.id === courseId);
            if (fresh && (fresh.released || fresh.responses >= MIN_GROUP)) {
              return sendJson(res, 403, { error: 'only the global administration can delete released courses or courses with 5 or more answers' });
            }
          }
          if (withResponses && url.searchParams.get('confirm') !== current.label) {
            return sendJson(res, 400, { error: 'confirmation does not match the course name' });
          }
          const r = store.deleteCourse(def.id, courseId, withResponses);
          if (r === 'removed' && withResponses) sweepPhotos(def);
          if (r === 'removed') log(`course of ${def.id} deleted${withResponses ? ' with its responses' : ''}`);
          return r === 'removed' ? sendJson(res, 200, { status: r }) : sendJson(res, 409, { error: 'the course still has responses' });
        }
        return sendJson(res, 405, { error: 'method_not_allowed' });
      }

      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
      const view = releaseView(app, def);
      let rows: ReturnType<typeof store.list> = [];
      let released: boolean;
      if (courseParam) {
        released = view.courses.find((c) => c.id === courseParam)?.released ?? false;
        if (released) rows = store.list(def.id, [courseParam]);
      } else {
        released = view.released;
        if (released) rows = def.accessCodes ? store.list(def.id, view.releasedCourseIds, view.uncodedReleased) : store.list(def.id);
      }
      const suffix = courseParam ? `_${courseParam}` : '';
      switch (parts[4]) {
        case 'summary':
          sendJson(res, 200, {
            survey: { ...appInfo(app), title: def.title, subtitle: def.subtitle ?? null },
            definition: def,
            minGroup: MIN_GROUP,
            role,
            released,
            responses: rows.length,
            course: courseParam ?? null,
            courses: view.courses,
            paperPdf: surveyPdfFile(app, 'paper.pdf') !== null,
            manualPdf: surveyPdfFile(app, 'manual.pdf') !== null,
            fields: fieldInfos(def),
            summary: summarize(def, rows),
          });
          return;
        case 'responses':
          sendJson(res, 200, {
            survey: { id: def.id, version: def.version, title: def.title },
            keys: exportKeys(def),
            textKeys: textKeys(def),
            fields: fieldInfos(def),
            rows: ratingRows(def, rows),
            texts: textsByKey(def, rows),
          });
          return;
        case 'export.csv':
          download(res, `${def.id}${suffix}_ratings.csv`, 'text/csv; charset=utf-8', buildCsv(def, rows));
          return;
        case 'texts.csv':
          download(res, `${def.id}${suffix}_texts.csv`, 'text/csv; charset=utf-8', textsCsv(def, rows));
          return;
        default:
          sendText(res, 404, 'Not found');
      }
      return;
    }

    if (area === 'records') {
      // Data records of any app: overview, downloads, deletion (global or the app's credentials).
      const id = parts[3];
      if (!id || !validAppId(id)) return sendText(res, 404, 'Not found');
      if (!(await authorize(req, res, id))) return;
      const app = registry.get(id);
      if (!app) return sendText(res, 404, 'Not found');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const collection = url.searchParams.get('collection') || undefined;
      if (collection && !COLLECTION.test(collection)) return sendJson(res, 400, { error: 'invalid collection name' });
      const suffix = collection ? `_${collection}` : '';
      if (method === 'GET' && parts.length === 4) {
        return sendJson(res, 200, {
          app: appInfo(app),
          collecting: store.collectsRecords(app.id),
          total: store.recordCount(app.id),
          collections: store.recordCollections(app.id),
          // Rounded up to whole megabytes: exact sizes would let one tell records apart as they arrive.
          megabytes: Math.ceil(store.recordBytes(app.id) / (1024 * 1024)),
          limits: { maxRecordBytes: MAX_RECORD, maxRecords: MAX_RECORDS_PER_APP, maxTotalBytes: MAX_RECORD_BYTES_PER_APP },
        });
      }
      if (method === 'GET' && (parts[4] === 'records.json' || parts[4] === 'records')) {
        return streamRecords(res, app.id, collection, 'json', `${app.id}${suffix}_records.json`);
      }
      if (method === 'GET' && parts[4] === 'records.csv') {
        return streamRecords(res, app.id, collection, 'csv', `${app.id}${suffix}_records.csv`);
      }
      if (method === 'PATCH' && parts.length === 4) {
        if (!sameOriginWrite(req, res)) return;
        const b = await readJson(req, res, MAX_BODY);
        if (!b.ok) return;
        const collecting = (b.value as { collecting?: unknown } | null)?.collecting;
        if (typeof collecting !== 'boolean') return sendJson(res, 400, { error: 'collecting must be boolean' });
        store.setCollectRecords(app.id, collecting);
        return sendJson(res, 200, { collecting });
      }
      if (method === 'DELETE' && parts.length === 4) {
        if (!sameOriginWrite(req, res)) return;
        const confirm = url.searchParams.get('confirm');
        if (confirm !== app.id) return sendJson(res, 400, { error: 'confirmation does not match the app id' });
        return sendJson(res, 200, { removed: store.purgeRecords(app.id, collection) });
      }
      return sendJson(res, 405, { error: 'method_not_allowed' });
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

    if (area === 'password' && parts.length === 3) return await handlePasswordChange(req, res, method, 'global');

    if (area === 'databases' && parts.length === 3 && method === 'GET') {
      // Metadata of every app's own database (global administration only).
      sendJson(res, 200, {
        databases: registry.list().map((app) => ({ app: appInfo(app), ...store.databaseInfo(app.id) })),
      });
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
        const body = await readBody(req, STATIC_LIMITS.maxFileBytes, 120_000);
        if (body === 'aborted') return;
        if (body === 'too_large') {
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
      const patch = (body.value ?? {}) as {
        enabled?: unknown;
        statusOverride?: unknown;
        hostLabel?: unknown;
        randomHost?: unknown;
        collectRecords?: unknown;
      };
      if (patch.collectRecords !== undefined) {
        if (typeof patch.collectRecords !== 'boolean') return sendJson(res, 400, { error: 'collectRecords must be boolean' });
        store.setCollectRecords(app.id, patch.collectRecords);
      }
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
        if (v !== 'closed' && app.survey && releasedForGood(app, app.survey.def)) return sendJson(res, 409, { error: 'released_cannot_reopen' });
        registry.setStatusOverride(app.id, v);
        if (v === 'closed' && app.survey) {
          store.closeAllCourses(app.id);
          releaseView(registry.get(app.id)!, app.survey.def);
        }
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
      photos.removeAll(app.id);
      registry.reload();
      log(`purged ${removed} response(s) of ${app.id}`);
      sendJson(res, 200, { removed });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  function serveStaticApp(req: IncomingMessage, res: ServerResponse, app: AppEntry, rest: string): void {
    securityHeaders(res, appDomain ? STATIC_APP_CSP : SANDBOXED_APP_CSP);
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
          if (pathname === '/api/records') {
            if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
            return await handleRecordPost(req, res, onHost);
          }
          if (pathname === '/_pwa/records.js') {
            securityHeaders(res, STATIC_APP_CSP);
            if (serveFile(req, res, path.join(distDir, '_pwa', 'records.js'), 'no-cache')) return;
            return sendText(res, 404, 'Not found');
          }
          if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
          return await serveStaticApp(req, res, onHost, pathname);
        }
        // Survey host: the participant app at "/", its own API, the shared app assets and themes.
        if (pathname === '/api/context') {
          const id = onHost.survey?.def.gated ? GATED_ALIAS : onHost.id;
          return sendJson(res, 200, { app: { id, type: onHost.type } }, 'no-cache');
        }
        // Second entry for organisers: /admin on the survey's own host shows its results and courses.
        if (parts[0] === 'admin') {
          if (parts[1] === 'api' && parts[2] === 'results' && parts[3] === onHost.id) {
            res.setHeader('Cache-Control', 'no-store');
            return await handleAdminApi(req, res, parts, method);
          }
          if (pathname !== '/admin' && pathname !== '/admin/') return sendText(res, 404, 'Not found');
          if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
          if (!(await authorize(req, res, onHost.id))) return;
          if (!serveFile(req, res, adminHtml, 'no-store')) sendText(res, 503, 'App not built');
          return;
        }
        const gatedHost = !!onHost.survey?.def.gated;
        if (parts[0] === 'api' && gatedHost && parts[1] === 'surveys' && parts[2] === GATED_ALIAS) parts[2] = onHost.id;
        if ((parts[0] === 'api' && parts[2] !== onHost.id) || parts[0] === 'a' || parts[0] === 's') {
          return sendText(res, 404, 'Not found');
        }
      } else if (pathname === '/api/context') {
        return sendJson(res, 200, { app: null }, 'no-cache');
      }

      if (parts[0] === 'api' && parts[1] === 'surveys' && parts[2]) {
        const app = registry.publicSurvey(parts[2]);
        if (!app) return sendJson(res, 404, { error: 'not_found' });
        if (parts.length === 3 && (method === 'GET' || method === 'HEAD')) {
          if (app.survey!.def.gated) return sendJson(res, 200, gatedStub(app), 'no-cache');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify({ definition: JSON.parse(app.survey!.json), ...surveyPublic(app) }));
          return;
        }
        if (parts.length === 4 && parts[3] === 'responses' && method === 'POST') return await handleSubmit(req, res, app);
        if (parts.length === 5 && parts[3] === 'photos' && method === 'PUT') return await handlePhotoUpload(req, res, app, parts[4]);
        if (parts.length === 4 && parts[3] === 'code' && method === 'POST') return await handleCodeCheck(req, res, app);
        return sendJson(res, 405, { error: 'method_not_allowed' });
      }

      if (!appDomain && parts[0] === 'api' && parts[1] === 'apps' && parts[2] && parts[3] === 'records' && parts.length === 4) {
        const app = registry.publicStatic(parts[2]);
        if (!app) return sendJson(res, 404, { error: 'not_found' });
        if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        return await handleRecordPost(req, res, app);
      }

      if (parts[0] === 'admin' && parts[1] === 'api') {
        res.setHeader('Cache-Control', 'no-store');
        return await handleAdminApi(req, res, parts, method);
      }

      if (method !== 'GET' && method !== 'HEAD') return sendText(res, 405, 'Method not allowed');

      if (parts[0] === 'admin') {
        // /admin -> dashboard (global access); /admin/results/<id> -> survey results;
        // /admin/records/<id> -> data records of an app
        const page = parts[1];
        const resultsId = page === 'results' || page === 'records' ? parts[2] : undefined;
        if (parts.length > 1 && !(resultsId && parts.length === 3)) return sendText(res, 404, 'Not found');
        if (resultsId && !validAppId(resultsId)) return sendText(res, 404, 'Not found');
        // Sign-in first, so the existence of an app is not revealed to strangers.
        const role = await authorize(req, res, resultsId);
        if (!role) return;
        if (page === 'results' && registry.get(resultsId!)?.type !== 'survey') return sendText(res, 404, 'Not found');
        if (page === 'records' && !registry.get(resultsId!)) return sendText(res, 404, 'Not found');
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

      const file = safeJoin(distDir, pathname);
      // The admin page is only ever served after authentication (also not via encoded paths).
      if (file === adminHtml || (file && path.resolve(file) === path.resolve(adminHtml))) return sendText(res, 404, 'Not found');
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
