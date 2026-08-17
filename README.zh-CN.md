# Thread

*Session memory with lineage for coding agents.*（面向编码 Agent 的会话记忆层）

Thread 是底座无关的编码 Agent 会话记忆层。与有损的上下文压缩不同，它把会话的完整事件流无损落库、按需检索——长任务中的目标、决策、反馈与血缘关系全程保真。

- **决策不丢**：每个决策（含被取代/被撤销的）无损留存，演化过程可回溯
- **目标不漂移**：关键目标在压缩与新会话后仍常驻
- **不重复提问**：已答信息按需召回
- **上下文有界**：每轮成本保持 O(1)——常驻状态卡 + 按需检索，替代全量历史重放

## 架构

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  底座（可互换）              │        │  Thread 记忆内核              │
│  主模型                      │  MCP   │  查询服务（图/BM25）           │
│  工具（query_session_memory）│ hooks  │  事件流水（无损存储）          │
│  会话导出                    │        │  结构化表（目标/决策/反馈）    │
│  每轮上下文注入               │        │  血缘图                       │
└─────────────────────────────┘        └──────────────────────────────┘
```

Thread 以独立进程运行。底座通过三个弱能力（MCP 客户端 / hook 事件 / 每轮上下文注入）接入，可互换。

## 包结构

本仓库：

| 包 | 说明 |
|---|---|
| `@thread/core` | 事件流水、结构化表（目标/决策/反馈）、血缘图、BM25 检索、会话隔离 |
| `@thread/adapter-qoder-cli` | Qoder CLI 参考适配器（hooks 采集、上下文注入、MCP 查询工具） |
| `@thread/evals` | 回归集：场景级保真检查，CI 门禁 |

dsh 适配器（`dsh-thread`）在独立仓库：[dsh-plugin-thread](https://github.com/zhaoyuntao-wl/dsh-plugin-thread) —— 单包闭环：`session/event` 采集 + 每轮状态卡注入 + 内嵌 MCP server（`query_session_memory`，`bin=dsh-thread`）。

## 快速开始

```ts
import { ThreadStore, applyAnalysis, buildStatusCard, queryMemory } from "@thread/core";

const store = new ThreadStore({ eventsPath, structuredPath, projectKey });

store.append(
  { session_id: "s1", kind: "user_message", ts: new Date().toISOString(), body: "帮我实现登录功能" },
  { origin: "demo://msg#1", projectKey },
);
applyAnalysis(store, "s1", { user_msg: "帮我实现登录功能" }, { projectKey });

const card = buildStatusCard(store, { sessionId: "s1", projectKey, budgetLines: 200 });
const hits = queryMemory(store, "JWT 认证", { sessionId: "s1" });

store.close();
```

更多：[examples/](./examples/README.md) · [API 参考](./docs/api.md) · [设计文档（v1 基线）](./docs/design/v1/session-memory-system-design.md)

## 开发

需要 Node >= 20 与 pnpm。

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm eval        # 场景级保真回归集（CI 门禁）
```

见 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [MAINTAINING.md](./MAINTAINING.md)。

## 许可证

[MIT](./LICENSE)
