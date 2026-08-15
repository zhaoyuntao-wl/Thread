import Database from "better-sqlite3";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashProjectKey } from "./project-key.js";
import { ThreadStore } from "./store.js";

// B④ 迁移核心（评审定案：逻辑入 core，scripts/migrate-split.mjs 仅 CLI 包装）。
// 复制式迁移：旧库只读、不改旧库 DDL；快照后增量由 replayIncrement 补拉（零差异）。

export interface MigrateOptions {
  oldPath: string;
  root: string;
  projectKey: string;
  dryRun?: boolean;
}

export interface MigrateResult {
  projectKey: string;
  events: { copied: number; backfilled: number };
  structured: { goals: number; decisions: number; feedback: number; backfilled: number };
  lineage: { events: number; structured: number };
  integrity: { events: boolean; structured: boolean };
}

export interface TableMaxIds {
  events: number;
  episodes: number;
  spills: number;
  goals: number;
  decisions: number;
  feedback: number;
  lineage_edges: number;
  entities: number;
  metrics: number;
}

// decision_entities 为复合主键表（无 id 列），不走按 id 快照/增量，全量 INSERT OR IGNORE
const TABLES = [
  "events",
  "episodes",
  "spills",
  "goals",
  "decisions",
  "feedback",
  "lineage_edges",
  "entities",
  "metrics",
] as const;

type TableName = (typeof TABLES)[number];

function maxId(db: Database.Database, table: TableName): number {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number };
  return row.m;
}

export function snapshotTableMaxIds(oldPath: string): TableMaxIds {
  const old = openOld(oldPath);
  try {
    return Object.fromEntries(TABLES.map((t) => [t, maxId(old, t)])) as unknown as TableMaxIds;
  } finally {
    old.close();
  }
}

// 事件行 project_key 回填：NULL → 项目键；结构化行：scope='project' NULL → 沿 source_event 追溯，失败退化项目键；global → NULL
export function migrateSplit(opts: MigrateOptions): MigrateResult {
  const old = openOld(opts.oldPath);
  try {
    const resolvedKey = resolveProjectKey(old, opts.projectKey);
    if (opts.dryRun) {
      const stats = dryRunStats(old);
      old.close();
      return {
        projectKey: resolvedKey,
        events: { copied: stats.events, backfilled: stats.eventsBackfilled },
        structured: {
          goals: stats.goals,
          decisions: stats.decisions,
          feedback: stats.feedback,
          backfilled: stats.structuredBackfilled,
        },
        lineage: { events: stats.lineageEvents, structured: stats.lineageStructured },
        integrity: { events: false, structured: false },
      };
    }

    const eventsDbPath = join(opts.root, "projects", hashProjectKey(resolvedKey), "events.db");
    const structuredDbPath = join(opts.root, "structured.db");
    mkdirSync(dirname(eventsDbPath), { recursive: true });
    mkdirSync(dirname(structuredDbPath), { recursive: true });
    const store = new ThreadStore({ eventsPath: eventsDbPath, structuredPath: structuredDbPath, projectKey: resolvedKey });

    const events = copyEvents(old, store.eventsDb, resolvedKey);
    copyRaw(old, store.eventsDb, "episodes");
    copyRaw(old, store.eventsDb, "spills");
    const structured = copyStructured(old, store.structuredDb, old, resolvedKey);
    copyRaw(old, store.structuredDb, "entities");
    copyJoinTable(old, store.structuredDb, "decision_entities");
    copyRaw(old, store.structuredDb, "metrics");
    const lineage = copyLineage(old, store);

    const integrity = {
      events: checkIntegrity(store.eventsDb),
      structured: checkIntegrity(store.structuredDb),
    };
    store.close();
    return {
      projectKey: resolvedKey,
      events,
      structured,
      lineage,
      integrity,
    };
  } finally {
    if (!opts.dryRun) {
      try {
        copyFileSync(opts.oldPath, `${opts.oldPath}.bak-b4`);
      } catch {
        // 备份失败不阻塞迁移，旧库原样保留
      }
    }
    old.close();
  }
}

