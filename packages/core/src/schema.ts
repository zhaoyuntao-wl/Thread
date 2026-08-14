import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 2;

// v1 基线 schema（现网库现状，不加表只保留）；新库直接建 v2 完整 schema（见 store.ts SCHEMA）。
// 迁移只负责：旧库按需补 v2 列/表，幂等（列存在则跳过），最后写 schema_version。

export function ensureSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL
  );`);

  const row = db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM schema_version`).get() as { v: number };
  if (row.v >= SCHEMA_VERSION) return;

  db.transaction(() => {
    const cols = (t: string): Set<string> =>
      new Set((db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name));

    const eventsCols = cols("events");
    if (!eventsCols.has("project_key")) db.exec(`ALTER TABLE events ADD COLUMN project_key TEXT`);
    if (!eventsCols.has("scope")) db.exec(`ALTER TABLE events ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
    if (!eventsCols.has("origin")) db.exec(`ALTER TABLE events ADD COLUMN origin TEXT`);
    if (!eventsCols.has("spilled")) db.exec(`ALTER TABLE events ADD COLUMN spilled INTEGER NOT NULL DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_key, ts)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_origin ON events(origin) WHERE origin IS NOT NULL`);

    db.exec(`CREATE TABLE IF NOT EXISTS spills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id),
      ref TEXT NOT NULL,
      blob TEXT,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS decision_entities (
      decision_id INTEGER NOT NULL REFERENCES decisions(id),
      entity_id INTEGER NOT NULL REFERENCES entities(id),
      edge TEXT NOT NULL DEFAULT 'references',
      ts TEXT NOT NULL,
      PRIMARY KEY (decision_id, entity_id)
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER,
      name TEXT NOT NULL,
      value REAL NOT NULL,
      ts TEXT NOT NULL
    );`);

    for (const t of ["goals", "decisions"] as const) {
      const c = cols(t);
      if (!c.has("project_key")) db.exec(`ALTER TABLE ${t} ADD COLUMN project_key TEXT`);
      if (!c.has("scope")) db.exec(`ALTER TABLE ${t} ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
      if (!c.has("origin")) db.exec(`ALTER TABLE ${t} ADD COLUMN origin TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_project ON ${t}(project_key, status)`);
    }
    {
      const c = cols("feedback");
      if (!c.has("project_key")) db.exec(`ALTER TABLE feedback ADD COLUMN project_key TEXT`);
      if (!c.has("scope")) db.exec(`ALTER TABLE feedback ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
      if (!c.has("origin")) db.exec(`ALTER TABLE feedback ADD COLUMN origin TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_project ON feedback(project_key, kind)`);
    }

    db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`).run(
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
  })();
}
