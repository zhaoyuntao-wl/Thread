import { describe, expect, it } from "vitest";
import { buildQuerySuggestions, MEMORY_BOUNDARY, suggestionsFrom } from "./metaknowledge.js";

describe("metaknowledge 边界标注（2026-09-02 迭代 B）", () => {
  it("buildQuerySuggestions：取 stopword 过滤后的前 2 实义词，零语义判定", () => {
    const q = buildQuerySuggestions("登录模块决定使用 Session 认证");
    expect(q.length).toBeGreaterThan(0);
    expect(q.split(" ").length).toBeLessThanOrEqual(2);
  });

  it("buildQuerySuggestions：纯停用词/空文本 → 空建议（不硬造）", () => {
    expect(buildQuerySuggestions("")).toBe("");
  });

  it("suggestionsFrom：去重 + 上限 3 + query= 格式", () => {
    const rows = [
      { text: "登录模块决定使用 Session 认证" },
      { text: "登录模块决定使用 Session 认证" },
      { text: "数据库选型定为 SQLite" },
      { text: "CI 用 GitHub Actions" },
      { text: "部署走三刷新" },
    ];
    const out = suggestionsFrom(rows);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out[0].startsWith("query='")).toBe(true);
    expect(new Set(out).size).toBe(out.length);
  });

  it("MEMORY_BOUNDARY：静态声明含三要素（知道/不知道/需要查）", () => {
    expect(MEMORY_BOUNDARY).toContain("记忆边界");
    expect(MEMORY_BOUNDARY).toContain("query_session_memory");
    expect(MEMORY_BOUNDARY).toContain("未记录内容不在记忆内");
  });
});