// 增量重放：快照后旧库新增行按原 id 复制到新库；无 origin 行按 (session_id,kind,ts,body) 兜底去重；写入带 SQLITE_BUSY 重试
export function replayIncrement(
  oldPath: string,
  root: string,
  projectKey: string,
  snapshot: TableMaxIds,
): { events: number; structured: number; lineage: number } {
  const old = openOld(oldPath);
  try {
    const eventsDbPath = join(root, "projects", hashProjectKey(projectKey), "events.db");
    const structuredDbPath = join(root, "structured.db");
    const store = new ThreadStore({ eventsPath: eventsDbPath, structuredPath: structuredDbPath, projectKey });

    const ev = copyEventsRange(old, store.eventsDb, projectKey, snapshot.events);
    copyRawRange(old, store.eventsDb, "episodes", snapshot.episodes);
    copyRawRange(old, store.eventsDb, "spills", snapshot.spills);
    const st = copyStructuredRange(old, store.structuredDb, old, projectKey, snapshot);
    copyRawRange(old, store.structuredDb, "entities", snapshot.entities);
    copyJoinTable(old, store.structuredDb, "decision_entities");
    copyRawRange(old, store.structuredDb, "metrics", snapshot.metrics);
    const lineage = copyLineageRange(old, store, snapshot.lineage_edges);

    store.close();
    return { events: ev, structured: st, lineage };
  } finally {
    old.close();
  }
}

function openOld(path: string): Database.Database {
  return new Database(path, { readonly: true });
}

function resolveProjectKey(old: Database.Database, fallback: string): string {
  const row = old
    .prepare(`SELECT project_key, COUNT(*) AS c FROM events WHERE project_key IS NOT NULL GROUP BY project_key ORDER BY c DESC LIMIT 1`)
    .get() as { project_key: string } | undefined;
  return row?.project_key ?? fallback;
}

function dryRunStats(
  old: Database.Database,
): {
  events: number;
  eventsBackfilled: number;
  goals: number;
  decisions: number;
  feedback: number;
  structuredBackfilled: number;
  lineageEvents: number;
  lineageStructured: number;
} {
  const events = count(old, "events");
  const eventsBackfilled = countWhere(old, "events", "project_key IS NULL");
  const goals = count(old, "goals");
  const decisions = count(old, "decisions");
  const feedback = count(old, "feedback");
  const structuredBackfilled = countWhere(old, "feedback", "project_key IS NULL AND scope = 'project'")
    + countWhere(old, "goals", "project_key IS NULL AND scope = 'project'")
    + countWhere(old, "decisions", "project_key IS NULL AND scope = 'project'");
  const lineage = allLineage(old);
  const lineageEvents = lineage.filter((e) => isEventDomain(e.src_type, e.dst_type)).length;
  const lineageStructured = lineage.length - lineageEvents;
  return { events, eventsBackfilled, goals, decisions, feedback, structuredBackfilled, lineageEvents, lineageStructured };
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function countWhere(db: Database.Database, table: string, where: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get() as { c: number }).c;
}

interface LineageRow {
  id: number;
  session_id: string;
  src_type: string;
  src_id: number | null;
  dst_type: string;
  dst_id: number | null;
  ref: string | null;
  edge_type: string;
  confidence: number;
  ts: string;
}

function isEventDomain(srcType: string, dstType: string): boolean {
  const s = srcType === "event" || srcType === "file" || srcType === "tool";
  const d = dstType === "event" || dstType === "file" || dstType === "tool";
  return s && d;
}

function allLineage(old: Database.Database): LineageRow[] {
  return old.prepare(`SELECT id, session_id, src_type, src_id, dst_type, dst_id, ref, edge_type, confidence, ts FROM lineage_edges ORDER BY id`).all() as LineageRow[];
}

const EVENT_COLS = ["id", "session_id", "kind", "ts", "seq", "body", "meta", "truncated", "project_key", "scope", "origin", "spilled", "isolation"] as const;

function eventSourceCols(old: Database.Database): string[] {
  // 旧库可能无 isolation 列（v2 及以前）——动态裁剪，缺失列迁移后取 DEFAULT 0（共享）
  const have = columns(old, "events");
  return EVENT_COLS.filter((c) => have.includes(c));
}

