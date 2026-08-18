import type { Decision, FeedbackRow, Goal, StructuredWriteOptions, ThreadStore } from "./store.js";

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
  /(?:方案定为|就采用|决定采用)[：:，,\s]*([^。！!？?]+)/,
  /(?:我|我们)(?:已|已经)?(?:决定(?!性)|确定(?!性))[：:，,\s]*([^。！!？?]+)/,
];

// 用户侧决策宣告（机制 1，§1.5.3c）：用户口头定案（肯定性决策语）→ 写入 decisions 而非 feedback。
// 与 PREFERENCE_RE（"以后/下次/别再"偏好语）区分：决策语是"现在定了/就按这个"，偏好语是"以后倾向"。
const USER_DECLARE_RE = [
  /(?:就按|就采用|就定为|就定|定为|定案|拍板|确定(?!性)|决定(?!性))(?:用|采用|使用)?[：:，,\s]*([^。！!？?]+)/,
  /(?:方案|计划|方向)(?:就是|是|定为|选)(?:了)?[：:，,\s]*([^。！!？?]+)/,
  /以后(?:就|都)(?:在|用|按|走)[：:，,\s]*([^。！!？?]+)/,
];

// 系统提醒/指令注入噪声（机制 1 附带）：system-reminder / AGENTS.md 变更等不是用户决策或偏好，跳过
const SYSTEM_NOISE_RE = /^<system-reminder>|^Updated instructions from|^Instructions from|AGENTS\.md/;

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
    // 机制 1（§1.5.3c）：系统提醒/指令注入不抽任何结构化行（噪声过滤）
    if (SYSTEM_NOISE_RE.test(userRaw)) {
      return analysis;
    }
    if (GOAL_RE.test(user)) {
      analysis.goals.push({ text: userRaw.slice(0, MAX_GOAL_TEXT), action: "add" });
    }
    // 用户侧决策宣告（机制 1）：肯定性决策语 → propose（写入 decisions，权威性高于 preference）
    for (const re of USER_DECLARE_RE) {
      const m = userRaw.match(re);
      if (m && m[1]?.trim()) {
        const text = m[1].trim().slice(0, MAX_DECISION_TEXT);
        if (!/[吗呢吧]$/.test(text)) {
          analysis.decisions.push({ action: "propose", text });
          return analysis;
        }
        break;
      }
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
    // 机制 1：assistant 侧同样过滤系统提醒/指令注入噪声（AGENTS.md 变更回显等）
    if (SYSTEM_NOISE_RE.test(assistantRaw)) {
      return analysis;
    }
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
  opts: StructuredWriteOptions = {},
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

  return applyAnalysis(store, sessionId, input, { ...opts, sourceEvent, ts });
}

export function applyAnalysis(
  store: ThreadStore,
  sessionId: string,
  input: TurnInput,
  opts: StructuredWriteOptions = {},
): AppliedTurn {
  const analysis = analyzeTurn(input);
  const ts = opts.ts ?? new Date().toISOString();
  const sourceEvent = opts.sourceEvent;
  const structuredOpts = { sourceEvent, ts, scope: opts.scope, projectKey: opts.projectKey, origin: opts.origin, isolation: opts.isolation };

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
