import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_VERSION } from "./schema.js";
import { ThreadStore } from "./store.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-migrate-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("schema 迁移", () => {
  // 2026-11-13 线上故障回归：handoffs 表加了但 SCHEMA_VERSION 没升，
  // 已盖到旧版本的真实库被 ensureSchema 的快速短路跳过 → /thread-panel 报 no such table: handoffs。
  it("旧库（盖到上一版本、无 handoffs 表）打开后补建 handoffs", () => {
    const structuredPath = join(dir, "old-structured.db");
    const legacy = new Database(structuredPath);
    legacy.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)`);
    legacy.exec(`INSERT INTO schema_version (version, applied_at) VALUES (${SCHEMA_VERSION - 1}, '2026-11-01T00:00:00.000Z')`);
    legacy.close();

    const probe = new Database(structuredPath);
    const before = probe.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='handoffs'`).all();
    probe.close();
    expect(before).toHaveLength(0);

    const store = new ThreadStore({ eventsPath: join(dir, "old-events.db"), structuredPath, projectKey: "migrate-proj" });
    try {
      expect(store.listHandoffs({ projectKey: "migrate-proj" })).toEqual([]);
    } finally {
      store.close();
    }
  });
});
