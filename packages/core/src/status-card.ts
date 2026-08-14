import type { ThreadStore } from "./store.js";
import { applyScopePriority } from "./store.js";

// 状态卡构建（B③/B④ 共用）：合并视图 + 分层优先级 + 预算分档 + 词汇边界（不出现 session/project/scope 等机制词）。
// 注入隔离：内容 = 数据非指令（状态卡是用户可理解的事实 + 低频冲突询问）。

export interface BuildStatusCardOptions {
  sessionId: string;
  projectKey?: string;
  budgetLines?: number;
  recentCount?: number;
}

export function buildStatusCard(store: ThreadStore, opts: BuildStatusCardOptions): string {
  const sessionId = opts.sessionId;
  const projectKey = opts.projectKey;
  const budgetLines = opts.budgetLines ?? 100;
  const recentCount = opts.recentCount ?? 3;

  let goals: Array<{ text: string; scope?: string | null; session_id: string }> = [];
  let decisions: Array<{ text: string; scope?: string | null; session_id: string }> = [];
  let feedback: Array<{ text: string; scope?: string | null; session_id: string }> = [];
  let recent: Array<{ kind: string; body: string }> = [];
  try {
    goals = applyScopePriority(store.getActiveGoalsMerged(sessionId, projectKey));
    decisions = applyScopePriority(store.getActiveDecisionsMerged(sessionId, projectKey));
    feedback = applyScopePriority(store.getFeedbackMerged(sessionId, projectKey, 5));
    recent = store.getRecentEvents(sessionId, recentCount);
  } catch {
    // 状态卡是主路径增强，任何失败都降级为最小卡，绝不阻塞
  }

  const shareMark = (row: { scope?: string | null; session_id: string }): string =>
    row.scope === "global" ? "（全局）" : row.session_id !== sessionId ? "（来自其他会话）" : "";

  const lines: string[] = [];
  lines.push("[Thread 会话记忆状态卡]");
  if (goals.length > 0) {
    lines.push("目标:");
    goals
      .slice()
      .reverse()
      .slice(0, 5)
      .forEach((g, i) => lines.push(`  ${i + 1}. ${g.text.slice(0, 120)}${shareMark(g)}`));
  }
  if (decisions.length > 0) {
    lines.push("决策（生效中）:");
    decisions.slice(0, 5).forEach((d, i) => lines.push(`  ${i + 1}. ${d.text.slice(0, 120)}${shareMark(d)}`));
  }
  if (feedback.length > 0) {
    lines.push("偏好:");
    feedback.forEach((f) => {
      lines.push(`  - ${f.text.slice(0, 120)}${shareMark(f)}`);
    });
  }
  if (recent.length > 0) {
    lines.push("最近事件:");
    recent
      .slice()
      .reverse()
      .forEach((e) => lines.push(`  - ${e.kind}: ${e.body.slice(0, 60)}`));
  }
  lines.push("需要更早的历史细节时，调用 query_session_memory 工具查询。");

  return lines.slice(0, budgetLines).join("\n");
}
