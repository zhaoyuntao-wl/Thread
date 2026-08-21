import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAnalysis, applyTurn, queryEvents, ThreadStore } from "@thread-memory/core";
import type { TurnInput } from "@thread-memory/core";
import type { CheckResult, ScenarioReport } from "./harness.js";

// 2026-08-21 结构通道化后的重建语义：applyAnalysis 只重建目标行；决策/反馈是显式通道行
// （record_decision 工具 / thread-feedback 命令），不在 core 分析层重放范围——
// 原文在事件流水（真相源），可 query_session_memory 回拉或重录。此场景断言该诚实边界。
const GOAL_TURNS: TurnInput[] = [{ user_msg: "帮我实现 API 网关" }];

const TS = (i: number) => new Date(new Date("2026-08-14T00:00:00.000Z").getTime() + i * 1000).toISOString();

export function runRebuildRecoveryScenario(): ScenarioReport {
  const dir = mkdtempSync(join(tmpdir(), "thread-eval-rebuild-"));
  const eventsPath = join(dir, "events.db");
  const structuredPath = join(dir, "structured.db");
  const checks: CheckResult[] = [];
  let store = new ThreadStore({ eventsPath, structuredPath, projectKey: "proj-rebuild" });
  try {
    GOAL_TURNS.forEach((t, i) =>
      applyTurn(store, "rebuild-s1", t, { origin: `eval://rebuild/g/${i}`, ts: TS(i) }),
    );
    // 显式通道行：决策（record_decision 工具事件 + 行）+ 反馈（命令事件 + 行）
    const decEvent = store.append({
      session_id: "rebuild-s1",
      kind: "tool_call",
      ts: TS(10),
      body: 'record_decision 调用参数：{"text":"网关用 Kong 实现"}',
      meta: { tool_name: "record_decision" },
    });
    store.addDecision("rebuild-s1", "网关用 Kong 实现", { sourceEvent: decEvent.id, ts: TS(10), projectKey: "proj-rebuild" });
    store.append({
      session_id: "rebuild-s1",
      kind: "user_message",
      ts: TS(11),
      body: "/thread-reg fdb 测试都用 vitest 写",
    });
    store.addFeedback("rebuild-s1", "测试都用 vitest 写", "preference", { ts: TS(11), projectKey: "proj-rebuild" });

    const eventsBefore = (store.eventsDb.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
    const decisionsBefore = store.getDecisions("rebuild-s1").length;
    const goalsBefore = store.getActiveGoals("rebuild-s1").length;
    const feedbackBefore = store.getFeedback("rebuild-s1", 10).length;
    store.close();

    // 删除结构化库：事件流水是唯一真相，结构化可重放重建
    rmSync(structuredPath, { force: true });
    store = new ThreadStore({ eventsPath, structuredPath, projectKey: "proj-rebuild" });

    const replay = () =>
      GOAL_TURNS.forEach((t, i) =>
        applyAnalysis(store, "rebuild-s1", t, { origin: `eval://rebuild/g/${i}`, ts: TS(i) }),
      );
    replay();
    replay(); // 幂等：重放可重复执行

    const eventsAfter = (store.eventsDb.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
    const decisionsAfter = store.getDecisions("rebuild-s1").length;
    const goalsAfter = store.getActiveGoals("rebuild-s1").length;
    const feedbackAfter = store.getFeedback("rebuild-s1", 10).length;

    checks.push({
      expectation: "事件流水零重复（重建不写事件）",
      passed: eventsAfter === eventsBefore,
      detail: `before=${eventsBefore} after=${eventsAfter}`,
    });
    checks.push({
      expectation: "目标行重建恢复（幂等不翻倍）",
      passed: goalsAfter === goalsBefore && goalsAfter > 0,
      detail: `before=${goalsBefore} after=${goalsAfter}`,
    });
    checks.push({
      expectation: "显式通道行不自动重建（决策/反馈为 0，核心重放范围 = 目标）",
      passed: decisionsAfter === 0 && decisionsBefore > 0 && feedbackAfter === 0 && feedbackBefore > 0,
      detail: `decisions before=${decisionsBefore} after=${decisionsAfter}；feedback before=${feedbackBefore} after=${feedbackAfter}`,
    });
    // 原文在事件流水可回拉：tool_call 含决策参数、user_message 含反馈命令
    const toolCalls = queryEvents(store, { sessionId: "rebuild-s1", kind: "tool_call" });
    const kongInEvents = toolCalls.results.some((r) => r.body.includes("网关用 Kong 实现"));
    checks.push({
      expectation: "决策原文在事件流水可回拉（Kong 在 tool_call）",
      passed: kongInEvents,
      detail: kongInEvents ? "tool_call 命中 Kong" : "tool_call 未见 Kong",
    });
    const messages = queryEvents(store, { sessionId: "rebuild-s1", kind: "user_message" });
    const vitestInEvents = messages.results.some((r) => r.body.includes("测试都用 vitest 写"));
    checks.push({
      expectation: "反馈原文在事件流水可回拉（vitest 在命令消息）",
      passed: vitestInEvents,
      detail: vitestInEvents ? "命令消息命中 vitest" : "命令消息未见 vitest",
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    scenarioId: "rebuild-recovery",
    title: "重建恢复：删结构化库后目标重放恢复；显式通道行原文事件流回拉（2026-08-21 边界）",
    passed: checks.every((c) => c.passed),
    checks,
  };
}
