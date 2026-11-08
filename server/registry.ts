import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { HOST_LABEL_PATTERN, SURVEY_ID_PATTERN, fieldsOf, surveyStatus, validateDefinition, type SurveyDefinition, type SurveyStatus } from '../shared/schema.ts';
import type { AppRow, Store } from './db.ts';

export type AppType = 'survey' | 'static';
export type AppSource = 'provisioned' | 'uploaded';

export interface LoadedSurvey {
  def: SurveyDefinition;
  /** Serialized public definition, sent unchanged to browsers. */
  json: string;
  /** Folder of survey.json; may also hold the printable questionnaire `paper.pdf`. */
  dir: string;
}

export interface AppEntry {
  id: string;
  type: AppType;
  source: AppSource;
  title: string;
  enabled: boolean;
  statusOverride: 'open' | 'closed' | null;
  installedOn: string;
  /** Subdomain label: the app is served at `<hostLabel>.<APP_DOMAIN>`. */
  hostLabel: string;
  survey?: LoadedSurvey;
  /** Folder with the published files of a static app. */
  staticDir?: string;
}

/** Ids that would collide with fixed routes or be confusing. */
const RESERVED = new Set(['api', 'admin', 'apps', 'results', 'themes', 'assets', 'icons', 'static', 'healthz']);

export function validAppId(id: string): boolean {
  return SURVEY_ID_PATTERN.test(id) && !RESERVED.has(id);
}

const STATIC_PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._@+-]{0,127}$/;
export const STATIC_LIMITS = { maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 150 * 1024 * 1024, maxFiles: 3000 };

const LABEL_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * Random subdomain label such as "k7m2q9xw" (starts with a letter). Not a secret: certificates
 * for every label appear in public certificate-transparency logs.
 */
export function randomLabel(length = 8): string {
  let out = LABEL_ALPHABET[randomInt(0, 23)];
  while (out.length < length) out += LABEL_ALPHABET[randomInt(0, LABEL_ALPHABET.length)];
  return out;
}

export interface RegistryOptions {
  /** Labels that must never be given to an app (existing services, www, mail …). */
  reservedLabels?: string[];
  /** Called after any change that affects the set of apps or their host names. */
  onChange?: (apps: AppEntry[]) => void;
}

function fieldTypes(def: SurveyDefinition): Record<string, string> {
  return Object.fromEntries(fieldsOf(def).map((f) => [f.key, f.item.type]));
}

function hashJson(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

function today(): string {
  return new Date().toLocaleDateString('sv-SE');
}

function readSurveyFile(file: string): { def?: SurveyDefinition; json?: string; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: `survey.json is not valid JSON (${(err as Error).message})` };
  }
  const errors = validateDefinition(raw);
  if (errors.length) return { error: errors.join('; ') };
  const def = raw as SurveyDefinition;
  return { def, json: JSON.stringify(def) };
}

/**
 * All apps the container serves:
 * - provisioned surveys: read-only folders `<surveysDir>/<id>/survey.json` (from a deployment repo),
 * - uploaded apps in `<dataDir>/apps/<id>/`: surveys (`survey.json`) or static web apps (`live/`).
 * Enabled flag, manual open/close override and install date live in the database.
 */
export class AppRegistry {
  private apps = new Map<string, AppEntry>();
  private store: Store;
  private surveysDir: string;
  private appsDir: string;
  private log: (msg: string) => void;
  private reserved: Set<string>;
  private previous = new Map<string, AppEntry>();
  private onChange?: (apps: AppEntry[]) => void;
  /** Problems found while loading, shown on the admin dashboard. */
  problems: string[] = [];

  constructor(store: Store, surveysDir: string, dataDir: string, log: (msg: string) => void, options: RegistryOptions = {}) {
    this.store = store;
    this.surveysDir = surveysDir;
    this.appsDir = path.join(dataDir, 'apps');
    this.log = log;
    this.reserved = new Set(['www', 'mail', 'admin', 'api', ...(options.reservedLabels ?? [])]);
    this.onChange = options.onChange;
    if (dataDir !== ':memory:') fs.mkdirSync(this.appsDir, { recursive: true });
    this.reload();
  }

