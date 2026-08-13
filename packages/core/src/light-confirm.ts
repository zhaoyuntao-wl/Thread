import type { Decision, FeedbackRow, Goal, ThreadStore } from "./store.js";

export interface TurnInput {
  user_msg?: string;
  assistant_msg?: string;
}

export interface GoalAction {
  text: string;
  action: "add";
}

export type DecisionAction =
  | { action: "propose"; text: string }
  | { action: "confirm" }
  | { action: "revoke" }
  | { action: "supersede"; text: string };

export interface FeedbackAction {
  text: string;
  kind: "preference" | "correction";
}

export interface TurnAnalysis {
  goals: GoalAction[];
  decisions: DecisionAction[];
  feedback: FeedbackAction[];
}

const ACCEPT_SHORT = new Set([
  "嗯",
  "恩",
  "好",
  "好的",
  "可以",
  "行",
  "没问题",
  "ok",
  "okay",
  "确认",
  "同意",
  "就这样",
  "不错",
  "对",
  "是",
  "收到",
  "明白",
]);

const ACCEPT_RE = /^(嗯+|好+|行+|可以|没问题|OK|ok|Okay|收到|明白|确认|同意)$/;

const SUPERSEDE_RE = /(?:改成|改用|换成|改为|换用)[：:，,\s]*([^。！!？?]+)/;

const REVOKE_RE = /(?:算了|撤销|放弃|不要(?:用|做|要)?了|不要用|别(?:用|做|要)|不用了|回退|改回|别用了)/;

const DECLARE_RE = [
  /(?<![忘标登])(?:我|我们)?(?:已|已经)?记下(?:了)?[：:，,\s]*([^。！!？?]+)/,
  /(?<![不未怎何否该么能])(?:我|我们)?(?:决定采用|方案定为|就采用|决定(?!性)|确定(?!性))[：:，,\s]*([^。！!？?]+)/,
];

const GOAL_RE = /^(?:帮我|请|再帮我|然后帮我|接着帮我|帮我再|还要帮我|麻烦帮我)?(?:实现|修复|重构|添加|新增|完成|构建|创建|删除|优化|升级|接入|验证|设计|规划|开发|搭建|编写|整理|部署|迁移|拆分|合并|安装|配置|生成)/;

const PREFERENCE_RE = /(?:以后|下次|永远|总是|记得|优先|别再|不要再)/;

const CORRECTION_RE = /(?:不要|别|别再|不要再)/;

const MAX_DECISION_TEXT = 200;
const MAX_GOAL_TEXT = 500;

export function analyzeTurn(input: TurnInput): TurnAnalysis {
  const analysis: TurnAnalysis = { goals: [], decisions: [], feedback: [] };
  const userRaw = (input.user_msg ?? "").trim();
  const user = stripPunct(userRaw);
  const assistantRaw = (input.assistant_msg ?? "").trim();
  const assistant = stripPunct(assistantRaw);

  if (user) {
    if (GOAL_RE.test(user)) {
      analysis.goals.push({ text: userRaw.slice(0, MAX_GOAL_TEXT), action: "add" });
    }
    const isPreference = PREFERENCE_RE.test(user);
    if (isPreference) {
      analysis.feedback.push({
        text: userRaw.slice(0, MAX_GOAL_TEXT),
        kind: CORRECTION_RE.test(user) ? "correction" : "preference",
      });
    }
    const supersede = userRaw.match(SUPERSEDE_RE);
    if (supersede) {
      analysis.decisions.push({ action: "supersede", text: supersede[1].trim().slice(0, MAX_DECISION_TEXT) });
    } else if (!isPreference) {
      if (REVOKE_RE.test(user)) {
        analysis.decisions.push({ action: "revoke" });
      } else if (ACCEPT_SHORT.has(user) || ACCEPT_RE.test(user)) {
        analysis.decisions.push({ action: "confirm" });
      }
    }
  }

  if (assistant) {
    for (const re of DECLARE_RE) {
      const m = assistantRaw.match(re);
      if (m && m[1]?.trim()) {
        const text = m[1].trim().slice(0, MAX_DECISION_TEXT);
        if (!/[吗呢吧]$/.test(text)) {
          analysis.decisions.push({ action: "propose", text });
        }
        break;
      }
    }
  }

  return analysis;
}

export interface AppliedTurn {
  goals: Goal[];
  decisions: Decision[];
  feedback: FeedbackRow[];
}

export function applyTurn(
  store: ThreadStore,
  sessionId: string,
  input: TurnInput,
  opts: { sourceEvent?: number; ts?: string } = {},
): AppliedTurn {
  const ts = opts.ts ?? new Date().toISOString();
  let sourceEvent = opts.sourceEvent;
  const userMsg = (input.user_msg ?? "").trim();
  const assistantMsg = (input.assistant_msg ?? "").trim();
  if (userMsg) {
    const ev = store.append({
      session_id: sessionId,
      kind: "user_message",
      ts,
      body: userMsg,
    });
    sourceEvent ??= ev.id;
  }
  if (assistantMsg) {
    const ev = store.append({
      session_id: sessionId,
      kind: "assistant_message",
      ts,
      body: assistantMsg,
    });
    sourceEvent ??= ev.id;
  }

  return applyAnalysis(store, sessionId, input, { sourceEvent, ts });
}

export function applyAnalysis(
  store: ThreadStore,
  sessionId: string,
  input: TurnInput,
  opts: { sourceEvent?: number; ts?: string } = {},
): AppliedTurn {
  const analysis = analyzeTurn(input);
  const ts = opts.ts ?? new Date().toISOString();
  const sourceEvent = opts.sourceEvent;
  const structuredOpts = { sourceEvent, ts };

  return store.transact(() => {
    const applied: AppliedTurn = { goals: [], decisions: [], feedback: [] };
    for (const g of analysis.goals) {
      applied.goals.push(store.addGoal(sessionId, g.text, structuredOpts));
    }
    for (const d of analysis.decisions) {
      switch (d.action) {
        case "propose":
          applied.decisions.push(store.proposeDecision(sessionId, d.text, structuredOpts));
          break;
        case "confirm": {
          const confirmed = store.confirmLatestProposed(sessionId, { ts });
          if (confirmed) {
            applied.decisions.push(confirmed);
          }
          break;
        }
        case "revoke": {
          const revoked = store.revokeLatestActive(sessionId, { ts });
          if (revoked) {
            applied.decisions.push(revoked);
          }
          break;
        }
        case "supersede": {
          const result = store.supersedeLatestActive(sessionId, d.text, structuredOpts);
          if (result) {
            applied.decisions.push(result.superseded, result.replacement);
          }
          break;
        }
      }
    }
    for (const f of analysis.feedback) {
      applied.feedback.push(store.addFeedback(sessionId, f.text, f.kind, structuredOpts));
    }
    return applied;
  });
}

function stripPunct(text: string): string {
  return text.replace(/[，。！!？?、]/g, "").trim();
}
