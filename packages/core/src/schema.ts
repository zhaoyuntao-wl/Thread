import type Database from "better-sqlite3";
import type { EventKind } from "./events.js";
import { segment } from "./segment.js";
import { isIndexable } from "./governor.js";

export const SCHEMA_VERSION = 5;

// FTS 表 DDL（0-e 定案：jieba 预分词 shadow 列 body_seg，unicode61 按空格分词）。
// contentless（content=''）：FTS 仅存分词索引，不映射 content 表列（body_seg 在 events 表不存在，
// 外部内容表模式会报 no such column）；查询永远 JOIN events 取原文，FTS 列只用于 MATCH。
// 单一来源：store.ts 的 EVENTS_SCHEMA 与 v5 迁移重建共用此 DDL，避免两处漂移。
export const EVENTS_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  body_seg,
  content='',
  tokenize='unicode61'
);`;

export type SchemaKind = "events" | "structured";

// 双库（B④）：事件库（events/episodes/spills/lineage_edges 事件域）与结构化库
// （goals/decisions/feedback/entities/decision_entities/metrics/lineage_edges 结构化域）
// 各库独立 schema_version 表、独立迁移链，共用 SCHEMA_VERSION。
// 迁移只负责：旧库按需补 v2 列/表，幂等（列存在则跳过），最后写 schema_version。

export function ensureSchema(db: Database.Database, kind: SchemaKind): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL
  );`);

  const row = db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM schema_version`).get() as { v: number };
  if (row.v >= SCHEMA_VERSION) return;

  db.transaction(() => {
    const cols = (t: string): Set<string> =>
      new Set((db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name));

    if (kind === "events") {
      const eventsCols = cols("events");
      if (!eventsCols.has("project_key")) db.exec(`ALTER TABLE events ADD COLUMN project_key TEXT`);
      if (!eventsCols.has("scope")) db.exec(`ALTER TABLE events ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
      if (!eventsCols.has("origin")) db.exec(`ALTER TABLE events ADD COLUMN origin TEXT`);
      if (!eventsCols.has("spilled")) db.exec(`ALTER TABLE events ADD COLUMN spilled INTEGER NOT NULL DEFAULT 0`);
      if (!eventsCols.has("isolation")) db.exec(`ALTER TABLE events ADD COLUMN isolation INTEGER NOT NULL DEFAULT 0`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_key, ts)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_origin ON events(origin) WHERE origin IS NOT NULL`);

      // v5（0-e 定案）：FTS 从 unicode61(body 单字) 重建为 body_seg(jieba 预分词)。
      // fts5 虚拟表不支持 ALTER 加列 → DROP + 重建 + 全量回填（events 原文表不受影响）。
      const ftsCols = cols("events_fts");
      if (!ftsCols.has("body_seg")) {
        db.exec(`DROP TABLE IF EXISTS events_fts`);
        db.exec(EVENTS_FTS_DDL);
        const rows = db.prepare(`SELECT id, kind, body FROM events`).all() as Array<{ id: number; kind: EventKind; body: string }>;
        const ins = db.prepare(`INSERT INTO events_fts(rowid, body_seg) VALUES (?, ?)`);
        for (const r of rows) {
          if (isIndexable(r.kind)) {
            ins.run(r.id, segment(r.body));
          }
        }
      }

      db.exec(`CREATE TABLE IF NOT EXISTS spills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(id),
        ref TEXT NOT NULL,
        blob TEXT,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`);
    } else {
      for (const t of ["goals", "decisions"] as const) {
        const c = cols(t);
        if (!c.has("project_key")) db.exec(`ALTER TABLE ${t} ADD COLUMN project_key TEXT`);
        if (!c.has("scope")) db.exec(`ALTER TABLE ${t} ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
        if (!c.has("origin")) db.exec(`ALTER TABLE ${t} ADD COLUMN origin TEXT`);
        if (!c.has("isolation")) db.exec(`ALTER TABLE ${t} ADD COLUMN isolation INTEGER NOT NULL DEFAULT 0`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_project ON ${t}(project_key, status)`);
      }
      {
        const c = cols("feedback");
        if (!c.has("project_key")) db.exec(`ALTER TABLE feedback ADD COLUMN project_key TEXT`);
        if (!c.has("scope")) db.exec(`ALTER TABLE feedback ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
        if (!c.has("origin")) db.exec(`ALTER TABLE feedback ADD COLUMN origin TEXT`);
        if (!c.has("isolation")) db.exec(`ALTER TABLE feedback ADD COLUMN isolation INTEGER NOT NULL DEFAULT 0`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_project ON feedback(project_key, kind)`);
      }

      db.exec(`CREATE TABLE IF NOT EXISTS session_isolation (
        session_id TEXT PRIMARY KEY,
        isolated INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
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

      // 轻确认候选（§1.5.3d）：规则粗筛暂存，未确认绝不进正式表。
      // prompt_count = 已提示次数（衰减控制）；last_prompt_ts = 上次提示时间（超时丢弃）；kind = decision|preference（影响分级）。
      db.exec(`CREATE TABLE IF NOT EXISTS pending_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'preference',
        status TEXT NOT NULL DEFAULT 'pending',
        source_event INTEGER,
        created_at TEXT NOT NULL,
        prompt_count INTEGER NOT NULL DEFAULT 0,
        last_prompt_ts TEXT,
        project_key TEXT,
        isolation INTEGER NOT NULL DEFAULT 0
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_project ON pending_candidates(project_key, status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_candidates(session_id, status)`);
    }

    db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`).run(
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
  })();
}
