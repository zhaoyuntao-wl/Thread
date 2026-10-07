import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "./store.js";

// 2026-10-07 跨工作区串桶修复下半场：同一桶内的历史误键行不得出现在本项目检索结果里，
// 但显式点名会话时该会话的行必须仍可查（"查这个会话的历史"不能被作用域过滤掉）。
describe("search 项目作用域过滤（同桶历史误键行）", () => {
  it("本项目查询不返回别的工作区的行；点名会话时该会话行仍可见", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-search-scope-"));
    const store = new ThreadStore({
      eventsPath: join(dir, "events.db"),
      structuredPath: join(dir, "structured.db"),
      projectKey: "d:/proj/right",
    });
    try {
      store.append({
        session_id: "s-right",
        kind: "user_message",
        ts: "2026-10-07T10:00:00.000Z",
        body: "灯罩报价模板 归属正确项目",
      });
      store.append({
        session_id: "s-wrong",
        kind: "user_message",
        ts: "2026-10-07T10:01:00.000Z",
        body: "灯罩报价模板 历史误键行",
      }, { projectKey: "e:/other/proj" });
      // 旧行（无 project_key）不因过滤而消失
      store.eventsDb.prepare("UPDATE events SET project_key = NULL WHERE session_id = 's-old'").run();
      store.append({
        session_id: "s-old",
        kind: "user_message",
        ts: "2026-10-07T10:02:00.000Z",
        body: "灯罩报价模板 存量无键行",
      }, { projectKey: undefined });

      const scoped = store.search("灯罩报价模板", { limit: 10 });
      const sessions = scoped.map((h) => h.session_id).sort();
      expect(sessions).toContain("s-right");
      expect(sessions).toContain("s-old");
      expect(sessions).not.toContain("s-wrong");

      // 显式点名误键会话：该会话的行放行
      const named = store.search("灯罩报价模板", { limit: 10, sessionId: "s-wrong" });
      expect(named.map((h) => h.session_id)).toContain("s-wrong");

      // 无 projectKey 的库（未声明作用域）行为不变：全都可见
      const unscoped = new ThreadStore({
        eventsPath: join(dir, "events.db"),
        structuredPath: join(dir, "structured.db"),
      });
      try {
        expect(unscoped.search("灯罩报价模板", { limit: 10 }).map((h) => h.session_id)).toContain("s-wrong");
      } finally {
        unscoped.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
