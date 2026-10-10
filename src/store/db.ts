import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, resolveDbPath, type CouncilConfig } from '../config';
import { CouncilError } from '../types';

/**
 * SQLite via node:sqlite — built into Node 22.5+, so there is no native build
 * step on Windows and no compiler prerequisite for the install.
 *
 * Table layout mirrors the domain separation. `candidates` records who produced
 * what, `evaluations` records blind judgements, `outcomes` records reality.
 * Nothing joins an evaluation back into a candidate row: they are read together
 * but written independently, so an evaluation can never overwrite provenance.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id                TEXT PRIMARY KEY,
        created_at        TEXT NOT NULL,
        task_type         TEXT NOT NULL,
        mode              TEXT NOT NULL,
        mode_reason       TEXT NOT NULL,
        sensitivity       TEXT NOT NULL,
        irreversible      INTEGER NOT NULL DEFAULT 0,
        high_stakes       INTEGER NOT NULL DEFAULT 0,
        prompt_version    TEXT NOT NULL,
        config_version    TEXT NOT NULL,
        input_hash        TEXT NOT NULL,
        request_excerpt   TEXT,
        is_shadow         INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS candidates (
        id                TEXT PRIMARY KEY,
        task_id           TEXT NOT NULL,
        author            TEXT NOT NULL,
        model             TEXT NOT NULL,
        candidate_hash    TEXT NOT NULL,
        content           TEXT,
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        cost_usd          REAL NOT NULL DEFAULT 0,
        latency_ms        INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS evaluations (
        id                TEXT PRIMARY KEY,
        task_id           TEXT NOT NULL,
        evaluator_model   TEXT NOT NULL,
        rubric_id         TEXT NOT NULL,
        rubric_version    TEXT NOT NULL,
        seed              TEXT NOT NULL,
        position_map      TEXT NOT NULL,
        author_a          TEXT NOT NULL,
        author_b          TEXT NOT NULL,
        scores_json       TEXT NOT NULL,
        hard_failures_json TEXT NOT NULL,
        score_a           REAL NOT NULL,
        score_b           REAL NOT NULL,
        gap               REAL NOT NULL,
        threshold         REAL NOT NULL,
        confidence        REAL NOT NULL,
        verdict           TEXT NOT NULL,
        decided_by        TEXT NOT NULL,
        rationale         TEXT,
        escalation_json   TEXT,
        created_at        TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS outcomes (
        id                TEXT PRIMARY KEY,
        task_id           TEXT NOT NULL,
        chosen_author     TEXT NOT NULL,
        metric_type       TEXT NOT NULL,
        metric_value      REAL NOT NULL,
        window            TEXT NOT NULL,
        notes             TEXT,
        is_final          INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE TABLE IF NOT EXISTS usage_log (
        id                TEXT PRIMARY KEY,
        ts                TEXT NOT NULL,
        day               TEXT NOT NULL,
        month             TEXT NOT NULL,
        task_id           TEXT,
        model             TEXT NOT NULL,
        purpose           TEXT NOT NULL,
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        cost_usd          REAL NOT NULL DEFAULT 0,
        latency_ms        INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_candidates_task ON candidates(task_id);
      CREATE INDEX IF NOT EXISTS idx_evaluations_task ON evaluations(task_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_task ON outcomes(task_id);
      CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_log(day);
      CREATE INDEX IF NOT EXISTS idx_usage_month ON usage_log(month);
      CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
    `,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      this.db = new DatabaseSync(dbPath);
    } catch (err) {
      throw new CouncilError(
        'store_unavailable',
        `Could not open the database at ${dbPath}: ${(err as Error).message}`,
        'Check the path is writable. Work still proceeds without the store; only history and statistics are unavailable.',
      );
    }
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL, applied_at TEXT NOT NULL, name TEXT NOT NULL);');
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_meta').get() as { v: number | null } | undefined;
    const current = row?.v ?? 0;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.db.exec(m.sql);
      this.db
        .prepare('INSERT INTO schema_meta (version, applied_at, name) VALUES (?, ?, ?)')
        .run(m.version, new Date().toISOString(), m.name);
    }
  }

  get schemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_meta').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  get raw(): DatabaseSync {
    return this.db;
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as never[]));
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

let singleton: Store | null = null;
let storeFailure: CouncilError | null = null;

/**
 * Opens the shared store. A store failure is recorded and returned as null
 * rather than thrown, because losing history must never lose the user's work:
 * callers degrade to "no statistics" and say so.
 */
export function getStore(cfg: CouncilConfig = loadConfig()): Store | null {
  if (singleton) return singleton;
  if (storeFailure) return null;
  try {
    singleton = new Store(resolveDbPath(cfg));
    return singleton;
  } catch (err) {
    storeFailure = err instanceof CouncilError
      ? err
      : new CouncilError('store_unavailable', (err as Error).message, 'Check the data directory is writable.');
    return null;
  }
}

export function getStoreFailure(): CouncilError | null {
  return storeFailure;
}

/** Test helper: swap in an in-memory store and clear any recorded failure. */
export function setStoreForTests(store: Store | null): void {
  singleton = store;
  storeFailure = null;
}