  private note(msg: string) {
    this.problems.push(msg);
    this.log(msg);
  }

  reload(): void {
    // Keep the previous entries: a survey whose file became invalid keeps being served with
    // its last good definition (and its route) instead of disappearing mid-course.
    this.previous = new Map(this.apps);
    this.apps.clear();
    this.problems = [];
    // Provisioned surveys first; they win over uploads with the same id.
    for (const name of this.listDirs(this.surveysDir)) {
      const file = path.join(this.surveysDir, name, 'survey.json');
      if (!fs.existsSync(file)) continue;
      this.addSurvey(name, file, 'provisioned');
    }
    for (const name of this.listDirs(this.appsDir)) {
      if (this.apps.has(name)) {
        this.note(`uploaded app ${name} is hidden by a provisioned survey with the same id`);
        continue;
      }
      const dir = path.join(this.appsDir, name);
      if (fs.existsSync(path.join(dir, 'survey.json'))) {
        this.addSurvey(name, path.join(dir, 'survey.json'), 'uploaded');
      } else if (fs.existsSync(path.join(dir, 'live', 'index.html'))) {
        const row = this.store.getApp(name);
        this.apps.set(name, this.entry(name, 'static', 'uploaded', row?.title ?? name, row, { staticDir: path.join(dir, 'live') }));
      }
    }
    this.onChange?.(this.list());
  }

