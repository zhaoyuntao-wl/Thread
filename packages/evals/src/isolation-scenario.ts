import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAnalysis, buildStatusCard, ThreadStore } from "@thread/core";
import { queryEvents } from "@thread/core";
import type { CheckResult, ScenarioReport } from "./harness.js";

export function runIsolationScenario(): ScenarioReport {
  const dir = mkdtempSync(join(tmpdir(), "thread-eval-isolation-"));
  const store = new ThreadStore({
    eventsPath: join(dir, "events.db"),
    structuredPath: join(dir, "structured.db"),
    projectKey: "proj-iso",
  });
  const checks: CheckResult[] = [];
  const push = (expectation: string, passed: boolean, detail: string) =>
    checks.push({ expectation, passed, detail });
  try {
    const ts = (i: number) => new Date(new Date("2026-08-15T00:00:00.000Z").getTime() + i * 1000).toISOString();

    // 会话 A（未隔离）：正常共享决策
    applyAnalysis(store, "a-s1", { user_msg: "帮我搭建项目脚手架" }, { ts: ts(0) });
    applyAnalysis(store, "a-s1", { assistant_msg: "我记下了项目用 pnpm" }, { ts: ts(1), origin: "eval://iso/a/1" });
    applyAnalysis(store, "a-s1", { user_msg: "好的" }, { ts: ts(2), origin: "eval://iso/a/2" });

    // 会话 B：进入隔离，写隔离决策 + 共享 tool 事件
    store.setSessionIsolation("b-s1", true);
    applyAnalysis(store, "b-s1", { user_msg: "帮我配置测试框架" }, { ts: ts(3), isolation: true, origin: "eval://iso/b/1" });
    applyAnalysis(store, "b-s1", { assistant_msg: "我记下了测试用 vitest" }, { ts: ts(4), isolation: true, origin: "eval://iso/b/2" });
    applyAnalysis(store, "b-s1", { user_msg: "好的" }, { ts: ts(5), isolation: true, origin: "eval://iso/b/3" });
    store.append(
      { session_id: "b-s1", kind: "tool_call", ts: ts(6), body: "Write 调用参数：b.test.ts", meta: { tool_name: "Write", file_path: "b.test.ts" } },
      { projectKey: "proj-iso", origin: "eval://iso/b/tool/1" },
    );
    store.append(
      { session_id: "b-s1", kind: "tool_result", ts: ts(7), body: "b.test.ts 已创建", meta: { tool_name: "Write", file_path: "b.test.ts" } },
      { projectKey: "proj-iso", origin: "eval://iso/b/tool/2" },
    );

    // 断言 1：A 的合并视图看不到 B 的隔离决策/反馈
    const aDecisions = store.getActiveDecisionsMerged("a-s1", "proj-iso");
    push(
      "A 视图无 B 隔离决策",
      !aDecisions.some((d) => d.text.includes("vitest")),
      aDecisions.map((d) => d.text).join(" | ") || "无",
    );
    const aFeedback = store.getFeedbackMerged("a-s1", "proj-iso", 10);
    push(
      "A 视图无 B 隔离反馈",
      !aFeedback.some((f) => f.text.includes("测试用")),
      aFeedback.map((f) => f.text).join(" | ") || "无",
    );

    // 断言 2：B 隔离状态卡只含自己内容，不含 A 内容
    const bCard = buildStatusCard(store, { sessionId: "b-s1", projectKey: "proj-iso", isolated: true });
    push(
      "B 隔离状态卡含 B 自己的决策",
      bCard.includes("vitest"),
      bCard.split("\n").filter((l) => l.includes("决策") || l.includes("pnpm") || l.includes("vitest")).join("; ").slice(0, 80),
    );
    push(
      "B 隔离状态卡不含 A 的 pnpm",
      !bCard.includes("pnpm"),
      bCard.includes("pnpm") ? "状态卡泄漏 pnpm" : "状态卡干净",
    );

    // 断言 3：项目事实（tool 事件）全局可查（不隔离），对话背景全局不可查（隔离）
    const globalTools = queryEvents(store, { kind: "tool_call" });
    push(
      "B 的 tool 事件全局可查（事实共享）",
      globalTools.results.some((r) => r.body.includes("b.test.ts")),
      globalTools.results.map((r) => r.body.slice(0, 40)).join(" | ") || "无",
    );
    const globalMessages = queryEvents(store, { kind: "user_message" });
    push(
      "B 的隔离对话全局不可查（背景隔离）",
      !globalMessages.results.some((r) => r.body.includes("配置测试框架")),
      globalMessages.results.map((r) => r.body.slice(0, 40)).join(" | "),
    );

    // 断言 4：解除隔离后新内容共享，历史仍隔离
    store.setSessionIsolation("b-s1", false);
    applyAnalysis(store, "b-s1", { assistant_msg: "我记下了 CI 用 GitHub Actions" }, { ts: ts(8), isolation: false, origin: "eval://iso/b/4" });
    applyAnalysis(store, "b-s1", { user_msg: "好的" }, { ts: ts(9), isolation: false, origin: "eval://iso/b/5" });
    const aDecisions2 = store.getActiveDecisionsMerged("a-s1", "proj-iso");
    push(
      "解除后 B 新决策对 A 可见",
      aDecisions2.some((d) => d.text.includes("GitHub Actions")),
      aDecisions2.map((d) => d.text).join(" | "),
    );
    push(
      "解除后 B 历史隔离决策仍对 A 不可见",
      !aDecisions2.some((d) => d.text.includes("vitest")),
      aDecisions2.map((d) => d.text).join(" | "),
    );

    // 断言 5：沉淀——指定转共享后 A 可见
    const vitestRow = store.structuredDb
      .prepare(`SELECT id FROM decisions WHERE session_id = 'b-s1' AND text LIKE '%vitest%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (vitestRow) {
      store.unisolateRow("b-s1", "decisions", vitestRow.id);
    }
    const aDecisions3 = store.getActiveDecisionsMerged("a-s1", "proj-iso");
    push(
      "沉淀后 B 的 vitest 决策对 A 可见",
      Boolean(vitestRow) && aDecisions3.some((d) => d.text.includes("vitest")),
      vitestRow ? aDecisions3.map((d) => d.text).join(" | ") : "未找到 vitest 行",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    scenarioId: "isolation",
    title: "会话隔离：对话上下文仅自己可见、项目事实共享、解除/沉淀可恢复",
    passed: checks.every((c) => c.passed),
    checks,
  };
}
