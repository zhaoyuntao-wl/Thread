import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "./store.js";
import { hashProjectKey } from "./project-key.js";
import { locateSession } from "./locate.js";

describe("locateSession（会话 → 项目桶定位，2026-10-07 D2）", () => {
  it("在两个桶中定位到会话所属的那个，并带回该桶的 project_key", () => {
    const root = mkdtempSync(join(tmpdir(), "thread-locate-"));
    try {
      // better-sqlite3 不建父目录（插件侧负责 mkdir），测试同样先建桶目录
      for (const key of ["proj-a", "proj-b"]) {
        mkdirSync(join(root, "projects", hashProjectKey(key)), { recursive: true });
      }
      const a = new ThreadStore({
        eventsPath: join(root, "projects", hashProjectKey("proj-a"), "events.db"),
        structuredPath: join(root, "structured.db"),
        projectKey: "proj-a",
      });
      const b = new ThreadStore({
        eventsPath: join(root, "projects", hashProjectKey("proj-b"), "events.db"),
        structuredPath: join(root, "structured.db"),
        projectKey: "proj-b",
      });
      try {
        a.append({ session_id: "s-a", kind: "user_message", ts: new Date().toISOString(), body: "a" });
        b.append({ session_id: "s-b", kind: "user_message", ts: new Date().toISOString(), body: "b" });
        const found = locateSession(root, "s-b");
        expect(found?.projectKey).toBe("proj-b");
        expect(found?.bucket).toBe(hashProjectKey("proj-b"));
        expect(found?.eventsPath).toContain(join("projects", hashProjectKey("proj-b")));
      } finally {
        a.close();
        b.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("未知会话 → undefined（调用方降级默认桶）；无 projects 目录不抛", () => {
    const root = mkdtempSync(join(tmpdir(), "thread-locate-empty-"));
    try {
      expect(locateSession(root, "nope")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