  private listDirs(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  private labelAvailable(label: string, forId: string): boolean {
    if (!HOST_LABEL_PATTERN.test(label) || label.length < 3 || this.reserved.has(label)) return false;
    const owner = this.store.appByHostname(label);
    return !owner || owner.id === forId;
  }

  private freshLabel(id: string, preferred?: string): string {
    if (preferred && this.labelAvailable(preferred, id)) return preferred;
    for (;;) {
      const label = randomLabel();
      if (this.labelAvailable(label, id)) return label;
    }
  }

  private entry(id: string, type: AppType, source: AppSource, title: string, row: AppRow | undefined, extra: Partial<AppEntry>): AppEntry {
    if (!row) {
      const hostname = this.freshLabel(id, extra.survey?.def.subdomain);
      this.store.upsertApp({ id, type, source, title, enabled: 1, status_override: null, installed_on: today(), hostname });
      row = this.store.getApp(id)!;
    } else if (row.type !== type || row.source !== source || row.title !== title || !row.hostname) {
      const hostname = row.hostname ?? this.freshLabel(id, extra.survey?.def.subdomain);
      this.store.upsertApp({ ...row, type, source, title, hostname });
      row = this.store.getApp(id)!;
    }
    return {
      id,
      type,
      source,
      title,
      enabled: row.enabled === 1,
      statusOverride: row.status_override === 'open' || row.status_override === 'closed' ? row.status_override : null,
      installedOn: row.installed_on,
      hostLabel: row.hostname!,
      ...extra,
    };
  }

  /**
   * Changes that would expose earlier answers are refused once responses exist: switching the
   * access-code mode, or turning a free-text item into another kind (or back).
   */
  private definitionRefusal(def: SurveyDefinition): string | null {
    if (!this.store.hasResponses(def.id)) return null;
    const previous = this.previous.get(def.id) ?? this.apps.get(def.id);
    const prevMode = previous?.survey?.def.accessCodes ?? null;
    if (previous?.survey && (def.accessCodes ?? null) !== prevMode) return 'the access-code mode cannot change once responses exist';
    const changed = this.store.changedFieldKinds(def.id, fieldTypes(def));
    if (changed.length) return `answer keys change between free text and other kinds: ${changed.join(', ')}`;
    return null;
  }

  /** Keeps serving the last good version of a survey whose new file was refused. */
  private keepPrevious(folder: string, reason: string): void {
    const prev = this.previous.get(folder);
    if (prev && prev.type === 'survey') {
      this.apps.set(folder, prev);
      this.note(`${folder}: new definition refused (${reason}); still serving version ${prev.survey?.def.version}`);
    } else {
      this.note(`skipping ${folder}: ${reason}`);
    }
  }

  private addSurvey(folder: string, file: string, source: AppSource): void {
    const loaded = readSurveyFile(file);
    if (!loaded.def || !loaded.json) {
      this.keepPrevious(folder, loaded.error ?? 'invalid');
      return;
    }
    const def = loaded.def;
    if (def.id !== folder) {
      this.keepPrevious(folder, `folder name must equal the survey id (${def.id})`);
      return;
    }
    if (!validAppId(def.id)) {
      this.note(`skipping ${folder}: "${def.id}" is a reserved name`);
      return;
    }
    const refusal = this.definitionRefusal(def);
    if (refusal) {
      this.keepPrevious(def.id, refusal);
      return;
    }
    if (!this.store.registerVersion(def.id, def.version, hashJson(loaded.json), fieldTypes(def))) {
      this.keepPrevious(def.id, `content changed but version ${def.version} already has responses; increase "version"`);
      return;
    }
    const row = this.store.getApp(def.id);
    this.apps.set(def.id, this.entry(def.id, 'survey', source, def.title, row, { survey: { def, json: loaded.json, dir: path.dirname(file) } }));
    this.log(`loaded survey ${def.id} v${def.version} (${source})`);
  }

  list(): AppEntry[] {
    return [...this.apps.values()];
  }

  get(id: string): AppEntry | undefined {
    return this.apps.get(id);
  }

  byHostLabel(label: string): AppEntry | undefined {
    for (const app of this.apps.values()) if (app.hostLabel === label) return app;
    return undefined;
  }

  /** Gives an app a chosen subdomain label, or a new random one when `label` is null. */
  setHostLabel(id: string, label: string | null): string | null {
    const app = this.apps.get(id);
    const row = this.store.getApp(id);
    if (!app || !row) return 'not found';
    const next = label === null ? this.freshLabel(id) : label.trim().toLowerCase();
    if (!HOST_LABEL_PATTERN.test(next) || next.length < 3) return 'subdomain: 3–63 lowercase letters, digits or inner hyphens';
    if (this.reserved.has(next)) return 'this subdomain is reserved';
    if (!this.labelAvailable(next, id)) return 'this subdomain is already used by another app';
    this.store.upsertApp({ ...row, hostname: next });
    app.hostLabel = next;
    this.onChange?.(this.list());
    return null;
  }

  /** Enabled survey by id, as seen by participants. */
  publicSurvey(id: string): AppEntry | undefined {
    const app = this.apps.get(id);
    return app && app.enabled && app.type === 'survey' ? app : undefined;
  }

  publicStatic(id: string): AppEntry | undefined {
    const app = this.apps.get(id);
    return app && app.enabled && app.type === 'static' ? app : undefined;
  }

  statusOf(app: AppEntry, now: Date): SurveyStatus {
    // A released survey stays closed, whatever a later definition or override says.
    if (this.store.appReleased(app.id)) return 'closed';
    if (app.statusOverride) return app.statusOverride;
    return app.survey ? surveyStatus(app.survey.def, now) : 'open';
  }

  setEnabled(id: string, enabled: boolean): void {
    const row = this.store.getApp(id);
    if (row) this.store.upsertApp({ ...row, enabled: enabled ? 1 : 0 });
    const app = this.apps.get(id);
    if (app) app.enabled = enabled;
  }

  setStatusOverride(id: string, override: 'open' | 'closed' | null): void {
    const row = this.store.getApp(id);
    if (row) this.store.upsertApp({ ...row, status_override: override });
    const app = this.apps.get(id);
    if (app) app.statusOverride = override;
  }

  /** Installs or replaces an uploaded survey. Returns an error message or null. */
  installSurvey(raw: unknown): string | null {
    const errors = validateDefinition(raw);
    if (errors.length) return errors.join('; ');
    const def = raw as SurveyDefinition;
    if (!validAppId(def.id)) return `"${def.id}" is a reserved name`;
    const existing = this.apps.get(def.id);
    if (existing && existing.source === 'provisioned') return 'this survey is provisioned by the deployment and cannot be replaced here';
    if (existing && existing.type !== 'survey') return 'an app with this id already exists';
    const json = JSON.stringify(def);
    const refusal = this.definitionRefusal(def);
    if (refusal) return refusal;
    if (!this.store.registerVersion(def.id, def.version, hashJson(json), fieldTypes(def))) {
      return `version ${def.version} already has responses; increase "version" to change the content`;
    }
    const dir = path.join(this.appsDir, def.id);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'survey.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(def, null, 2));
    fs.renameSync(tmp, path.join(dir, 'survey.json'));
    this.reload();
    return null;
  }

  // ---- static apps: upload into staging/, then publish atomically to live/ ----

  beginStatic(id: string, title: string): string | null {
    if (!validAppId(id)) return 'invalid or reserved id';
    const existing = this.apps.get(id);
    if (existing && existing.type !== 'static') return 'an app with this id already exists';
    const staging = path.join(this.appsDir, id, 'staging');
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(this.appsDir, id, 'title.txt'), title.slice(0, 200));
    return null;
  }

