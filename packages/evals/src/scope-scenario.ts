import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTurn, ThreadStore } from "@thread/core";
import type { CheckResult, ScenarioReport } from "./harness.js";

export function runScopeFilterScenario(): ScenarioReport {
  const dir = mkdtempSync(join(tmpdir(), "thread-eval-scope-"));
  const store = new ThreadStore({
    eventsPath: join(dir, "events.db"),
    structuredPath: join(dir, "structured.db"),
    projectKey: "proj-p1",
  });
  const checks: CheckResult[] = [];
  try {
    applyTurn(store, "p1-s1", { user_msg: "帮我搭建项目脚手架" }, { ts: "2026-08-14T00:00:00.000Z" });
    applyTurn(store, "p1-s1", { assistant_msg: "我记下了本项目用 pnpm 管理依赖" }, { ts: "2026-08-14T00:00:01.000Z" });
    applyTurn(store, "p1-s1", { user_msg: "好的" }, { ts: "2026-08-14T00:00:02.000Z" });
    applyTurn(
      store,
      "p1-s1",
      { user_msg: "以后统一用 TypeScript" },
      { scope: "global", ts: "2026-08-14T00:00:03.000Z" },
    );

    const p1Decisions = store.getActiveDecisionsMerged("p1-s1", "proj-p1");
    const p1HasPnpm = p1Decisions.some((d) => d.text.includes("pnpm"));
    checks.push({
      expectation: "P1 合并视图含项目决策 pnpm",
      passed: p1HasPnpm,
      detail: p1HasPnpm ? `命中: ${p1Decisions.map((d) => d.text).join(" | ")}` : "P1 视图未含 pnpm",
    });

    const p2Decisions = store.getActiveDecisionsMerged("p2-s1", "proj-p2");
    const p2LeaksPnpm = p2Decisions.some((d) => d.text.includes("pnpm"));
    checks.push({
      expectation: "P2 合并视图零泄漏（无 pnpm 项目决策）",
      passed: !p2LeaksPnpm,
      detail: p2LeaksPnpm ? `泄漏: ${p2Decisions.map((d) => d.text).join(" | ")}` : "P2 视图干净",
    });

    const p2Feedback = store.getFeedbackMerged("p2-s1", "proj-p2", 10);
    const p2SeesGlobal = p2Feedback.some((f) => f.text.includes("TypeScript"));
    checks.push({
      expectation: "全局反馈在 P2 可见（global 跨项目共享）",
      passed: p2SeesGlobal,
      detail: p2SeesGlobal ? `命中: ${p2Feedback.map((f) => f.text).join(" | ")}` : "P2 未看到全局反馈",
    });

    const p2Goals = store.getActiveGoalsMerged("p2-s1", "proj-p2");
    checks.push({
      expectation: "P2 目标视图零泄漏（无 P1 项目目标）",
      passed: !p2Goals.some((g) => g.text.includes("脚手架")),
      detail: `P2 目标: ${p2Goals.map((g) => g.text).join(" | ") || "无"}`,
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    scenarioId: "scope-filter",
    title: "作用域过滤：跨项目零泄漏 + 全局反馈共享",
    passed: checks.every((c) => c.passed),
    checks,
  };
}
