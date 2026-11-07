import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ALPHABET, CODE_LENGTH, isWellFormedCode, normalizeCode, type Answers } from '../shared/schema.ts';

/** A stored response: no date or time of any kind is kept. */
export interface StoredResponse {
  surveyVersion: number;
  /** Label of the course whose access code was used, if any. */
  course: string | null;
  answers: Answers;
}

export type InsertResult = 'stored' | 'duplicate' | 'full' | 'code_required' | 'code_unknown' | 'code_used' | 'course_closed';

/** Results of a group are released once it is closed with at least this many responses. */
export const MIN_GROUP = 5;

export interface CourseInfo {
  id: string;
  /** Name of the event, entered by the organiser. */
  label: string;
  /** Event date(s) entered by the organiser (YYYY-MM-DD); not related to any submission. */
  eventDate: string;
  eventDateEnd: string | null;
  closed: boolean;
  /** Closed with at least MIN_GROUP responses at some point; permanent. */
  released: boolean;
  codes: number;
  used: number;
  revoked: number;
  responses: number;
}

export type CodeCheck = { status: 'ok' | 'used'; courseId: string; course: string } | { status: 'unknown' | 'closed' };

/** A code as organisers see it: whether it is blocked, but never whether it was used. */
export interface CodeInfo {
  code: string;
  revoked: boolean;
}

/** A data record of a web app: no date or time of any kind is kept. */
export interface StoredRecord {
  collection: string;
  data: unknown;
}

export interface CollectionInfo {
  collection: string;
  records: number;
}

export interface AppRow {
  id: string;
  type: string;
  source: string;
  title: string;
  enabled: number;
  status_override: string | null;
  installed_on: string;
  hostname: string | null;
}

/** Compaction runs at most this often; a pending compaction is done when the interval has passed. */
const COMPACT_INTERVAL_MS = 30_000;
/** File times are set to this fixed value after writes, so they do not reveal when answers came in. */
const FIXED_TIME = new Date('2000-01-01T00:00:00Z');

