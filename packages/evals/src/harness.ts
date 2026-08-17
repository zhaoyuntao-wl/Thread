import { applyTurn, buildStatusCard, queryMemory, ThreadStore } from "@thread-memory/core";
import type { Scenario, ScenarioExpectation } from "./scenarios.js";

export interface CheckResult {
  expectation: string;
  passed: boolean;
  detail: string;
}

export interface ScenarioReport {
  scenarioId: string;
  title: string;
  passed: boolean;
  checks: CheckResult[];
}

const BASE_TS = "2026-08-13T00:00:00.000Z";

export function runScenario(store: ThreadStore, scenario: Scenario): ScenarioReport {
  const sessionId = `eval-${scenario.id}`;
  let t = 0;
  const nextTs = () => new Date(new Date(BASE_TS).getTime() + t++ * 1000).toISOString();

  for (const turn of scenario.turns) {
    if (turn.user) {
      applyTurn(store, sessionId, { user_msg: turn.user }, { ts: nextTs() });
    }
    if (turn.assistant) {
      applyTurn(store, sessionId, { assistant_msg: turn.assistant }, { ts: nextTs() });
    }
    if (turn.tool) {
      const tool = turn.tool;
      const event = store.append({
        session_id: sessionId,
        kind: "tool_call",
        ts: nextTs(),
        body: `${tool.name} 调用参数：${JSON.stringify(tool.input).slice(0, 500)}`,
        meta: { tool_name: tool.name, file_path: tool.file_path, tool_input: tool.input },
      });
      if (tool.output) {
        store.append({
          session_id: sessionId,
          kind: "tool_result",
          ts: nextTs(),
          body: tool.output,
          meta: { tool_name: tool.name, file_path: tool.file_path },
        });
      }
      void event;
    }
    if (turn.compact) {
      store.append({
        session_id: sessionId,
        kind: "compact_checkpoint",
        ts: nextTs(),
        body: turn.compact,
        meta: { trigger: "eval" },
      });
    }
  }

  const checks: CheckResult[] = scenario.expectations.map((exp) =>
    checkExpectation(store, sessionId, exp),
  );
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    passed: checks.every((c) => c.passed),
    checks,
  };
}

export function runAll(
  store: ThreadStore,
  scenarios: Scenario[],
): { reports: ScenarioReport[]; passed: boolean } {
  const reports = scenarios.map((s) => runScenario(store, s));
  return { reports, passed: reports.every((r) => r.passed) };
}

function checkExpectation(
  store: ThreadStore,
  sessionId: string,
  exp: ScenarioExpectation,
): CheckResult {
  switch (exp.kind) {
    case "goal": {
      const goals = store.getActiveGoals(sessionId);
      const hit = goals.find((g) => g.text.includes(exp.contains));
      return {
        expectation: `goal contains "${exp.contains}"`,
        passed: Boolean(hit),
        detail: hit ? `命中: ${hit.text}` : `未命中，现有目标: ${goals.map((g) => g.text).join(" | ") || "无"}`,
      };
    }
    case "decision": {
      const decisions = store.getDecisions(sessionId, exp.status);
      const hit = decisions.find((d) => d.text.includes(exp.contains));
      return {
        expectation: `decision "${exp.contains}" is ${exp.status}`,
        passed: Boolean(hit),
        detail: hit
          ? `命中: #${hit.id} ${hit.text}`
          : `未命中，${exp.status} 决策: ${decisions.map((d) => d.text).join(" | ") || "无"}`,
      };
    }
    case "recall": {
      const result = queryMemory(store, exp.query, { sessionId, tokenBudget: 2000 });
      const hit = result.results.find((r) => r.body.includes(exp.mustContain));
      return {
        expectation: `recall "${exp.query}" contains "${exp.mustContain}"`,
        passed: result.status !== "not-found" && Boolean(hit),
        detail: hit
          ? `命中片段 #${hit.segment_id}: ${hit.body.slice(0, 60)}`
          : `状态 ${result.status}，结果 ${result.results.length} 条`,
      };
    }
    case "lineage": {
      const edges = store.getEventsForFile(sessionId, exp.file);
      return {
        expectation: `lineage for "${exp.file}" >= ${exp.minEdges}`,
        passed: edges.length >= exp.minEdges,
        detail: `共 ${edges.length} 条边`,
      };
    }
    case "compact": {
      const row = store.eventsDb
        .prepare(
          `SELECT body FROM events WHERE session_id = ? AND kind = 'compact_checkpoint' ORDER BY id DESC LIMIT 1`,
        )
        .get(sessionId) as { body: string } | undefined;
      return {
        expectation: `compact checkpoint contains "${exp.contains}"`,
        passed: Boolean(row?.body.includes(exp.contains)),
        detail: row ? `checkpoint 正文: ${row.body.slice(0, 80)}` : "无 compact_checkpoint 事件",
      };
    }
    case "status-card": {
      const card = buildStatusCard(store, { sessionId, projectKey: store.projectKey, budgetLines: 100 });
      return {
        expectation: `status-card contains "${exp.contains}"`,
        passed: card.includes(exp.contains),
        detail: card ? `状态卡命中: ${card.includes(exp.contains) ? "是" : "否"}` : "状态卡为空",
      };
    }
  }
}