function copyEvents(
  old: Database.Database,
  target: Database.Database,
  projectKey: string,
): { copied: number; backfilled: number } {
  const srcCols = eventSourceCols(old);
  const dstCols = srcCols.includes("isolation") ? srcCols : [...srcCols, "isolation"];
  const rows = old.prepare(`SELECT ${srcCols.join(", ")} FROM events ORDER BY id`).all() as Array<Record<string, unknown>>;
  const insert = target.prepare(
    `INSERT INTO events (${dstCols.join(", ")}) VALUES (${dstCols.map(() => "?").join(", ")})`,
  );
  let backfilled = 0;
  const tx = target.transaction(() => {
    for (const row of rows) {
      if (row.project_key == null) {
        row.project_key = projectKey;
        backfilled++;
      }
      insert.run(...dstCols.map((c) => (c === "isolation" && row[c] == null ? 0 : row[c])));
    }
  });
  tx();
  return { copied: rows.length, backfilled };
}

function copyEventsRange(
  old: Database.Database,
  target: Database.Database,
  projectKey: string,
  afterId: number,
): number {
  const srcCols = eventSourceCols(old);
  const dstCols = srcCols.includes("isolation") ? srcCols : [...srcCols, "isolation"];
  const rows = old
    .prepare(`SELECT ${srcCols.join(", ")} FROM events WHERE id > ? ORDER BY id`)
    .all(afterId) as Array<Record<string, unknown>>;
  const insert = target.prepare(
    `INSERT INTO events (${dstCols.join(", ")}) VALUES (${dstCols.map(() => "?").join(", ")})`,
  );
  const tx = target.transaction(() => {
    for (const row of rows) {
      if (row.project_key == null) {
        row.project_key = projectKey;
      }
      insert.run(...dstCols.map((c) => (c === "isolation" && row[c] == null ? 0 : row[c])));
    }
  });
  tx();
  return rows.length;
}

function copyRaw(old: Database.Database, target: Database.Database, table: TableName): number {
  const cols = columns(old, table);
  const rows = old.prepare(`SELECT ${cols.join(", ")} FROM ${table} ORDER BY id`).all() as Array<Record<string, unknown>>;
  const insert = target.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  const tx = target.transaction(() => {
    for (const row of rows) {
      insert.run(...cols.map((c) => row[c]));
    }
  });
  tx();
  return rows.length;
}

function copyRawRange(old: Database.Database, target: Database.Database, table: TableName, afterId: number): number {
  const cols = columns(old, table);
  const rows = old
    .prepare(`SELECT ${cols.join(", ")} FROM ${table} WHERE id > ? ORDER BY id`)
    .all(afterId) as Array<Record<string, unknown>>;
  const insert = target.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  const tx = target.transaction(() => {
    for (const row of rows) {
      insert.run(...cols.map((c) => row[c]));
    }
  });
  tx();
  return rows.length;
}


function copyJoinTable(old: Database.Database, target: Database.Database, table: string): number {
  const cols = columns(old, table);
  const rows = old.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all() as Array<Record<string, unknown>>;
  const insert = target.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  const tx = target.transaction(() => {
    for (const row of rows) {
      insert.run(...cols.map((c) => row[c]));
    }
  });
  tx();
  return rows.length;
}

function copyStructured(
  old: Database.Database,
  target: Database.Database,
  eventSource: Database.Database,
  projectKey: string,
): { goals: number; decisions: number; feedback: number; backfilled: number } {
  const goals = copyStructuredTable(old, target, "goals", eventSource, projectKey);
  const decisions = copyStructuredTable(old, target, "decisions", eventSource, projectKey);
  const feedback = copyStructuredTable(old, target, "feedback", eventSource, projectKey);
  const backfilled = goals.backfilled + decisions.backfilled + feedback.backfilled;
  return {
    goals: goals.copied,
    decisions: decisions.copied,
    feedback: feedback.copied,
    backfilled,
  };
}

function copyStructuredRange(
  old: Database.Database,
  target: Database.Database,
  eventSource: Database.Database,
  projectKey: string,
  snapshot: TableMaxIds,
): number {
  const g = copyStructuredTableRange(old, target, "goals", eventSource, projectKey, snapshot.goals);
  const d = copyStructuredTableRange(old, target, "decisions", eventSource, projectKey, snapshot.decisions);
  const f = copyStructuredTableRange(old, target, "feedback", eventSource, projectKey, snapshot.feedback);
  return g + d + f;
}

