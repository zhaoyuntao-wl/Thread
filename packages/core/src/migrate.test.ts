import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashProjectKey } from "./project-key.js";
import { migrateSplit, replayIncrement, snapshotTableMaxIds } from "./migrate.js";
import { ThreadStore } from "./store.js";

let dir: string;
let oldPath: string;
let root: string;
let store: ThreadStore;
let eventsPath: string;
let structuredPath: string;

const PK = "d:/test/proj";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-migrate-b4-"));
  oldPath = join(dir, "sms.db");
  root = join(dir, "thread-root");

  // 构造现网形态旧单库：v2 schema + NULL project_key 旧行 + 事件/结构化/血缘
  const old = new Database(oldPath);
  old.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL,
    ts TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, meta TEXT,
    truncated INTEGER NOT NULL DEFAULT 0, project_key TEXT, scope TEXT NOT NULL DEFAULT 'project',
    origin TEXT, spilled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, seq_start INTEGER NOT NULL, seq_end INTEGER, status TEXT NOT NULL DEFAULT 'active', summary TEXT, created_at TEXT NOT NULL);
  CREATE TABLE spills (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, ref TEXT NOT NULL, blob TEXT, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', source_event INTEGER, created_at TEXT NOT NULL, project_key TEXT, scope TEXT NOT NULL DEFAULT 'project', origin TEXT);
  CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', superseded_by INTEGER, source_event INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, project_key TEXT, scope TEXT NOT NULL DEFAULT 'project', origin TEXT);
  CREATE TABLE feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'preference', source_event INTEGER, created_at TEXT NOT NULL, project_key TEXT, scope TEXT NOT NULL DEFAULT 'project', origin TEXT);
  CREATE TABLE lineage_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, src_type TEXT NOT NULL, src_id INTEGER, dst_type TEXT NOT NULL, dst_id INTEGER, ref TEXT, edge_type TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, ts TEXT NOT NULL);
  CREATE TABLE entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL);
  CREATE TABLE decision_entities (decision_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, edge TEXT NOT NULL DEFAULT 'references', ts TEXT NOT NULL, PRIMARY KEY (decision_id, entity_id));
  CREATE TABLE metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, name TEXT NOT NULL, value REAL NOT NULL, ts TEXT NOT NULL);
  INSERT INTO events (id, session_id, kind, ts, seq, body, project_key, origin) VALUES (1, 's1', 'user_message', '2026-08-14T00:00:00.000Z', 1, '旧事件无键', NULL, NULL);
  INSERT INTO events (id, session_id, kind, ts, seq, body, project_key, origin) VALUES (2, 's1', 'tool_call', '2026-08-14T00:00:01.000Z', 2, 'edit a.ts', 'd:/test/proj', 'qoder://transcript#t1');
  INSERT INTO episodes (id, session_id, seq_start, status, created_at) VALUES (1, 's1', 1, 'active', '2026-08-14T00:00:00.000Z');
  INSERT INTO spills (id, event_id, ref, blob, sha256, created_at) VALUES (1, 2, 'spill:2', '原文大块', 'abc', '2026-08-14T00:00:01.000Z');
  INSERT INTO goals (id, session_id, text, status, source_event, created_at, project_key, scope, origin) VALUES (1, 's1', '旧目标', 'active', 1, '2026-08-14T00:00:00.000Z', NULL, 'project', NULL);
  INSERT INTO feedback (id, session_id, text, kind, source_event, created_at, project_key, scope, origin) VALUES (1, 's1', '全局偏好', 'preference', 1, '2026-08-14T00:00:00.000Z', NULL, 'global', NULL);
  INSERT INTO lineage_edges (id, session_id, src_type, src_id, dst_type, dst_id, ref, edge_type, ts) VALUES (1, 's1', 'event', 2, 'file', NULL, 'a.ts', 'touches_file', '2026-08-14T00:00:01.000Z');
  INSERT INTO lineage_edges (id, session_id, src_type, src_id, dst_type, dst_id, ref, edge_type, ts) VALUES (2, 's1', 'goal', 1, 'event', 1, NULL, 'derived_from', '2026-08-14T00:00:00.000Z');
  `);
  old.close();
});

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("B④ migrateSplit", () => {
  it("splits single db into structured + project event db with backfill and checks", () => {
    const result = migrateSplit({ oldPath, root, projectKey: PK, dryRun: false });

    expect(result.projectKey).toBe(PK);
    // 事件回填：1 行 NULL → PK
    expect(result.events.copied).toBe(2);
    expect(result.events.backfilled).toBe(1);
    // 结构化回填：goal NULL project → 追溯 source_event(1) 无键 → PK；feedback global 留 NULL
    expect(result.structured.goals).toBe(1);
    expect(result.structured.feedback).toBe(1);
    expect(result.structured.backfilled).toBe(1);
    // 血缘按域拆分
    expect(result.lineage.events).toBe(1);
    expect(result.lineage.structured).toBe(1);
    expect(result.integrity.events).toBe(true);
    expect(result.integrity.structured).toBe(true);

    eventsPath = join(root, "projects", hashProjectKey(PK), "events.db");
    structuredPath = join(root, "structured.db");
    expect(existsSync(eventsPath)).toBe(true);
    expect(existsSync(structuredPath)).toBe(true);

    store = new ThreadStore({ eventsPath, structuredPath });
    // 事件回填正确（列值 = 规范化路径，不是 hash）
    const ev = store.eventsDb.prepare("SELECT project_key FROM events WHERE id = 1").get() as { project_key: string };
    expect(ev.project_key).toBe(PK);
    // 结构化回填正确
    const goal = store.structuredDb.prepare("SELECT project_key, scope FROM goals WHERE id = 1").get() as { project_key: string; scope: string };
    expect(goal.project_key).toBe(PK);
    expect(goal.scope).toBe("project");
    const fb = store.structuredDb.prepare("SELECT project_key, scope FROM feedback WHERE id = 1").get() as { project_key: string | null; scope: string };
    expect(fb.project_key).toBeNull();
    expect(fb.scope).toBe("global");
    // 血缘分库正确
    expect(store.getEventsForFile("s1", "a.ts").length).toBe(1);
    expect(store.getRelatedEdges("s1", "goal", 1).some((r) => r.edge_type === "derived_from")).toBe(true);
    // 旧库备份
    expect(existsSync(`${oldPath}.bak-b4`)).toBe(true);
  });

  it("replays increment after snapshot (零差异)", () => {
    // 迁移前快照（此时旧库 max(events.id)=2）
    const snapshot = snapshotTableMaxIds(oldPath);
    expect(snapshot.events).toBe(2);
    expect(snapshot.feedback).toBe(1);

    // 快照后旧库新增事件 + 结构化行
    const old = new Database(oldPath);
    old.exec(`INSERT INTO events (id, session_id, kind, ts, seq, body, project_key, origin) VALUES (3, 's2', 'user_message', '2026-08-14T00:00:02.000Z', 1, '增量事件', 'd:/test/proj', 'qoder://transcript#t2');
    INSERT INTO feedback (id, session_id, text, kind, source_event, created_at, project_key, scope, origin) VALUES (2, 's2', '增量反馈', 'preference', 3, '2026-08-14T00:00:02.000Z', NULL, 'project', NULL);
    INSERT INTO lineage_edges (id, session_id, src_type, src_id, dst_type, dst_id, ref, edge_type, ts) VALUES (3, 's2', 'event', 3, 'file', NULL, 'b.ts', 'touches_file', '2026-08-14T00:00:02.000Z');`);
    old.close();

    const replayed = replayIncrement(oldPath, root, PK, snapshot);

    expect(replayed.events).toBe(1);
    store.close();
    store = new ThreadStore({ eventsPath, structuredPath });
    const total = store.eventsDb.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    expect(total.c).toBe(3);
    const fb = store.structuredDb.prepare("SELECT project_key FROM feedback WHERE id = 2").get() as { project_key: string };
    expect(fb.project_key).toBe(PK);
    expect(store.getEventsForFile("s2", "b.ts").length).toBe(1);
  });
});
