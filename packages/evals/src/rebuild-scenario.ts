import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAnalysis, applyTurn, ThreadStore } from "@thread-memory/core";
import type { TurnInput } from "@thread-memory/core";
import type { CheckResult, ScenarioReport } from "./harness.js";

type RebuildTurn = TurnInput;

const REBUILD_TURNS: RebuildTurn[] = [
  { user_msg: "帮我实现 API 网关" },
  { assistant_msg: "我记下了网关用 Kong 实现" },
  { user_msg: "好的" },
  { user_msg: "以后测试都用 vitest 写" },
];

const TS = (i: number) => new Date(new Date("2026-08-14T00:00:00.000Z").getTime() + i * 1000).toISOString();

export function runRebuildRecoveryScenario(): ScenarioReport {
  const dir = mkdtempSync(join(tmpdir(), "thread-eval-rebuild-"));
  const eventsPath = join(dir, "events.db");
  const structuredPath = join(dir, "structured.db");
  const checks: CheckResult[] = [];
  let store = new ThreadStore({ eventsPath, structuredPath, projectKey: "proj-rebuild" });
  try {
    REBUILD_TURNS.forEach((t, i) =>
      applyTurn(store, "rebuild-s1", t, { origin: `eval://rebuild/${i}`, ts: TS(i) }),
    );
    const eventsBefore = (store.eventsDb.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
    const decisionsBefore = store.getDecisions("rebuild-s1").length;
    const goalsBefore = store.getActiveGoals("rebuild-s1").length;
    const feedbackBefore = store.getFeedback("rebuild-s1", 10).length;
    store.close();

    // 删除结构化库：事件流水是唯一真相，结构化可重放重建
    rmSync(structuredPath, { force: true });
    store = new ThreadStore({ eventsPath, structuredPath, projectKey: "proj-rebuild" });

    const replay = () =>
      REBUILD_TURNS.forEach((t, i) =>
        applyAnalysis(store, "rebuild-s1", t, { origin: `eval://rebuild/${i}`, ts: TS(i) }),
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
      expectation: "决策行重建恢复（幂等不翻倍）",
      passed: decisionsAfter === decisionsBefore,
      detail: `before=${decisionsBefore} after=${decisionsAfter}`,
    });
    checks.push({
      expectation: "目标行重建恢复",
      passed: goalsAfter === goalsBefore,
      detail: `before=${goalsBefore} after=${goalsAfter}`,
    });
    checks.push({
      expectation: "反馈行重建恢复",
      passed: feedbackAfter === feedbackBefore,
      detail: `before=${feedbackBefore} after=${feedbackAfter}`,
    });
    const kong = store.getActiveDecisions("rebuild-s1").some((d) => d.text.includes("Kong"));
    checks.push({
      expectation: "重建后决策内容保留（Kong active）",
      passed: kong,
      detail: kong ? "Kong 决策已恢复" : "Kong 决策缺失",
    });
    const vitest = store.getFeedback("rebuild-s1", 10).some((f) => f.text.includes("vitest"));
    checks.push({
      expectation: "重建后反馈内容保留（vitest 偏好）",
      passed: vitest,
      detail: vitest ? "vitest 偏好已恢复" : "vitest 偏好缺失",
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    scenarioId: "rebuild-recovery",
    title: "重建恢复：删结构化库后从事件流水重放恢复",
    passed: checks.every((c) => c.passed),
    checks,
  };
}
