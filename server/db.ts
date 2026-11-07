import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODE_ALPHABET, CODE_LENGTH, isWellFormedCode, normalizeCode, type Answers } from '../shared/schema.ts';

export interface StoredResponse {
  surveyVersion: number;
  submittedOn: string;
  /** Label of the course whose access code was used, if any. */
  course: string | null;
  answers: Answers;
}

export type InsertResult = 'stored' | 'duplicate' | 'full' | 'code_required' | 'code_unknown' | 'code_used';

export interface CourseInfo {
  id: string;
  label: string;
  createdOn: string;
  codes: number;
  used: number;
  revoked: number;
  responses: number;
}

export type CodeCheck = { status: 'ok'; courseId: string; course: string } | { status: 'unknown' | 'used' };

export interface CodeInfo {
  code: string;
  used: boolean;
  revoked: boolean;
}

export interface StoredRecord {
  collection: string;
  receivedOn: string;
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

/**
 * Response store. Rows use a random primary key in a WITHOUT ROWID table, so neither the
 * export order nor the physical row order reveals the order in which answers arrived.
 */
export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    if (dataDir !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
    const file = dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'responses.sqlite');
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
        survey_id TEXT NOT NULL,
        survey_version INTEGER NOT NULL,
        submitted_on TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        answers TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS responses_survey ON responses (survey_id);
      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY,
        survey_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_on TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        collection TEXT NOT NULL,
        received_on TEXT NOT NULL,
        payload TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS records_app ON records (app_id, collection);
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status_override TEXT,
        installed_on TEXT NOT NULL,
        hostname TEXT
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX IF NOT EXISTS apps_hostname ON apps (hostname) WHERE hostname IS NOT NULL;
      CREATE TABLE IF NOT EXISTS survey_versions (
        survey_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_hash TEXT NOT NULL,
        PRIMARY KEY (survey_id, version)
      ) WITHOUT ROWID;
    `);
    this.addColumn('responses', 'course_id', 'TEXT');
    this.addColumn('apps', 'collect_records', 'INTEGER NOT NULL DEFAULT 0');
  }

  private addColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Records the definition hash for a survey version. Returns false when the same version
   * number was seen before with different content and already has responses, i.e. the
   * survey was edited without bumping its version.
   */
  registerVersion(surveyId: string, version: number, definitionHash: string): boolean {
    const row = this.db
      .prepare('SELECT definition_hash AS h FROM survey_versions WHERE survey_id = ? AND version = ?')
      .get(surveyId, version) as { h: string } | undefined;
    if (!row) {
      this.db
        .prepare('INSERT INTO survey_versions (survey_id, version, definition_hash) VALUES (?, ?, ?)')
        .run(surveyId, version, definitionHash);
      return true;
    }
    if (row.h === definitionHash) return true;
    const count = this.db
      .prepare('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ? AND survey_version = ?')
      .get(surveyId, version) as { n: number };
    if (count.n > 0) return false;
    this.db
      .prepare('UPDATE survey_versions SET definition_hash = ? WHERE survey_id = ? AND version = ?')
      .run(definitionHash, surveyId, version);
    return true;
  }

  /**
   * Stores a response. With `codeMode` the access code is checked and marked as used in the same
   * transaction; the response only gets the code's course, never the code itself.
   */
  insert(
    surveyId: string,
    surveyVersion: number,
    submissionId: string,
    answers: Answers,
    submittedOn: string,
    maxResponses: number | undefined,
    codeMode?: 'required' | 'optional',
    rawCode?: string,
  ): InsertResult {
    const dedupeKey = createHash('sha256').update(`${surveyId}:${submissionId}`).digest('hex');
    return this.transaction((): InsertResult => {
      if (this.db.prepare('SELECT 1 FROM responses WHERE dedupe_key = ?').get(dedupeKey)) return 'duplicate';
      if (maxResponses !== undefined && this.count(surveyId) >= maxResponses) return 'full';
      let courseId: string | null = null;
      const code = rawCode ? normalizeCode(rawCode) : '';
      if (codeMode === 'required' && !code) return 'code_required';
      if (codeMode && code) {
        const row = this.db
          .prepare('SELECT course_id AS c, used AS u, revoked AS r FROM access_codes WHERE survey_id = ? AND code = ?')
          .get(surveyId, code) as { c: string; u: number; r: number } | undefined;
        if (!row || row.r) return 'code_unknown';
        if (row.u) return 'code_used';
        this.db.prepare('UPDATE access_codes SET used = 1 WHERE survey_id = ? AND code = ?').run(surveyId, code);
        courseId = row.c;
      }
      this.db
        .prepare(
          'INSERT INTO responses (id, survey_id, survey_version, submitted_on, dedupe_key, answers, course_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), surveyId, surveyVersion, submittedOn, dedupeKey, JSON.stringify(answers), courseId);
      return 'stored';
    });
  }

  // ---- courses and single-use access codes ----

  createCourse(surveyId: string, label: string, createdOn: string): string {
    const id = 'k' + randomBytes(5).toString('hex');
    this.db.prepare('INSERT INTO courses (id, survey_id, label, created_on) VALUES (?, ?, ?, ?)').run(id, surveyId, label, createdOn);
    return id;
  }

  courseExists(surveyId: string, courseId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM courses WHERE id = ? AND survey_id = ?').get(courseId, surveyId);
  }

  /** Creates `count` new random codes for a course and returns them. */
  addCodes(surveyId: string, courseId: string, count: number): string[] {
    const codes: string[] = [];
    this.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO access_codes (survey_id, code, course_id) VALUES (?, ?, ?)');
      while (codes.length < count) {
        let code = '';
        for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
        if (insert.run(surveyId, code, courseId).changes === 1) codes.push(code);
      }
    });
    return codes;
  }

  /**
   * Codes of a course with their state. Codes are stored in plain text so organisers can reprint
   * them; responses never reference a code, only the course.
   */
  listCodes(surveyId: string, courseId: string): CodeInfo[] {
    const rows = this.db
      .prepare('SELECT code, used, revoked FROM access_codes WHERE survey_id = ? AND course_id = ? ORDER BY code')
      .all(surveyId, courseId) as { code: string; used: number; revoked: number }[];
    return rows.map((r) => ({ code: r.code, used: r.used === 1, revoked: r.revoked === 1 }));
  }

  /** Blocks or unblocks codes of a course; returns how many codes changed. */
  setCodesRevoked(surveyId: string, courseId: string, codes: string[], revoked: boolean): number {
    let changed = 0;
    this.transaction(() => {
      const update = this.db.prepare('UPDATE access_codes SET revoked = ? WHERE survey_id = ? AND course_id = ? AND code = ? AND revoked <> ?');
      for (const raw of codes) changed += Number(update.run(revoked ? 1 : 0, surveyId, courseId, normalizeCode(raw), revoked ? 1 : 0).changes);
    });
    return changed;
  }

  renameCourse(surveyId: string, courseId: string, label: string): void {
    this.db.prepare('UPDATE courses SET label = ? WHERE id = ? AND survey_id = ?').run(label, courseId, surveyId);
  }

  checkCode(surveyId: string, rawCode: string): CodeCheck {
    const code = normalizeCode(rawCode);
    if (!isWellFormedCode(code)) return { status: 'unknown' };
    const row = this.db
      .prepare(
        `SELECT a.used AS u, a.revoked AS r, c.id AS id, c.label AS label FROM access_codes a JOIN courses c ON c.id = a.course_id
         WHERE a.survey_id = ? AND a.code = ?`,
      )
      .get(surveyId, code) as { u: number; r: number; id: string; label: string } | undefined;
    if (!row || row.r) return { status: 'unknown' };
    if (row.u) return { status: 'used' };
    return { status: 'ok', courseId: row.id, course: row.label };
  }

  listCourses(surveyId: string): CourseInfo[] {
    return (
      this.db
        .prepare(
          `SELECT c.id AS id, c.label AS label, c.created_on AS createdOn,
             (SELECT COUNT(*) FROM access_codes a WHERE a.course_id = c.id) AS codes,
             (SELECT COUNT(*) FROM access_codes a WHERE a.course_id = c.id AND a.used = 1) AS used,
             (SELECT COUNT(*) FROM access_codes a WHERE a.course_id = c.id AND a.revoked = 1) AS revoked,
             (SELECT COUNT(*) FROM responses r WHERE r.course_id = c.id) AS responses
           FROM courses c WHERE c.survey_id = ? ORDER BY c.created_on, c.label`,
        )
        .all(surveyId) as unknown as CourseInfo[]
    );
  }

  /** Removes a course and its codes; refused while responses still belong to it. */
  deleteCourse(surveyId: string, courseId: string): 'removed' | 'has_responses' | 'not_found' {
    if (!this.courseExists(surveyId, courseId)) return 'not_found';
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM responses WHERE course_id = ?').get(courseId) as { n: number };
    if (n.n > 0) return 'has_responses';
    this.db.prepare('DELETE FROM access_codes WHERE course_id = ?').run(courseId);
    this.db.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
    return 'removed';
  }

  count(surveyId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ?').get(surveyId) as { n: number };
    return row.n;
  }

  list(surveyId: string, courseId?: string): StoredResponse[] {
    const rows = this.db
      .prepare(
        `SELECT r.survey_version AS v, r.submitted_on AS d, r.answers AS a, c.label AS course
         FROM responses r LEFT JOIN courses c ON c.id = r.course_id
         WHERE r.survey_id = ? AND (? IS NULL OR r.course_id = ?) ORDER BY r.id`,
      )
      .all(surveyId, courseId ?? null, courseId ?? null) as { v: number; d: string; a: string; course: string | null }[];
    return rows.map((r) => ({ surveyVersion: r.v, submittedOn: r.d, course: r.course, answers: JSON.parse(r.a) as Answers }));
  }

  /**
   * Deletes every response of a survey (used after test runs) and marks its codes as unused
   * again, so test codes can be reused. Returns the number of responses removed.
   */
  purge(surveyId: string): number {
    const n = this.count(surveyId);
    this.db.prepare('DELETE FROM responses WHERE survey_id = ?').run(surveyId);
    this.db.prepare('DELETE FROM survey_versions WHERE survey_id = ?').run(surveyId);
    this.db.prepare('UPDATE access_codes SET used = 0 WHERE survey_id = ?').run(surveyId);
    return n;
  }

  // ---- records sent by web apps ----

  addRecord(appId: string, collection: string, receivedOn: string, payload: string, maxRecords: number): 'stored' | 'full' {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE app_id = ?').get(appId) as { n: number };
    if (n.n >= maxRecords) return 'full';
    this.db
      .prepare('INSERT INTO records (id, app_id, collection, received_on, payload) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), appId, collection, receivedOn, payload);
    return 'stored';
  }

  recordCollections(appId: string): CollectionInfo[] {
    return this.db
      .prepare('SELECT collection, COUNT(*) AS records FROM records WHERE app_id = ? GROUP BY collection ORDER BY collection')
      .all(appId) as unknown as CollectionInfo[];
  }

  recordCount(appId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE app_id = ?').get(appId) as { n: number }).n;
  }

  listRecords(appId: string, collection?: string): StoredRecord[] {
    const rows = this.db
      .prepare(
        `SELECT collection AS c, received_on AS d, payload AS p FROM records
         WHERE app_id = ? AND (? IS NULL OR collection = ?) ORDER BY id`,
      )
      .all(appId, collection ?? null, collection ?? null) as { c: string; d: string; p: string }[];
    return rows.map((r) => ({ collection: r.c, receivedOn: r.d, data: JSON.parse(r.p) as unknown }));
  }

  purgeRecords(appId: string, collection?: string): number {
    const before = this.recordCount(appId);
    this.db.prepare('DELETE FROM records WHERE app_id = ? AND (? IS NULL OR collection = ?)').run(appId, collection ?? null, collection ?? null);
    return before - this.recordCount(appId);
  }

  setCollectRecords(appId: string, on: boolean): void {
    this.db.prepare('UPDATE apps SET collect_records = ? WHERE id = ?').run(on ? 1 : 0, appId);
  }

  collectsRecords(appId: string): boolean {
    const row = this.db.prepare('SELECT collect_records AS c FROM apps WHERE id = ?').get(appId) as { c: number } | undefined;
    return row?.c === 1;
  }

  getApp(id: string): AppRow | undefined {
    return this.db.prepare('SELECT * FROM apps WHERE id = ?').get(id) as AppRow | undefined;
  }

  upsertApp(row: AppRow): void {
    this.db
      .prepare(
        `INSERT INTO apps (id, type, source, title, enabled, status_override, installed_on, hostname) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET type = excluded.type, source = excluded.source, title = excluded.title,
           enabled = excluded.enabled, status_override = excluded.status_override, hostname = excluded.hostname`,
      )
      .run(row.id, row.type, row.source, row.title, row.enabled, row.status_override, row.installed_on, row.hostname);
  }

  appByHostname(hostname: string): AppRow | undefined {
    return this.db.prepare('SELECT * FROM apps WHERE hostname = ?').get(hostname) as AppRow | undefined;
  }

  deleteApp(id: string): void {
    this.db.prepare('DELETE FROM apps WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM records WHERE app_id = ?').run(id);
    this.db.prepare('DELETE FROM access_codes WHERE survey_id = ?').run(id);
    this.db.prepare('DELETE FROM courses WHERE survey_id = ?').run(id);
    this.db.prepare('DELETE FROM survey_versions WHERE survey_id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
