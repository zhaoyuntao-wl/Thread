import { describe, expect, it } from "vitest";
import { cjkSpace, segment, segmentQuery } from "./segment.js";

describe("segment（0-e：jieba 预分词 shadow 列）", () => {
  it("中文按词切分（词级，非单字）", () => {
    const out = segment("登录方案改成JWT部署到周五");
    expect(out).toContain("登录");
    expect(out).toContain("方案");
    expect(out).not.toContain("登 录"); // 不再是单字空格
  });

  it("过滤纯标点 token（、，：等不进索引）", () => {
    const out = segment("决策不丢、目标不漂移、不重复提问");
    expect(out.split(/\s+/)).not.toContain("、");
  });

  it("英文/数字保持空格分词", () => {
    const out = segment("run the full test suite with JWT");
    expect(out).toContain("JWT");
  });

  it("降级路径：cjkSpace 单字空格（jieba 不可用时兜底）", () => {
    expect(cjkSpace("登录方案")).toBe("登 录 方 案");
    expect(segment("")).toBe("");
  });
});

describe("segmentQuery（查询侧对称分词）", () => {
  it("中文查询切为词 token", () => {
    const tokens = segmentQuery("登录方案怎么定的");
    expect(tokens).toContain("登录");
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("英文查询保持词级", () => {
    expect(segmentQuery("how does auth work")).toContain("auth");
  });

  it("空查询 → 空 token 列表", () => {
    expect(segmentQuery("")).toEqual([]);
    expect(segmentQuery("   ")).toEqual([]);
  });
});