function open(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  // No write-ahead log: a rollback journal is deleted after every commit, and deleted content is
  // overwritten, so no log keeps several changes (or their order) side by side.
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA secure_delete = ON;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Storage in three separate SQLite files:
 * - apps.sqlite: apps, survey versions, data records of web apps;
 * - codes.sqlite: courses and single-use access codes;
 * - answers.sqlite: survey responses.
 *
 * Using a code and storing the response are separate writes to separate files, never one
 * transaction. A response gets a fresh random id and only the course, never the code. The
 * answers file is rewritten in random-id order after responses arrive (VACUUM), so neither
 * row placement nor overflow pages reveal the order of submissions.
 */
export class Store {
  private main: DatabaseSync;
  private codes: DatabaseSync;
  private answers: DatabaseSync;
  private dataDir: string | null;
  /** Cached totals (count, bytes) per survey and per app, so limits never scan stored data. */
  private surveyTotals = new Map<string, { n: number; bytes: number }>();
  private appTotals = new Map<string, { n: number; bytes: number }>();

  constructor(dataDir: string) {
    const memory = dataDir === ':memory:';
    if (!memory) fs.mkdirSync(dataDir, { recursive: true });
    const file = (name: string) => (memory ? ':memory:' : path.join(dataDir, name));
    this.main = open(file('apps.sqlite'));
    this.codes = open(file('codes.sqlite'));
    this.answers = open(file('answers.sqlite'));
    this.dataDir = memory ? null : dataDir;
    this.main.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status_override TEXT,
        installed_on TEXT NOT NULL,
        hostname TEXT,
        collect_records INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0,
        uncoded_released INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX IF NOT EXISTS apps_hostname ON apps (hostname) WHERE hostname IS NOT NULL;
      CREATE TABLE IF NOT EXISTS survey_versions (
        survey_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_hash TEXT NOT NULL,
        field_types TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (survey_id, version)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        collection TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        size INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS records_app ON records (app_id, collection);
    `);
    this.codes.exec(`
      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY,
        survey_id TEXT NOT NULL,
        label TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_date_end TEXT,
        closed INTEGER NOT NULL DEFAULT 0,
        released INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS access_codes (
        survey_id TEXT NOT NULL,
        code TEXT NOT NULL,
        course_id TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (survey_id, code)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS access_codes_course ON access_codes (course_id);
    `);
    this.answers.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
        survey_id TEXT NOT NULL,
        survey_version INTEGER NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        course_id TEXT,
        size INTEGER NOT NULL,
        answers TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS responses_survey ON responses (survey_id, course_id);
    `);
  }

  private surveyTotal(surveyId: string): { n: number; bytes: number } {
    let t = this.surveyTotals.get(surveyId);
    if (!t) {
      t = this.answers
        .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM responses WHERE survey_id = ?')
        .get(surveyId) as { n: number; bytes: number };
      this.surveyTotals.set(surveyId, t);
    }
    return t;
  }

  private appTotal(appId: string): { n: number; bytes: number } {
    let t = this.appTotals.get(appId);
    if (!t) {
      t = this.main.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM records WHERE app_id = ?').get(appId) as {
        n: number;
        bytes: number;
      };
      this.appTotals.set(appId, t);
    }
    return t;
  }

  /** Total size of the stored answers of a survey in bytes. */
  surveyBytes(surveyId: string): number {
    return this.surveyTotal(surveyId).bytes;
  }

  private compactTimers = new Map<string, NodeJS.Timeout>();
  private lastCompacts = new Map<string, number>();

  /**
   * Rewrites a database file in primary-key (random id) order, so neither row placement nor
   * overflow pages reveal insertion order. Runs at most every COMPACT_INTERVAL_MS; otherwise
   * it is scheduled for when the interval has passed. `force` compacts immediately.
   */
  private compact(name: 'answers' | 'main' | 'codes', force = false): void {
    const db = name === 'answers' ? this.answers : name === 'main' ? this.main : this.codes;
    const run = () => {
      this.compactTimers.delete(name);
      this.lastCompacts.set(name, Date.now());
      db.exec('VACUUM');
      this.touchFixed();
    };
    const pending = this.compactTimers.get(name);
    if (force) {
      if (pending) clearTimeout(pending);
      run();
      return;
    }
    if (pending) return;
    const wait = (this.lastCompacts.get(name) ?? 0) + COMPACT_INTERVAL_MS - Date.now();
    if (wait <= 0) run();
    else this.compactTimers.set(name, setTimeout(run, wait).unref());
  }

  private compactAnswers(force = false): void {
    this.compact('answers', force);
  }

  /** Sets the database files' times to a fixed value, so they do not tell when anything was written. */
  private touchFixed(): void {
    if (!this.dataDir) return;
    for (const name of ['apps.sqlite', 'codes.sqlite', 'answers.sqlite', '.']) {
      try {
        fs.utimesSync(path.join(this.dataDir, name), FIXED_TIME, FIXED_TIME);
      } catch {
        /* ignore */
      }
    }
  }

  /** Periodic maintenance: compacts all files (removes insertion-order traces). */
  maintenance(): void {
    this.compact('answers', true);
    this.compact('main', true);
    this.compact('codes', true);
  }

  /**
   * Records the definition hash for a survey version. Returns false when the same version
   * number was seen before with different content and already has responses, i.e. the
   * survey was edited without bumping its version.
   */
  registerVersion(surveyId: string, version: number, definitionHash: string, fieldTypes: Record<string, string> = {}): boolean {
    const row = this.main
      .prepare('SELECT definition_hash AS h FROM survey_versions WHERE survey_id = ? AND version = ?')
      .get(surveyId, version) as { h: string } | undefined;
    const types = JSON.stringify(fieldTypes);
    if (!row) {
      this.main
        .prepare('INSERT INTO survey_versions (survey_id, version, definition_hash, field_types) VALUES (?, ?, ?, ?)')
        .run(surveyId, version, definitionHash, types);
      return true;
    }
    if (row.h === definitionHash) return true;
    const count = this.answers
      .prepare('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ? AND survey_version = ?')
      .get(surveyId, version) as { n: number };
    if (count.n > 0) return false;
    this.main
      .prepare('UPDATE survey_versions SET definition_hash = ?, field_types = ? WHERE survey_id = ? AND version = ?')
      .run(definitionHash, types, surveyId, version);
    return true;
  }

  /**
   * Answer keys whose kind (free text vs. other) differs from earlier versions that have
   * responses. Changing a free-text item into a rating would move old free texts into rating
   * rows, so such changes are refused.
   */
  changedFieldKinds(surveyId: string, fieldTypes: Record<string, string>): string[] {
    const versions = this.main.prepare('SELECT version, field_types AS t FROM survey_versions WHERE survey_id = ?').all(surveyId) as {
      version: number;
      t: string;
    }[];
    const kind = (t: string) => (t === 'text' ? 'text' : 'other');
    const changed = new Set<string>();
    for (const v of versions) {
      const n = (this.answers.prepare('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ? AND survey_version = ?').get(surveyId, v.version) as { n: number }).n;
      if (n === 0) continue;
      const old = JSON.parse(v.t) as Record<string, string>;
      for (const [key, type] of Object.entries(fieldTypes)) {
        if (old[key] !== undefined && kind(old[key]) !== kind(type)) changed.add(key);
      }
    }
    return [...changed];
  }

  /** Whether any response exists for the survey (used to freeze the access-code mode). */
  hasResponses(surveyId: string): boolean {
    return this.count(surveyId) > 0;
  }

  /**
   * Stores a response. With `codeMode` the access code is checked and marked as used first (in
   * the codes file); the response is then written separately (in the answers file) with a new
   * random id and only the course. Both steps run synchronously, so no other request can come
   * in between; if writing the response fails, the code is released again.
   */
  insert(
    surveyId: string,
    surveyVersion: number,
    submissionId: string,
    answers: Answers,
    limits: { maxResponses: number; maxBytes: number },
    codeMode?: 'required' | 'optional',
    rawCode?: string,
  ): InsertResult {
    const dedupeKey = createHash('sha256').update(`${surveyId}:${submissionId}`).digest('hex');
    if (this.answers.prepare('SELECT 1 FROM responses WHERE dedupe_key = ?').get(dedupeKey)) return 'duplicate';
    const payload = JSON.stringify(answers);
    const size = Buffer.byteLength(payload);
    const total = this.surveyTotal(surveyId);
    if (total.n >= limits.maxResponses || total.bytes + size > limits.maxBytes) return 'full';
    let courseId: string | null = null;
    let consumed: string | null = null;
    const code = rawCode ? normalizeCode(rawCode) : '';
    if (codeMode === 'required' && !code) return 'code_required';
    if (codeMode && code) {
      const row = this.codes
        .prepare(
          `SELECT a.course_id AS c, a.used AS u, a.revoked AS r, k.closed AS closed
           FROM access_codes a JOIN courses k ON k.id = a.course_id WHERE a.survey_id = ? AND a.code = ?`,
        )
        .get(surveyId, code) as { c: string; u: number; r: number; closed: number } | undefined;
      if (!row || row.r) return 'code_unknown';
      if (row.closed) return 'course_closed';
      if (row.u) return 'code_used';
      this.codes.prepare('UPDATE access_codes SET used = 1 WHERE survey_id = ? AND code = ?').run(surveyId, code);
      consumed = code;
      courseId = row.c;
    }
    try {
      this.answers
        .prepare('INSERT INTO responses (id, survey_id, survey_version, dedupe_key, course_id, size, answers) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), surveyId, surveyVersion, dedupeKey, courseId, size, payload);
    } catch (err) {
      if (consumed) this.codes.prepare('UPDATE access_codes SET used = 0 WHERE survey_id = ? AND code = ?').run(surveyId, consumed);
      if (err instanceof Error && /UNIQUE/i.test(err.message)) return 'duplicate';
      throw err;
    }
    total.n += 1;
    total.bytes += size;
    this.touchFixed();
    this.compactAnswers();
    return 'stored';
  }

  // ---- courses and single-use access codes ----

  createCourse(surveyId: string, label: string, eventDate: string, eventDateEnd: string | null): string {
    const id = 'k' + randomBytes(5).toString('hex');
    this.codes
      .prepare('INSERT INTO courses (id, survey_id, label, event_date, event_date_end) VALUES (?, ?, ?, ?, ?)')
      .run(id, surveyId, label, eventDate, eventDateEnd);
    return id;
  }

  /** Changes name and/or date(s) of a course. */
  updateCourse(surveyId: string, courseId: string, changes: { label?: string; eventDate?: string; eventDateEnd?: string | null }): void {
    if (changes.label !== undefined) this.codes.prepare('UPDATE courses SET label = ? WHERE id = ? AND survey_id = ?').run(changes.label, courseId, surveyId);
    if (changes.eventDate !== undefined) this.codes.prepare('UPDATE courses SET event_date = ? WHERE id = ? AND survey_id = ?').run(changes.eventDate, courseId, surveyId);
    if (changes.eventDateEnd !== undefined) {
      this.codes.prepare('UPDATE courses SET event_date_end = ? WHERE id = ? AND survey_id = ?').run(changes.eventDateEnd, courseId, surveyId);
    }
  }

  /** Closes every course of a survey (all its codes expire). Returns how many were open. */
  closeAllCourses(surveyId: string): number {
    const open = this.codes.prepare('SELECT id FROM courses WHERE survey_id = ? AND closed = 0').all(surveyId) as { id: string }[];
    for (const c of open) this.setCourseClosed(surveyId, c.id, true);
    return open.length;
  }

  courseExists(surveyId: string, courseId: string): boolean {
    return !!this.codes.prepare('SELECT 1 FROM courses WHERE id = ? AND survey_id = ?').get(courseId, surveyId);
  }

  /** Creates `count` new random codes for a course and returns them. */
  addCodes(surveyId: string, courseId: string, count: number): string[] {
    const codes: string[] = [];
    transaction(this.codes, () => {
      const insert = this.codes.prepare('INSERT OR IGNORE INTO access_codes (survey_id, code, course_id) VALUES (?, ?, ?)');
      while (codes.length < count) {
        let code = '';
        for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
        if (insert.run(surveyId, code, courseId).changes === 1) codes.push(code);
      }
    });
    return codes;
  }

  /**
   * Codes of a course for reprinting. Whether a single code was used is deliberately not
   * returned: watching that change would link a submission to its slip.
   */
  listCodes(surveyId: string, courseId: string): CodeInfo[] {
    const rows = this.codes
      .prepare('SELECT code, revoked FROM access_codes WHERE survey_id = ? AND course_id = ? ORDER BY code')
      .all(surveyId, courseId) as { code: string; revoked: number }[];
    return rows.map((r) => ({ code: r.code, revoked: r.revoked === 1 }));
  }

  /** Blocks or unblocks codes of a course; returns how many codes changed. */
  setCodesRevoked(surveyId: string, courseId: string, codes: string[], revoked: boolean): number {
    let changed = 0;
    transaction(this.codes, () => {
      const update = this.codes.prepare('UPDATE access_codes SET revoked = ? WHERE survey_id = ? AND course_id = ? AND code = ? AND revoked <> ?');
      for (const raw of codes) changed += Number(update.run(revoked ? 1 : 0, surveyId, courseId, normalizeCode(raw), revoked ? 1 : 0).changes);
    });
    return changed;
  }

  /** A closed course accepts no further responses; only closed courses can be released for results. */
  setCourseClosed(surveyId: string, courseId: string, closed: boolean): 'ok' | 'released' {
    const row = this.codes.prepare('SELECT released FROM courses WHERE id = ? AND survey_id = ?').get(courseId, surveyId) as { released: number } | undefined;
    if (!row) return 'ok';
    // Release is permanent: a released course stays closed.
    if (!closed && row.released) return 'released';
    this.codes.prepare('UPDATE courses SET closed = ? WHERE id = ? AND survey_id = ?').run(closed ? 1 : 0, courseId, surveyId);
    if (closed) {
      const n = this.answers.prepare('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ? AND course_id = ?').get(surveyId, courseId) as { n: number };
      if (n.n >= MIN_GROUP) this.codes.prepare('UPDATE courses SET released = 1 WHERE id = ? AND survey_id = ?').run(courseId, surveyId);
      this.compactAnswers(true);
    }
    return 'ok';
  }

  /** Permanent release flag of a survey without codes (closed with at least MIN_GROUP responses). */
  setAppReleased(appId: string): void {
    this.main.prepare('UPDATE apps SET released = 1 WHERE id = ?').run(appId);
  }

  /** Optional-code surveys: once answers without a code are released, none are accepted any more. */
  setUncodedReleased(appId: string): void {
    this.main.prepare('UPDATE apps SET uncoded_released = 1 WHERE id = ?').run(appId);
  }

  uncodedReleased(appId: string): boolean {
    return (this.main.prepare('SELECT uncoded_released AS r FROM apps WHERE id = ?').get(appId) as { r: number } | undefined)?.r === 1;
  }

  appReleased(appId: string): boolean {
    return (this.main.prepare('SELECT released FROM apps WHERE id = ?').get(appId) as { released: number } | undefined)?.released === 1;
  }

  /** Whether a course name is already used in this survey (names must be unique). */
  courseLabelTaken(surveyId: string, label: string, exceptId?: string): boolean {
    return !!this.codes
      .prepare('SELECT 1 FROM courses WHERE survey_id = ? AND lower(label) = lower(?) AND id <> ?')
      .get(surveyId, label, exceptId ?? '');
  }

  checkCode(surveyId: string, rawCode: string): CodeCheck {
    const code = normalizeCode(rawCode);
    if (!isWellFormedCode(code)) return { status: 'unknown' };
    const row = this.codes
      .prepare(
        `SELECT a.used AS u, a.revoked AS r, c.id AS id, c.label AS label, c.closed AS closed
         FROM access_codes a JOIN courses c ON c.id = a.course_id WHERE a.survey_id = ? AND a.code = ?`,
      )
      .get(surveyId, code) as { u: number; r: number; id: string; label: string; closed: number } | undefined;
    if (!row || row.r) return { status: 'unknown' };
    if (row.closed) return { status: 'closed' };
    return { status: row.u ? 'used' : 'ok', courseId: row.id, course: row.label };
  }

  private responseCounts(surveyId: string): Map<string, number> {
    const rows = this.answers
      .prepare('SELECT course_id AS c, COUNT(*) AS n FROM responses WHERE survey_id = ? AND course_id IS NOT NULL GROUP BY course_id')
      .all(surveyId) as { c: string; n: number }[];
    return new Map(rows.map((r) => [r.c, r.n]));
  }

  listCourses(surveyId: string): CourseInfo[] {
    const counts = this.responseCounts(surveyId);
    const rows = this.codes
      .prepare(
        `SELECT c.id AS id, c.label AS label, c.event_date AS eventDate, c.event_date_end AS eventDateEnd, c.closed AS closed,
           c.released AS released,
           (SELECT COUNT(*) FROM access_codes a WHERE a.course_id = c.id) AS codes,
           (SELECT COUNT(*) FROM access_codes a WHERE a.course_id = c.id AND a.used = 1) AS used,
           (SELECT COUNT(*) FROM access_codes a WHERE a.course_id = c.id AND a.revoked = 1) AS revoked
         FROM courses c WHERE c.survey_id = ? ORDER BY c.event_date, c.label`,
      )
      .all(surveyId) as {
      id: string;
      label: string;
      eventDate: string;
      eventDateEnd: string | null;
      closed: number;
      released: number;
      codes: number;
      used: number;
      revoked: number;
    }[];
    return rows.map((r) => ({ ...r, closed: r.closed === 1, released: r.released === 1, responses: counts.get(r.id) ?? 0 }));
  }

  /**
   * Removes a course and its codes. With `withResponses` its responses are deleted too (for
   * retention periods); otherwise this is refused while responses still belong to it.
   */
  deleteCourse(surveyId: string, courseId: string, withResponses = false): 'removed' | 'has_responses' | 'not_found' {
    if (!this.courseExists(surveyId, courseId)) return 'not_found';
    const n = this.answers.prepare('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ? AND course_id = ?').get(surveyId, courseId) as { n: number };
    if (n.n > 0 && !withResponses) return 'has_responses';
    if (n.n > 0) {
      this.answers.prepare('DELETE FROM responses WHERE survey_id = ? AND course_id = ?').run(surveyId, courseId);
      this.surveyTotals.delete(surveyId);
      this.compactAnswers(true);
    }
    transaction(this.codes, () => {
      this.codes.prepare('DELETE FROM access_codes WHERE course_id = ?').run(courseId);
      this.codes.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
    });
    this.compact('codes', true);
    return 'removed';
  }

  /** Whether a response with this submission id is already stored (resend after a lost reply). */
  isDuplicate(surveyId: string, submissionId: string): boolean {
    const dedupeKey = createHash('sha256').update(`${surveyId}:${submissionId}`).digest('hex');
    return !!this.answers.prepare('SELECT 1 FROM responses WHERE dedupe_key = ?').get(dedupeKey);
  }

  /** Responses stored without a code (optional-code surveys). */
  uncodedCount(surveyId: string): number {
    return (this.answers.prepare('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ? AND course_id IS NULL').get(surveyId) as { n: number }).n;
  }

  count(surveyId: string): number {
    return this.surveyTotal(surveyId).n;
  }

  /** Responses in random order, optionally limited to some courses. */
  list(surveyId: string, courseIds?: string[], includeUncoded = false): StoredResponse[] {
    const labels = new Map(
      (this.codes.prepare('SELECT id, label FROM courses WHERE survey_id = ?').all(surveyId) as { id: string; label: string }[]).map((c) => [c.id, c.label]),
    );
    const rows = this.answers
      .prepare('SELECT survey_version AS v, course_id AS c, answers AS a FROM responses WHERE survey_id = ? ORDER BY id')
      .all(surveyId) as { v: number; c: string | null; a: string }[];
    const allowed = courseIds ? new Set(courseIds) : null;
    return rows
      .filter((r) => !allowed || (r.c !== null ? allowed.has(r.c) : includeUncoded))
      .map((r) => ({ surveyVersion: r.v, course: r.c ? (labels.get(r.c) ?? null) : null, answers: JSON.parse(r.a) as Answers }));
  }

  /**
   * Deletes every response of a survey (used after test runs) and marks its codes as unused
   * again, so test codes can be reused. Returns the number of responses removed.
   */
  purge(surveyId: string): number {
    const n = this.count(surveyId);
    this.answers.prepare('DELETE FROM responses WHERE survey_id = ?').run(surveyId);
    this.surveyTotals.delete(surveyId);
    this.main.prepare('DELETE FROM survey_versions WHERE survey_id = ?').run(surveyId);
    this.codes.prepare('UPDATE access_codes SET used = 0 WHERE survey_id = ?').run(surveyId);
    this.compactAnswers(true);
    this.compact('codes', true);
    return n;
  }

  // ---- records sent by web apps ----

  /**
   * Stores a record unless the app's record count or total size limit would be exceeded. A
   * client record id (if given) de-duplicates resends; only its hash is stored.
   */
  addRecord(appId: string, collection: string, payload: string, clientId: string | undefined, maxRecords: number, maxTotalBytes: number): 'stored' | 'duplicate' | 'full' {
    const dedupeKey = clientId ? createHash('sha256').update(`${appId}:${clientId}`).digest('hex') : null;
    if (dedupeKey && this.main.prepare('SELECT 1 FROM records WHERE dedupe_key = ?').get(dedupeKey)) return 'duplicate';
    const size = Buffer.byteLength(payload);
    const total = this.appTotal(appId);
    if (total.n >= maxRecords || total.bytes + size > maxTotalBytes) return 'full';
    this.main
      .prepare('INSERT INTO records (id, app_id, collection, dedupe_key, size, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), appId, collection, dedupeKey, size, payload);
    total.n += 1;
    total.bytes += size;
    this.touchFixed();
    this.compact('main');
    return 'stored';
  }

  recordCollections(appId: string): CollectionInfo[] {
    return this.main
      .prepare('SELECT collection, COUNT(*) AS records FROM records WHERE app_id = ? GROUP BY collection ORDER BY collection')
      .all(appId) as unknown as CollectionInfo[];
  }

  /**
   * One page of records in random order (keyset paging on the random id), so exports never keep
   * a database statement open between two writes.
   */
  recordPage(appId: string, collection: string | undefined, afterId: string, limit: number): { id: string; record: StoredRecord }[] {
    const rows = this.main
      .prepare(
        `SELECT id, collection AS c, payload AS p FROM records
         WHERE app_id = ? AND (? IS NULL OR collection = ?) AND id > ? ORDER BY id LIMIT ?`,
      )
      .all(appId, collection ?? null, collection ?? null, afterId, limit) as { id: string; c: string; p: string }[];
    return rows.map((r) => ({ id: r.id, record: { collection: r.c, data: JSON.parse(r.p) as unknown } }));
  }

  /** All records page by page (synchronous; no statement stays open between pages). */
  *recordPages(appId: string, collection?: string, pageSize = 500): Generator<StoredRecord[]> {
    let after = '';
    for (;;) {
      const page = this.recordPage(appId, collection, after, pageSize);
      if (page.length === 0) return;
      yield page.map((p) => p.record);
      after = page[page.length - 1].id;
    }
  }

  recordBytes(appId: string): number {
    return this.appTotal(appId).bytes;
  }

  recordCount(appId: string): number {
    return this.appTotal(appId).n;
  }

  purgeRecords(appId: string, collection?: string): number {
    const removed = Number(
      this.main.prepare('DELETE FROM records WHERE app_id = ? AND (? IS NULL OR collection = ?)').run(appId, collection ?? null, collection ?? null).changes,
    );
    this.appTotals.delete(appId);
    this.compact('main', true);
    return removed;
  }

  setCollectRecords(appId: string, on: boolean): void {
    this.main.prepare('UPDATE apps SET collect_records = ? WHERE id = ?').run(on ? 1 : 0, appId);
  }

  collectsRecords(appId: string): boolean {
    const row = this.main.prepare('SELECT collect_records AS c FROM apps WHERE id = ?').get(appId) as { c: number } | undefined;
    return row?.c === 1;
  }

  getApp(id: string): AppRow | undefined {
    return this.main
      .prepare('SELECT id, type, source, title, enabled, status_override, installed_on, hostname FROM apps WHERE id = ?')
      .get(id) as AppRow | undefined;
  }

  upsertApp(row: AppRow): void {
    this.main
      .prepare(
        `INSERT INTO apps (id, type, source, title, enabled, status_override, installed_on, hostname) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET type = excluded.type, source = excluded.source, title = excluded.title,
           enabled = excluded.enabled, status_override = excluded.status_override, hostname = excluded.hostname`,
      )
      .run(row.id, row.type, row.source, row.title, row.enabled, row.status_override, row.installed_on, row.hostname);
  }

  appByHostname(hostname: string): AppRow | undefined {
    return this.main
      .prepare('SELECT id, type, source, title, enabled, status_override, installed_on, hostname FROM apps WHERE hostname = ?')
      .get(hostname) as AppRow | undefined;
  }

  deleteApp(id: string): void {
    this.main.prepare('DELETE FROM apps WHERE id = ?').run(id);
    this.main.prepare('DELETE FROM records WHERE app_id = ?').run(id);
    this.appTotals.delete(id);
    this.main.prepare('DELETE FROM survey_versions WHERE survey_id = ?').run(id);
    this.codes.prepare('DELETE FROM access_codes WHERE survey_id = ?').run(id);
    this.codes.prepare('DELETE FROM courses WHERE survey_id = ?').run(id);
    this.compact('main', true);
    this.compact('codes', true);
  }

  close(): void {
    for (const t of this.compactTimers.values()) clearTimeout(t);
    this.main.close();
    this.codes.close();
    this.answers.close();
  }
}