  putStaticFile(id: string, relPath: string, body: Buffer): string | null {
    if (!validAppId(id)) return 'invalid or reserved id';
    const staging = path.join(this.appsDir, id, 'staging');
    if (!fs.existsSync(staging)) return 'upload not started';
    const segments = relPath.split('/').filter(Boolean);
    if (segments.length === 0 || segments.length > 12 || !segments.every((s) => STATIC_PATH_SEGMENT.test(s) && s !== '..')) {
      return `invalid file path: ${relPath}`;
    }
    if (body.length > STATIC_LIMITS.maxFileBytes) return 'file too large';
    const usage = dirUsage(staging);
    if (usage.files + 1 > STATIC_LIMITS.maxFiles || usage.bytes + body.length > STATIC_LIMITS.maxTotalBytes) {
      return 'app too large';
    }
    const target = path.join(staging, ...segments);
    if (!target.startsWith(staging + path.sep)) return 'invalid file path';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return null;
  }

  publishStatic(id: string): string | null {
    if (!validAppId(id)) return 'invalid or reserved id';
    const dir = path.join(this.appsDir, id);
    const staging = path.join(dir, 'staging');
    if (!fs.existsSync(path.join(staging, 'index.html'))) return 'the uploaded folder has no index.html at its top level';
    const live = path.join(dir, 'live');
    const old = path.join(dir, 'previous');
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(live)) fs.renameSync(live, old);
    fs.renameSync(staging, live);
    fs.rmSync(old, { recursive: true, force: true });
    let title = id;
    try {
      title = fs.readFileSync(path.join(dir, 'title.txt'), 'utf8').trim() || id;
    } catch {
      /* keep id */
    }
    const row = this.store.getApp(id);
    this.store.upsertApp({
      id,
      type: 'static',
      source: 'uploaded',
      title,
      enabled: row?.enabled ?? 1,
      status_override: null,
      installed_on: row?.installed_on ?? today(),
      hostname: row?.hostname ?? this.freshLabel(id),
    });
    this.reload();
    return null;
  }

  /** Removes an uploaded app. Survey responses must be deleted separately first. */
  remove(id: string): string | null {
    const app = this.apps.get(id);
    if (!app) return 'not found';
    if (app.source === 'provisioned') return 'provisioned apps are removed through the deployment';
    if (app.type === 'survey' && this.store.count(id) > 0) return 'delete the responses first';
    fs.rmSync(path.join(this.appsDir, id), { recursive: true, force: true });
    this.store.deleteApp(id);
    this.reload();
    return null;
  }
}

function dirUsage(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}
