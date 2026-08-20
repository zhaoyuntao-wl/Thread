import type Database from "better-sqlite3";
import type { EventKind } from "./events.js";
import { segment } from "./segment.js";
import { isIndexable } from "./governor.js";

export const SCHEMA_VERSION = 8;

// FTS 表 DDL（0-e 定案：jieba 预分词 shadow 列 body_seg，unicode61 按空格分词）。
// contentless（content=''）：FTS 仅存分词索引，不映射 content 表列（body_seg 在 events 表不存在，
// 外部内容表模式会报 no such column）；查询永远 JOIN events 取原文，FTS 列只用于 MATCH。
// 单一来源：store.ts 的 EVENTS_SCHEMA 与迁移重建共用此 DDL，避免两处漂移。
// 主表：body_seg（jieba 词级）——unicode61 tokenizer。
export const EVENTS_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  body_seg,
  content='',
  tokenize='unicode61'
);`;

// v6 兜底表（0-e 定案第 5 条落地）：trigram 内置 tokenizer 作子串召回兜底。
// "用户只记得半句"（查询是正文 token 的连续子串、jieba 分词无法命中）时主路径 0 命中，
// 由本表短语匹配兜底（trigram 对连续字符序列做 3-gram 索引，短语 = 子串匹配）。
// 双表而非单表双列：better-sqlite3 内置 SQLite（3.53.2）不支持 FTS5 列级 tokenizer
// 覆盖（"b tokenize='trigram'" parse error），独立表是可行的同语义实现（2026-08-18 修正）。
export const EVENTS_FTS_TRI_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS events_fts_tri USING fts5(
  body,
  content='',
  tokenize='trigram'
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
      // v6（trigram 兜底表）：主表已存在但兜底表缺失/为空 → 重建回填（v5 库升级触发）。
      // 判断依据 = 兜底表数据量（CREATE IF NOT EXISTS 后空表 = 未回填，需重建；不能只看表存在）。
      db.exec(EVENTS_FTS_DDL);
      db.exec(EVENTS_FTS_TRI_DDL);
      const triCount = (db.prepare(`SELECT COUNT(*) AS c FROM events_fts_tri`).get() as { c: number }).c;
      const ftsCols = cols("events_fts");
      if (!ftsCols.has("body_seg") || triCount === 0) {
        db.exec(`DROP TABLE IF EXISTS events_fts`);
        db.exec(`DROP TABLE IF EXISTS events_fts_tri`);
        db.exec(EVENTS_FTS_DDL);
        db.exec(EVENTS_FTS_TRI_DDL);
        const rows = db.prepare(`SELECT id, kind, body FROM events`).all() as Array<{ id: number; kind: EventKind; body: string }>;
        const insSeg = db.prepare(`INSERT INTO events_fts(rowid, body_seg) VALUES (?, ?)`);
        const insTri = db.prepare(`INSERT INTO events_fts_tri(rowid, body) VALUES (?, ?)`);
        for (const r of rows) {
          if (isIndexable(r.kind)) {
            insSeg.run(r.id, segment(r.body));
            insTri.run(r.id, r.body);
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

      // v8（G5 跨会话 delta）：updated_at 补齐（goals/feedback/pending_candidates 原只有 created_at）。
      // 必须在全部 CREATE 之后（旧库首次升级时 pending_candidates 可能尚不存在）
      for (const t of ["goals", "feedback", "pending_candidates"] as const) {
        const c = cols(t);
        if (!c.has("updated_at")) {
          db.exec(`ALTER TABLE ${t} ADD COLUMN updated_at TEXT`);
          db.exec(`UPDATE ${t} SET updated_at = created_at WHERE updated_at IS NULL`);
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_updated ON ${t}(project_key, updated_at)`);
      }

      // v7（MAX 批 1 地基）：产出/文档登记 + 待办 + 送达水位（跨会话 delta 触发判定持久化，G5）
      db.exec(`CREATE TABLE IF NOT EXISTS knowledge_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        topic TEXT,
        scenario TEXT,
        session_id TEXT NOT NULL,
        source_event INTEGER,
        created_at TEXT NOT NULL,
        isolation INTEGER NOT NULL DEFAULT 0
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_session ON knowledge_assets(session_id, created_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_visible ON knowledge_assets(isolation, created_at)`);

      db.exec(`CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        basis TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        project_key TEXT,
        isolation INTEGER NOT NULL DEFAULT 0
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_key, status)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id, status)`);

      db.exec(`CREATE TABLE IF NOT EXISTS thread_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
    }

    db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`).run(
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
  })();
}
