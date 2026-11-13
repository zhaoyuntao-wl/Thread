import { describe, expect, it } from "vitest";
import { CURATED_STEP, type RunSample, renderReport, scoreAnswer, summarize } from "./score.js";

function sample(patch: Partial<RunSample>): RunSample {
  return { arm: "push", recall: false, curated: false, stale: false, queries: 0, delivered: 0, seconds: 0, ...patch };
}

describe("scoreAnswer", () => {
  it("识别召回技术名（大小写不敏感）", () => {
    expect(scoreAnswer("Q1：BM25 + FTS5").recall).toBe(true);
    expect(scoreAnswer("Q1：bm25").recall).toBe(true);
    expect(scoreAnswer("Q1：向量库").recall).toBe(false);
  });

  it("区分策展的下一步与旧计划", () => {
    expect(scoreAnswer(`${CURATED_STEP}。`).curated).toBe(true);
    expect(scoreAnswer("重构检索层（旧计划，尚未确认）").stale).toBe(true);
    expect(scoreAnswer("重构检索层").curated).toBe(false);
  });

  it("空回答不得分", () => {
    expect(scoreAnswer("")).toEqual({ recall: false, curated: false, stale: false });
  });
});

describe("summarize", () => {
  it("按臂聚合计数与均值", () => {
    const rows = [
      sample({ arm: "push", recall: true, curated: true, queries: 1, delivered: 1, seconds: 7 }),
      sample({ arm: "push", recall: true, curated: true, queries: 3, delivered: 1, seconds: 9 }),
      sample({ arm: "memory", recall: true, queries: 6, seconds: 15 }),
      sample({ arm: "none", queries: 4, seconds: 12 }),
    ];
    const summary = summarize(rows);
    expect(summary.push).toMatchObject({ n: 2, recall: 2, curated: 2, delivered: 2, avgQueries: 2, avgSeconds: 8 });
    expect(summary.memory).toMatchObject({ n: 1, recall: 1, curated: 0, avgQueries: 6 });
    expect(summary.none).toMatchObject({ n: 1, recall: 0, avgQueries: 4 });
  });

  it("空样本不抛错", () => {
    const summary = summarize([]);
    expect(summary.push.n).toBe(0);
    expect(summary.push.avgQueries).toBe(0);
  });
});

describe("renderReport", () => {
  it("输出三臂对照表并带读法说明", () => {
    const report = renderReport(summarize([sample({ recall: true, curated: true, delivered: 1 })]), 1);
    expect(report).toContain("| 推送交接 | 有记忆不推送 | 无 Thread |");
    expect(report).toContain("召回已定方案");
    expect(report).toContain("读法");
  });
});
