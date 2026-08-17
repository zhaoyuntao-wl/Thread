import type { ThreadStore } from "./store.js";
import { applyScopePriority } from "./store.js";

// 状态卡构建（B③/B④ 共用）：合并视图 + 分层优先级 + 预算分档 + 词汇边界（不出现 session/project/scope 等机制词）。
// 注入隔离：内容 = 数据非指令（状态卡是用户可理解的事实 + 低频冲突询问）。

export interface BuildStatusCardOptions {
  sessionId: string;
  projectKey?: string;
  budgetLines?: number;
  recentCount?: number;
  isolated?: boolean;
  // 首轮档（外部借鉴①：会话首请求即锚定轨迹，首轮给全量锚点，后续维持轻量 O(1)）
  firstTurn?: boolean;
}

export function buildStatusCard(store: ThreadStore, opts: BuildStatusCardOptions): string {
  const sessionId = opts.sessionId;
  const projectKey = opts.projectKey;
  const budgetLines = opts.budgetLines ?? 100;
  const firstTurn = opts.firstTurn ?? false;
  const recentCount = opts.recentCount ?? (firstTurn ? 5 : 3);
  const listLimit = firstTurn ? 8 : 5;
  const feedbackLimit = firstTurn ? 8 : 5;
  const isolated = opts.isolated ?? false;

  let goals: Array<{ id: number; text: string; scope?: string | null; session_id: string }> = [];
  let decisions: Array<{ id: number; text: string; scope?: string | null; session_id: string }> = [];
  let feedback: Array<{ id: number; text: string; scope?: string | null; session_id: string }> = [];
  let recent: Array<{ kind: string; body: string }> = [];
  try {
    if (isolated) {
      // 隔离模式：只显示本会话内容（不继承项目/全局），状态卡不随其他代理变动
      goals = store.getActiveGoals(sessionId);
      decisions = store.getActiveDecisions(sessionId);
      feedback = store.getFeedback(sessionId, feedbackLimit);
    } else {
      goals = applyScopePriority(store.getActiveGoalsMerged(sessionId, projectKey));
      decisions = applyScopePriority(store.getActiveDecisionsMerged(sessionId, projectKey));
      feedback = applyScopePriority(store.getFeedbackMerged(sessionId, projectKey, feedbackLimit));
    }
    recent = store.getRecentEvents(sessionId, recentCount);
  } catch {
    // 状态卡是主路径增强，任何失败都降级为最小卡，绝不阻塞
  }

  const shareMark = (row: { scope?: string | null; session_id: string }): string =>
    row.scope === "global" ? "（全局）" : row.session_id !== sessionId ? "（来自其他会话）" : "";

  const lines: string[] = [];
  lines.push(isolated ? "[Thread 会话记忆状态卡]（本会话已隔离，内容仅自己可见）" : "[Thread 会话记忆状态卡]");
  if (goals.length > 0) {
    lines.push("目标:");
    goals
      .slice()
      .reverse()
      .slice(0, listLimit)
      .forEach((g, i) => lines.push(`  ${i + 1}. ${g.text.slice(0, 120)}${shareMark(g)} #${g.id}`));
  }
  if (decisions.length > 0) {
    lines.push("决策（生效中）:");
    decisions.slice(0, listLimit).forEach((d, i) => lines.push(`  ${i + 1}. ${d.text.slice(0, 120)}${shareMark(d)} #${d.id}`));
  }
  if (feedback.length > 0) {
    lines.push("偏好:");
    feedback.forEach((f) => {
      lines.push(`  - ${f.text.slice(0, 120)}${shareMark(f)} #${f.id}`);
    });
  }
  if (recent.length > 0) {
    lines.push("最近事件:");
    recent
      .slice()
      .reverse()
      .forEach((e) => lines.push(`  - ${e.kind}: ${e.body.slice(0, 60)}`));
  }
  // 收束语（外部借鉴③）：绑定式行动收束，防止纯"再想想"式开放引导
  lines.push("需要更早的历史细节时，调用 query_session_memory 工具查询，并基于结果给出结论。");
  lines.push("收到 隔离//unisolate//thread-publish 单命令时，只回一句状态确认，不展开思考。");

  return lines.slice(0, budgetLines).join("\n");
}
