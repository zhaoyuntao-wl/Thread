import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashProjectKey, migrateSplit, ThreadStore } from "@thread-memory/core";
import type { CheckResult, ScenarioReport } from "./harness.js";

const OLD_SCHEMA = `CREATE TABLE events (
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
INSERT INTO lineage_edges (id, session_id, src_type, src_id, dst_type, dst_id, ref, edge_type, ts) VALUES (2, 's1', 'goal', 1, 'event', 1, NULL, 'derived_from', '2026-08-14T00:00:00.000Z');`;

export function runMigrationLosslessScenario(): ScenarioReport {
  const dir = mkdtempSync(join(tmpdir(), "thread-eval-migrate-"));
  const oldPath = join(dir, "sms.db");
  const root = join(dir, "thread-root");
  const PK = "d:/test/proj";
  const checks: CheckResult[] = [];
  let store: ThreadStore | undefined;
  try {
    const old = new Database(oldPath);
    old.exec(OLD_SCHEMA);
    old.close();

    const result = migrateSplit({ oldPath, root, projectKey: PK, dryRun: false });

    const push = (expectation: string, passed: boolean, detail: string) =>
      checks.push({ expectation, passed, detail });

    push(
      "事件全量复制 + NULL project_key 回填",
      result.events.copied === 2 && result.events.backfilled === 1,
      `copied=${result.events.copied} backfilled=${result.events.backfilled}`,
    );
    push(
      "结构化行复制 + project 回填（global 保持 NULL）",
      result.structured.goals === 1 && result.structured.feedback === 1 && result.structured.backfilled === 1,
      `goals=${result.structured.goals} feedback=${result.structured.feedback} backfilled=${result.structured.backfilled}`,
    );
    push(
      "双库完整性检查 ok",
      result.integrity.events && result.integrity.structured,
      `events=${result.integrity.events} structured=${result.integrity.structured}`,
    );
    const eventsPath = join(root, "projects", hashProjectKey(PK), "events.db");
    const structuredPath = join(root, "structured.db");
    push(
      "新库文件落盘 + 旧库备份",
      existsSync(eventsPath) && existsSync(structuredPath) && existsSync(`${oldPath}.bak-b4`),
      `events=${existsSync(eventsPath)} structured=${existsSync(structuredPath)} backup=${existsSync(`${oldPath}.bak-b4`)}`,
    );

    store = new ThreadStore({ eventsPath, structuredPath });
    const ev = store.eventsDb.prepare("SELECT project_key FROM events WHERE id = 1").get() as { project_key: string };
    push("事件行回填列值 = 规范化项目键", ev.project_key === PK, `project_key=${ev.project_key}`);
    const goal = store.structuredDb.prepare("SELECT project_key, scope FROM goals WHERE id = 1").get() as { project_key: string; scope: string };
    push("结构化 goal 回填 project + scope", goal.project_key === PK && goal.scope === "project", `key=${goal.project_key} scope=${goal.scope}`);
    const fb = store.structuredDb.prepare("SELECT project_key, scope FROM feedback WHERE id = 1").get() as { project_key: string | null; scope: string };
    push("global 反馈保持 NULL + scope=global", fb.project_key === null && fb.scope === "global", `key=${fb.project_key} scope=${fb.scope}`);
    push("迁移后事件血缘可查", store.getEventsForFile("s1", "a.ts").length === 1, `edges=${store.getEventsForFile("s1", "a.ts").length}`);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    scenarioId: "migration-lossless",
    title: "迁移无损：单库 → 双库 复制+回填+完整性",
    passed: checks.every((c) => c.passed),
    checks,
  };
}
