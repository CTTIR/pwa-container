import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Answers } from '../shared/schema.ts';

export interface StoredResponse {
  surveyVersion: number;
  submittedOn: string;
  answers: Answers;
}

export type InsertResult = 'stored' | 'duplicate' | 'full';

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

  insert(
    surveyId: string,
    surveyVersion: number,
    submissionId: string,
    answers: Answers,
    submittedOn: string,
    maxResponses: number | undefined,
  ): InsertResult {
    const dedupeKey = createHash('sha256').update(`${surveyId}:${submissionId}`).digest('hex');
    const existing = this.db.prepare('SELECT 1 FROM responses WHERE dedupe_key = ?').get(dedupeKey);
    if (existing) return 'duplicate';
    if (maxResponses !== undefined && this.count(surveyId) >= maxResponses) return 'full';
    try {
      this.db
        .prepare(
          'INSERT INTO responses (id, survey_id, survey_version, submitted_on, dedupe_key, answers) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), surveyId, surveyVersion, submittedOn, dedupeKey, JSON.stringify(answers));
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) return 'duplicate';
      throw err;
    }
    return 'stored';
  }

  count(surveyId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ?').get(surveyId) as { n: number };
    return row.n;
  }

  list(surveyId: string): StoredResponse[] {
    const rows = this.db
      .prepare('SELECT survey_version AS v, submitted_on AS d, answers AS a FROM responses WHERE survey_id = ? ORDER BY id')
      .all(surveyId) as { v: number; d: string; a: string }[];
    return rows.map((r) => ({ surveyVersion: r.v, submittedOn: r.d, answers: JSON.parse(r.a) as Answers }));
  }

  /** Deletes every response of a survey (used after test runs). Returns the number removed. */
  purge(surveyId: string): number {
    const n = this.count(surveyId);
    this.db.prepare('DELETE FROM responses WHERE survey_id = ?').run(surveyId);
    this.db.prepare('DELETE FROM survey_versions WHERE survey_id = ?').run(surveyId);
    return n;
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
    this.db.prepare('DELETE FROM survey_versions WHERE survey_id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
