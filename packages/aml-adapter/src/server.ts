// AML Add/Search 适配器（2026-09-02 R1 spike）：
// - 参赛约束：Search 只返回记忆证据不生成答案；不得跨 user_id 共享检索 → 每 user_id 一个独立 SQLite 库（哈希目录），存储层即隔离
// - 零 LLM 主路径：Add = 事件追加（写时建索引），Search = BM25（jieba 中文分词 + trigram 兜底）——满足"模型仅 gpt-4o-mini"条款（我们不用模型）
// - 鉴权：AML_SYSTEM_KEY 设置后要求 Bearer 头；未设置 = 无鉴权（本地 spike/自测）
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { ThreadStore, queryMemory } from "@thread-memory/core";

export interface AdapterOptions {
  root: string;
  port?: number;
  systemKey?: string;
}

export interface AdapterRuntime {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 20_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

export function startAdapter(opts: AdapterOptions): Promise<AdapterRuntime> {
  const stores = new Map<string, ThreadStore>();

  function storeFor(userId: string): ThreadStore {
    let store = stores.get(userId);
    if (!store) {
      const dir = join(opts.root, "users", createHash("sha256").update(userId).digest("hex"));
      mkdirSync(dir, { recursive: true });
      store = new ThreadStore({
        eventsPath: join(dir, "events.db"),
        structuredPath: join(dir, "structured.db"),
        projectKey: "aml",
      });
      stores.set(userId, store);
    }
    return store;
  }

  const server = createServer(async (req, res) => {
    try {
      if (opts.systemKey && req.headers.authorization !== `Bearer ${opts.systemKey}`) {
        json(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true, stores: stores.size });
        return;
      }
      if (req.method === "POST" && url.pathname === "/add") {
        const body = await readBody(req);
        const userId = typeof body.user_id === "string" && body.user_id ? body.user_id : "";
        const content = typeof body.content === "string" ? body.content : "";
        if (!userId || !content) {
          json(res, 400, { ok: false, error: "user_id and content are required" });
          return;
        }
        const store = storeFor(userId);
        const origin = typeof body.id === "string" && body.id ? `aml://${userId}/${body.id}` : undefined;
        const event = store.append(
          { session_id: userId, kind: "user_message", ts: new Date().toISOString(), body: content },
          { projectKey: "aml", origin },
        );
        json(res, 200, { ok: true, event_id: event.id, seq: event.seq });
        return;
      }
      if (req.method === "POST" && url.pathname === "/search") {
        const body = await readBody(req);
        const userId = typeof body.user_id === "string" && body.user_id ? body.user_id : "";
        const query = typeof body.query === "string" ? body.query : "";
        if (!userId || !query) {
          json(res, 400, { ok: false, error: "user_id and query are required" });
          return;
        }
        const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 100) : 20;
        const result = queryMemory(storeFor(userId), query, {
          limit,
          tokenBudget: 8000,
          sessionId: userId,
          organize: true,
          projectKey: "aml",
        });
        // 证据-only：只回命中原文，不生成答案（参赛基本要求 1）
        json(res, 200, {
          ok: true,
          status: result.status,
          results: result.results.map((h) => ({
            id: h.segment_id,
            kind: h.kind,
            ts: h.ts,
            body: h.body,
            score: h.score,
          })),
        });
        return;
      }
      json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const store of stores.values()) {
              store.close();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  const runtime = await startAdapter({
    root: process.env.THREAD_ROOT ?? join(process.cwd(), "aml-data"),
    port: Number(process.env.PORT ?? 8787),
    systemKey: process.env.AML_SYSTEM_KEY || undefined,
  });
  console.log(`aml-adapter listening on :${runtime.port}, root=${process.env.THREAD_ROOT ?? "aml-data"}${process.env.AML_SYSTEM_KEY ? " (auth on)" : " (no auth)"}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void runtime.close().then(() => process.exit(0));
    });
  }
}
