import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chronoRank, findStructuredPriority, organizeHits } from "./evidence.js";
import { queryMemory, type QueryHit } from "./query.js";
import { ThreadStore } from "./store.js";

function hit(partial: Partial<QueryHit> & { body: string }): QueryHit {
  return {
    segment_id: 0,
    kind: "user",
    ts: "2026-08-13T00:00:00.000Z",
    seq: 0,
    score: -1,
    ...partial,
  };
}

describe("evidence 组织层（2026-09-02 迭代 A）", () => {
  it("近重复去重：≥0.8 重叠只留分数更好者（同分留新）；0.75 低于阈值保留", () => {
    const hits = [
      hit({ segment_id: 1, body: "登录模块决定使用 Session 认证", score: -3, ts: "2026-08-01T00:00:00.000Z" }),
      hit({ segment_id: 2, body: "登录模块决定使用 Session 认证，不用 JWT", score: -2, ts: "2026-08-02T00:00:00.000Z" }),
      hit({ segment_id: 3, body: "登录模块决定使用 Session 认证", score: -3, ts: "2026-08-03T00:00:00.000Z" }),
    ];
    const out = organizeHits(hits, { limit: 10 });
    // #1 被 #3 去重（同文同分留新）；#2 与 #3 Jaccard=0.75 < 0.8 保留
    expect(out.map((h) => h.segment_id)).toEqual([3, 2]);
  });

  it("MMR 多样性：两个近重复簇 + 一个独立事实，top-2 覆盖两簇", () => {
    const hits = [
      hit({ segment_id: 1, body: "使用 Session 认证方案", score: -4 }),
      hit({ segment_id: 2, body: "认证改用 Session 存储", score: -3.8 }),
      hit({ segment_id: 3, body: "数据库选型定为 SQLite", score: -3.5 }),
    ];
    const out = organizeHits(hits, { limit: 2 });
    expect(out).toHaveLength(2);
    expect(out.some((h) => h.body.includes("Session"))).toBe(true);
    expect(out.some((h) => h.body.includes("SQLite"))).toBe(true);
  });

  it("最新态标注：0.6–0.8 重叠且较新者标 latest", () => {
    const hits = [
      hit({ segment_id: 1, body: "决策：使用 JWT 做认证方案", ts: "2026-08-01T00:00:00.000Z" }),
      hit({ segment_id: 2, body: "决策：使用 JWT 认证的实现方案", ts: "2026-08-05T00:00:00.000Z" }),
    ];
    const out = organizeHits(hits, { limit: 10 });
    const newer = out.find((h) => h.segment_id === 2);
    const older = out.find((h) => h.segment_id === 1);
    expect(newer?.latest).toBe(true);
    expect(older?.latest).toBeUndefined();
  });

  it("行级截断：超长 body 截到 240 字带省略号", () => {
    const out = organizeHits([hit({ body: "长正文".repeat(200) })], { limit: 10, maxBodyChars: 240 });
    expect(out[0].body.length).toBe(241);
    expect(out[0].body.endsWith("…")).toBe(true);
  });

  it("chrono 加权：近分平局近期优先，大分差保持真实相关度", () => {
    const now = new Date("2026-08-10T00:00:00.000Z").getTime();
    const hits = [
      hit({ segment_id: 1, body: "旧事实", score: -3, ts: "2026-07-01T00:00:00.000Z" }),
      hit({ segment_id: 2, body: "新事实", score: -3, ts: "2026-08-09T00:00:00.000Z" }),
      hit({ segment_id: 3, body: "强相关旧事实", score: -8, ts: "2026-07-01T00:00:00.000Z" }),
    ];
    const out = chronoRank(hits, now);
    // 新事实（近）排旧事实前；强相关旧事实仍居首（加权上限 1.0 不淹没 -8 vs -3 差距）
    expect(out[0].segment_id).toBe(3);
    expect(out[1].segment_id).toBe(2);
    expect(out[2].segment_id).toBe(1);
  });

  it("结构化行优先：查询命中决策行 → 带状态语义置顶；未命中阈值不触发", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-evid-"));
    const store = new ThreadStore({
      eventsPath: join(dir, "events.db"),
      structuredPath: join(dir, "structured.db"),
      projectKey: "evid-proj",
    });
    try {
      const d1 = store.addDecision("s1", "使用 JWT 做认证", { projectKey: "evid-proj" });
      store.supersedeDecisionById("s1", d1.id, "改用 Session 认证");
      const hits = findStructuredPriority(store, "Session 认证 方案", "s1", "evid-proj");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].body).toContain("【生效决策");
      expect(hits[0].body).toContain("Session");
      const none = findStructuredPriority(store, "数据库 选型", "s1", "evid-proj");
      expect(none).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queryMemory organize 集成：事件路径 0 命中时结构化行救回（决策只在 decisions 表）", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-evid-"));
    const store = new ThreadStore({
      eventsPath: join(dir, "events.db"),
      structuredPath: join(dir, "structured.db"),
      projectKey: "evid-proj",
    });
    try {
      store.addDecision("s1", "网关用 Kong 实现", { projectKey: "evid-proj" });
      // 事件流水空 → 裸检索 0 命中；organize 结构化行优先救回
      const bare = queryMemory(store, "Kong 网关", { sessionId: "s1" });
      expect(bare.status).toBe("not-found");
      const organized = queryMemory(store, "Kong 网关", { sessionId: "s1", organize: true, projectKey: "evid-proj" });
      expect(organized.status).toBe("found");
      expect(organized.results[0].structured).toBe("decisions");
      expect(organized.results[0].body).toContain("生效决策");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