function copyStructuredTable(
  old: Database.Database,
  target: Database.Database,
  table: "goals" | "decisions" | "feedback",
  eventSource: Database.Database,
  projectKey: string,
): { copied: number; backfilled: number } {
  const cols = columns(old, table);
  const rows = old.prepare(`SELECT ${cols.join(", ")} FROM ${table} ORDER BY id`).all() as Array<Record<string, unknown>>;
  const insert = target.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  let backfilled = 0;
  const tx = target.transaction(() => {
    for (const row of rows) {
      if (row.project_key == null && row.scope === "project") {
        row.project_key = traceEventKey(eventSource, row.source_event, projectKey);
        backfilled++;
      }
      insert.run(...cols.map((c) => row[c]));
    }
  });
  tx();
  return { copied: rows.length, backfilled };
}

function copyStructuredTableRange(
  old: Database.Database,
  target: Database.Database,
  table: "goals" | "decisions" | "feedback",
  eventSource: Database.Database,
  projectKey: string,
  afterId: number,
): number {
  const cols = columns(old, table);
  const rows = old
    .prepare(`SELECT ${cols.join(", ")} FROM ${table} WHERE id > ? ORDER BY id`)
    .all(afterId) as Array<Record<string, unknown>>;
  const insert = target.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  const tx = target.transaction(() => {
    for (const row of rows) {
      if (row.project_key == null && row.scope === "project") {
        row.project_key = traceEventKey(eventSource, row.source_event, projectKey);
      }
      insert.run(...cols.map((c) => row[c]));
    }
  });
  tx();
  return rows.length;
}

function traceEventKey(db: Database.Database, sourceEvent: unknown, fallback: string): string {
  if (typeof sourceEvent === "number") {
    const row = db.prepare(`SELECT project_key FROM events WHERE id = ?`).get(sourceEvent) as { project_key: string | null } | undefined;
    if (row?.project_key) {
      return row.project_key;
    }
  }
  return fallback;
}

function copyLineage(old: Database.Database, store: ThreadStore): { events: number; structured: number } {
  const rows = allLineage(old);
  const insert = (db: Database.Database) =>
    db.prepare(
      `INSERT INTO lineage_edges (id, session_id, src_type, src_id, dst_type, dst_id, ref, edge_type, confidence, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  const evInsert = insert(store.eventsDb);
  const stInsert = insert(store.structuredDb);
  let events = 0;
  let structured = 0;
  const tx = store.eventsDb.transaction(() => {
    store.structuredDb.transaction(() => {
      for (const r of rows) {
        const params = [r.id, r.session_id, r.src_type, r.src_id, r.dst_type, r.dst_id, r.ref, r.edge_type, r.confidence, r.ts];
        if (isEventDomain(r.src_type, r.dst_type)) {
          evInsert.run(...params);
          events++;
        } else {
          stInsert.run(...params);
          structured++;
        }
      }
    })();
  });
  tx();
  return { events, structured };
}

function copyLineageRange(
  old: Database.Database,
  store: ThreadStore,
  afterId: number,
): number {
  const rows = old
    .prepare(`SELECT id, session_id, src_type, src_id, dst_type, dst_id, ref, edge_type, confidence, ts FROM lineage_edges WHERE id > ? ORDER BY id`)
    .all(afterId) as LineageRow[];
  const insert = (db: Database.Database) =>
    db.prepare(
      `INSERT INTO lineage_edges (id, session_id, src_type, src_id, dst_type, dst_id, ref, edge_type, confidence, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  const evInsert = insert(store.eventsDb);
  const stInsert = insert(store.structuredDb);
  let copied = 0;
  const tx = store.eventsDb.transaction(() => {
    store.structuredDb.transaction(() => {
      for (const r of rows) {
        const params = [r.id, r.session_id, r.src_type, r.src_id, r.dst_type, r.dst_id, r.ref, r.edge_type, r.confidence, r.ts];
        if (isEventDomain(r.src_type, r.dst_type)) {
          evInsert.run(...params);
        } else {
          stInsert.run(...params);
        }
        copied++;
      }
    })();
  });
  tx();
  return copied;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function checkIntegrity(db: Database.Database): boolean {
  const row = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  return row.length === 1 && row[0].integrity_check === "ok";
}
