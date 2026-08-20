import type { ThreadStore } from "./store.js";

// 收尾自动沉淀（MAX 设计 1.2）：收尾词 → 进行中目标进 todos + pending 候选归集 todo。
// 只做"归集 + 写待办"，不做二次提炼。产出（knowledge_assets）不搬进 todos（产出 ≠ 待办，自检修正②）。
// 幂等：同目标已存在 basis=goal:<id> 的 todo 则跳过；pending 归集 todo 每会话一条（basis=/thread-pending 存在则跳过）。

export interface ClosingSedimentResult {
  goalTodosCreated: number;
  goalTodosSkipped: number;
  pendingTodoCreated: boolean;
}

export const PENDING_TODO_BASIS = "/thread-pending";

export function sedimentClosingTodos(
  store: ThreadStore,
  sessionId: string,
  opts: { projectKey?: string; isolation?: boolean } = {},
): ClosingSedimentResult {
  const goals = store.getActiveGoals(sessionId);
  let goalTodosCreated = 0;
  let goalTodosSkipped = 0;
  for (const goal of goals) {
    const basis = `goal:${goal.id}`;
    const existing = store.listTodos({ sessionId, basis }).length > 0;
    if (existing) {
      goalTodosSkipped += 1;
      continue;
    }
    store.addTodo({
      sessionId,
      text: `${goal.text}（未完成）`,
      basis,
      projectKey: opts.projectKey,
      isolation: opts.isolation,
    });
    goalTodosCreated += 1;
  }

  let pendingTodoCreated = false;
  const pending = store.pendingCount({ sessionId });
  const pendingTodoExists = store.listTodos({ sessionId, basis: PENDING_TODO_BASIS }).length > 0;
  if (pending > 0 && !pendingTodoExists) {
    store.addTodo({
      sessionId,
      text: `待确认候选 ${pending} 条待处理`,
      basis: PENDING_TODO_BASIS,
      projectKey: opts.projectKey,
      isolation: opts.isolation,
    });
    pendingTodoCreated = true;
  }

  return { goalTodosCreated, goalTodosSkipped, pendingTodoCreated };
}
