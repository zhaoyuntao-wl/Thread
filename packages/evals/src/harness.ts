import {
  applyTurn,
  buildStatusCard,
  classifyReportEvent,
  classifyWriteEvent,
  getStateDelta,
  navigate,
  queryMemory,
  renderStateDelta,
  sedimentClosingTodos,
  ThreadStore,
} from "@thread-memory/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  const siblingId = `eval-${scenario.id}-other`;
  // 场景临时目录：产出文件按内容落盘（nav cat 需要真实文件可读）；场景路径 → 临时路径映射供断言解析
  const tmpDir = mkdtempSync(join(tmpdir(), "thread-eval-scenario-"));
  const pathMap = new Map<string, string>();
  let t = 0;
  const nextTs = () => new Date(new Date(BASE_TS).getTime() + t++ * 1000).toISOString();

  const turnSession = (other: boolean | undefined): string => (other ? siblingId : sessionId);
  // 显式通道 op（2026-08-21）：record_decision 工具调用 / /thread-reg fdb 命令的等价仿真——
  // 同步落事件（保血缘与召回语义）+ 写结构化行；supersedes "latest" = 本会话最近一条决策
  const lastDecisionId = new Map<string, number>();

  try {
    for (const turn of scenario.turns) {
      const sid = turnSession(turn.other);
      if (turn.user) {
        applyTurn(store, sid, { user_msg: turn.user }, { ts: nextTs() });
      }
      if (turn.assistant) {
        applyTurn(store, sid, { assistant_msg: turn.assistant }, { ts: nextTs() });
      }
      if (turn.decision) {
        const ts = nextTs();
        const targetId = turn.decision.supersedes === "latest" ? lastDecisionId.get(sid) : turn.decision.supersedes;
        const args = { text: turn.decision.text, ...(targetId !== undefined ? { supersedes_id: targetId } : {}) };
        const event = store.append({
          session_id: sid,
          kind: "tool_call",
          ts,
          body: `record_decision 调用参数：${JSON.stringify(args)}`,
          meta: { tool_name: "record_decision" },
        });
        let created;
        if (targetId !== undefined) {
          created = store.supersedeDecisionById(sid, targetId, turn.decision.text, { sourceEvent: event.id, ts })?.replacement;
        }
        created ??= store.addDecision(sid, turn.decision.text, { sourceEvent: event.id, ts, projectKey: store.projectKey });
        lastDecisionId.set(sid, created.id);
      }
      if (turn.feedback) {
        const kind = turn.feedback.kind ?? "preference";
        const event = store.append({
          session_id: sid,
          kind: "user_message",
          ts: nextTs(),
          body: `/thread-reg fdb ${turn.feedback.text}`,
        });
        store.addFeedback(sid, turn.feedback.text, kind, { sourceEvent: event.id, projectKey: store.projectKey });
      }
      if (turn.tool) {
        const tool = turn.tool;
        // 产出管线仿真（批 1 双适配器同规则）：content 落盘 + file_path 重写为临时路径
        let filePath = tool.file_path;
        if (filePath && typeof tool.input.content === "string") {
          const mapped = join(tmpDir, filePath);
          mkdirSync(dirname(mapped), { recursive: true });
          writeFileSync(mapped, tool.input.content, "utf8");
          pathMap.set(filePath, mapped);
          filePath = mapped;
        }
        const input = filePath ? { ...tool.input, file_path: filePath } : tool.input;
        const event = store.append({
          session_id: sid,
          kind: "tool_call",
          ts: nextTs(),
          body: `${tool.name} 调用参数：${JSON.stringify(input).slice(0, 500)}`,
          meta: { tool_name: tool.name, file_path: filePath, tool_input: input },
        });
        const classification = classifyWriteEvent(tool.name, input) ?? classifyReportEvent(tool.name, input);
        if (classification) {
          store.registerAsset({
            sessionId: sid,
            path: classification.path,
            title: classification.title,
            sourceEvent: event.id,
            projectKey: store.projectKey,
          });
        }
        if (tool.output) {
          store.append({
            session_id: sid,
            kind: "tool_result",
            ts: nextTs(),
            body: tool.output,
            meta: { tool_name: tool.name, file_path: filePath },
          });
        }
      }
      if (turn.compact) {
        store.append({
          session_id: sid,
          kind: "compact_checkpoint",
          ts: nextTs(),
          body: turn.compact,
          meta: { trigger: "eval" },
        });
      }
      if (turn.sediment) {
        sedimentClosingTodos(store, sid, { projectKey: store.projectKey });
      }
    }

    const checks: CheckResult[] = scenario.expectations.map((exp) =>
      checkExpectation(store, sessionId, siblingId, pathMap, exp),
    );
    return {
      scenarioId: scenario.id,
      title: scenario.title,
      passed: checks.every((c) => c.passed),
      checks,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
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
  siblingId: string,
  pathMap: Map<string, string>,
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
    case "decision-query": {
      // 2026-08-21 结构通道化：决策内容经 query_session_memory kind=decision（结构化表）回拉，
      // tool 事件不建 FTS 索引（governor 分层），决策文本召回走 decisions 表而非 BM25 事件召回
      const decisions = store.getDecisions(sessionId);
      const hit = decisions.find((d) => d.text.includes(exp.contains));
      return {
        expectation: `decision-query contains "${exp.contains}"`,
        passed: Boolean(hit),
        detail: hit ? `命中: #${hit.id} ${hit.text}` : `未命中，决策: ${decisions.map((d) => d.text).join(" | ") || "无"}`,
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
    case "asset": {
      const assets = store.listAssets({ sessionId });
      const hit = assets.find((a) => a.title.includes(exp.contains));
      return {
        expectation: `asset title contains "${exp.contains}"`,
        passed: Boolean(hit),
        detail: hit ? `命中: ${hit.title}（${hit.path}）` : `未命中，现有产出: ${assets.map((a) => a.title).join(" | ") || "无"}`,
      };
    }
    case "asset-edge": {
      const assets = store.listAssets({ sessionId });
      const target = assets[0];
      const edges = target ? store.getRelatedEdges(sessionId, "asset", target.id) : [];
      return {
        expectation: `asset edges >= ${exp.minEdges}`,
        passed: edges.length >= exp.minEdges,
        detail: target ? `产出 #${target.id}（${target.title}）共 ${edges.length} 条边` : "无产出",
      };
    }
    case "todo": {
      const todos = store.listTodos({ sessionId });
      const hit = todos.find((td) => td.text.includes(exp.contains));
      return {
        expectation: `todo contains "${exp.contains}"`,
        passed: Boolean(hit),
        detail: hit ? `命中: ${hit.text}（${hit.basis ?? "无依据"}）` : `未命中，现有待办: ${todos.map((td) => td.text).join(" | ") || "无"}`,
      };
    }
    case "todo-count": {
      const todos = store.listTodos({ sessionId });
      return {
        expectation: `todo count == ${exp.count}`,
        passed: todos.length === exp.count,
        detail: `现有待办 ${todos.length} 条`,
      };
    }
    case "nav": {
      const target = exp.target ? pathMap.get(exp.target) ?? exp.target : exp.target;
      const result = navigate(store, {
        nav: exp.nav,
        target,
        query: exp.query,
        sessionId,
        viewerSessionId: sessionId,
      });
      const text = `${result.title}\n${result.items.map((i) => i.label).join("\n")}`;
      return {
        expectation: `nav ${exp.nav}${target ? ` ${target}` : ""}${exp.query ? ` "${exp.query}"` : ""} contains "${exp.contains}"`,
        passed: text.includes(exp.contains),
        detail: text.slice(0, 200),
      };
    }
    case "delta": {
      const delta = getStateDelta(store, {
        projectKey: store.projectKey,
        since: BASE_TS,
        excludeSessionId: sessionId,
        viewerSessionId: sessionId,
      });
      const text = renderStateDelta(delta) ?? "";
      void siblingId;
      return {
        expectation: `delta contains "${exp.contains}"`,
        passed: text.includes(exp.contains),
        detail: text ? text.slice(0, 200) : "delta 为空",
      };
    }
    case "card-situation": {
      const card = buildStatusCard(store, {
        sessionId,
        projectKey: store.projectKey,
        budgetLines: 100,
        situation: exp.situation,
      });
      return {
        expectation: `card(${exp.situation}) contains "${exp.contains}"`,
        passed: card.includes(exp.contains),
        detail: card.includes(exp.contains) ? "命中" : `状态卡前 120 字: ${card.slice(0, 120)}`,
      };
    }
  }
}
