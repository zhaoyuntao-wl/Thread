import { ThreadStore, queryMemory } from "@thread/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const defaultDbPath = process.env.THREAD_DB ?? join(packageRoot, ".thread", "sms.db");

const store = new ThreadStore({ path: defaultDbPath });

const server = new McpServer({
  name: "thread-sms",
  version: "0.0.0",
});

server.tool(
  "query_session_memory",
  "查询会话记忆：事件流水与结构化表（目标/决策/反馈）的按需检索。返回带证据的片段；未找到时返回 not-found 标记与追问建议。",
  {
    query: z.string().describe("检索查询，支持关键词/短语，如 '登录模块 决策'"),
    token_budget: z.number().int().positive().optional().describe("返回结果 token 预算，默认 4000"),
    session_id: z.string().optional().describe("会话 ID；缺省使用最近活跃会话"),
    limit: z.number().int().positive().max(50).optional().describe("最大返回片段数，默认 20"),
  },
  async (args) => {
    const sessionId = args.session_id ?? store.getRecentSessionId();
    const result = sessionId
      ? queryMemory(store, args.query, {
          tokenBudget: args.token_budget,
          sessionId,
          limit: args.limit,
        })
      : {
          status: "not-found" as const,
          results: [],
          note: "会话记忆为空：尚无事件写入。",
        };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
