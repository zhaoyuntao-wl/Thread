import type { Goal, StructuredWriteOptions, ThreadStore } from "./store.js";

export interface TurnInput {
  user_msg?: string;
  assistant_msg?: string;
}

export interface GoalAction {
  text: string;
  action: "add";
}

export interface TurnAnalysis {
  goals: GoalAction[];
}

export interface AppliedTurn {
  goals: Goal[];
}

// 2026-08-21 结构通道化（用户定案）：决策/偏好/确认/撤销/取代的自然语言判定全部停用——
// 用户侧无锚定正则对粘贴文本零防御（生产实证：9 条候选 5 条碎片误报 + 目标 #1 为多行粘贴转写）。
// 决策/偏好只走显式通道：命令（/thread-decision、/thread-feedback）与模型工具（record_decision）。
// 事件流水无损保留 = 未显式记录的决策仍可经 query_session_memory 回拉（下限不丢）。

// 系统提醒/指令注入噪声（机制 1 附带）：system-reminder / AGENTS.md 变更等不是用户任务，跳过
const SYSTEM_NOISE_RE = /^<system-reminder>|^Updated instructions from|^Instructions from|AGENTS\.md/;

const GOAL_RE = /^(?:帮我|请|再帮我|然后帮我|接着帮我|帮我再|还要帮我|麻烦帮我)?(?:实现|修复|重构|添加|新增|完成|构建|创建|删除|优化|升级|接入|验证|设计|规划|开发|搭建|编写|整理|部署|迁移|拆分|合并|安装|配置|生成)/;

// 目标粘贴守卫（2026-08-21 用户场景：别处用自然语言描述 → 模型输出 md 提示词 → 用户粘贴过来）：
// 粘贴物与用户自然语言任务的稳定区别 = 多行 / 长文。生产实证：真实目标 = 单行 ≤ ~105 字符；
// 误报目标 #1 = 多行粘贴转写 500+ 字符。守卫：含换行不判定；>200 字符不判定
// （单行短提示 ≤200 且以祈使动词开头 = 语义上就是任务描述，保留无害）。
const MAX_GOAL_TEXT = 200;

// 目标完成检测（2026-08-20 收口，零 LLM 高精度规则）：用户消息含完成标记 + 否定/疑问守卫 +
// 与某 active 目标文本的 ≥4 连续字符重叠 → 判定完成。命中率问题的确定性解法 = 只认"明确说完成且点中目标"。
const COMPLETION_RE = /(?:完成|搞定|做完|结束|交付)(?:了|啦|咯)?/;
const COMPLETION_NEGATION_RE = /(?:还没|尚未|没|未)\s*(?:完成|搞定|做完)/;

export function detectGoalCompletion(userMsg: string, goals: Goal[]): Goal | undefined {
  const text = normalizeCompletionText(userMsg);
  // 短消息守卫（2026-08-21 狗粮假阳性实锤）：完成宣告是短句；长粘贴文本（跨会话转写等）
  // 含完成词 + 目标重叠时会误触发（粘贴新会话转写 → 误 completed 弹窗收尾目标）。>100 字符不判定。
  if (text.length > 100) {
    return undefined;
  }
  if (COMPLETION_NEGATION_RE.test(text)) {
    return undefined;
  }
  if (!COMPLETION_RE.test(text)) {
    return undefined;
  }
  // 疑问句不算完成宣告
  if (/[吗呢]$/.test(text.trim())) {
    return undefined;
  }
  for (const g of goals) {
    const goalText = normalizeCompletionText(g.text);
    // 重叠窗口规则（2026-08-21 狗粮误报修复）：中文窗口 ≥4 连续字符（≈两个词，有意义）；
    // 纯 ASCII 窗口要求 ≥8 连字符——4 字符英文只是半个单词（北极星"Thread"被消息里
    // "thread-reg"命中"read"/"hrea"窗口 = 误 completed，生产实证）。
    for (let i = 0; i + 4 <= goalText.length; i++) {
      const win = goalText.slice(i, i + 4);
      if (/[^\x21-\x7E]/.test(win) && text.includes(win)) {
        return g;
      }
    }
    const asciiRuns = goalText.match(/[\x21-\x7E]{8,}/g) ?? [];
    for (const run of asciiRuns) {
      for (let i = 0; i + 8 <= run.length; i++) {
        if (text.includes(run.slice(i, i + 8))) {
          return g;
        }
      }
    }
  }
  return undefined;
}

// 完成判定归一化：去中文标点 + 去空白（"Thread 定位"与"Thread定位"等价，防空格断匹配）
function normalizeCompletionText(t: string): string {
  return stripPunct(t).replace(/\s+/g, "");
}

export function analyzeTurn(input: TurnInput): TurnAnalysis {
  const analysis: TurnAnalysis = { goals: [] };
  const userRaw = (input.user_msg ?? "").trim();
  if (!userRaw) {
    return analysis;
  }
  // 机制 1 保留：系统提醒/指令注入不抽任何结构化行（噪声过滤）
  if (SYSTEM_NOISE_RE.test(userRaw)) {
    return analysis;
  }
  const user = stripPunct(userRaw);
  // 粘贴守卫：多行（md 提示词/转写粘贴）与长文不判目标
  if (user.includes("\n") || user.length > MAX_GOAL_TEXT) {
    return analysis;
  }
  if (GOAL_RE.test(user) && !(COMPLETION_RE.test(user) && !COMPLETION_NEGATION_RE.test(user))) {
    // 完成宣告句不当作新目标（"整理研究笔记搞定了"是收尾，不是新任务——2026-08-20 收口防误报）
    analysis.goals.push({ text: userRaw.slice(0, MAX_GOAL_TEXT), action: "add" });
  }
  return analysis;
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
    const applied: AppliedTurn = { goals: [] };
    for (const g of analysis.goals) {
      applied.goals.push(store.addGoal(sessionId, g.text, structuredOpts));
    }
    // 目标完成检测（2026-08-20 收口；2026-08-21 狗粮修复）：跨会话合并视图判定——状态卡/接续块
    // 展示的是 getActiveGoalsMerged（项目+全局+会话），用户指认"X 完成"的目标常来自旧会话；
    // 更新必须传目标自己的 session_id（updateGoalStatus 按 session_id 过滤，传当前会话 = 0 行更新）。
    // 狗粮实证：新会话说"验证链全绿那条已完成了"，目标在旧会话 → getActiveGoals(本会话)=0 → 漏判。
    if (input.user_msg) {
      const completed = detectGoalCompletion(input.user_msg, store.getActiveGoalsMerged(sessionId, opts.projectKey));
      if (completed) {
        store.updateGoalStatus(completed.session_id, completed.id, "completed");
      }
    }
    return applied;
  });
}

function stripPunct(text: string): string {
  return text.replace(/[，。！!？?、]/g, "").trim();
}
