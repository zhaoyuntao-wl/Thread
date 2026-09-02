import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdapter, type AdapterRuntime } from "./server.js";

let runtime: AdapterRuntime | undefined;
let dir: string | undefined;

async function call(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

afterEach(async () => {
  if (runtime) {
    await runtime.close();
    runtime = undefined;
  }
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("aml-adapter（R1 spike：Add/Search + 隔离 + 鉴权 + 幂等）", () => {
  it("中文 Add → Search 往返命中（BM25 jieba 词级）", async () => {
    dir = mkdtempSync(join(tmpdir(), "aml-"));
    runtime = await startAdapter({ root: dir });
    await call(runtime!.port, "/add", { user_id: "u1", content: "登录模块决定使用 Session 认证，不用 JWT 自签方案" });
    await call(runtime!.port, "/add", { user_id: "u1", content: "数据库选型定为 SQLite + FTS5" });
    const r = await call(runtime!.port, "/search", { user_id: "u1", query: "登录方案 决策" });
    expect(r.json.ok).toBe(true);
    const results = r.json.results as Array<{ body: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].body).toContain("Session 认证");
  });

  it("per-user_id 隔离：跨用户检索零泄漏", async () => {
    dir = mkdtempSync(join(tmpdir(), "aml-"));
    runtime = await startAdapter({ root: dir });
    await call(runtime!.port, "/add", { user_id: "u1", content: "内部方案：冷旋定料直径 437" });
    const r = await call(runtime!.port, "/search", { user_id: "u2", query: "冷旋定料" });
    expect(r.json.status).toBe("not-found");
    expect((r.json.results as unknown[]).length).toBe(0);
  });

  it("同 id 重复 Add 幂等（origin 去重）", async () => {
    dir = mkdtempSync(join(tmpdir(), "aml-"));
    runtime = await startAdapter({ root: dir });
    const a = await call(runtime!.port, "/add", { user_id: "u1", content: "幂等事件", id: "evt-1" });
    const b = await call(runtime!.port, "/add", { user_id: "u1", content: "幂等事件", id: "evt-1" });
    expect(a.json.event_id).toBe(b.json.event_id);
  });

  it("鉴权：设置 systemKey 后无 Bearer 401、带 Key 200", async () => {
    dir = mkdtempSync(join(tmpdir(), "aml-"));
    runtime = await startAdapter({ root: dir, systemKey: "test-key" });
    const denied = await call(runtime!.port, "/add", { user_id: "u1", content: "x" });
    expect(denied.status).toBe(401);
    const allowed = await call(runtime!.port, "/add", { user_id: "u1", content: "x" }, { authorization: "Bearer test-key" });
    expect(allowed.status).toBe(200);
  });

  it("缺参 400；health 200", async () => {
    dir = mkdtempSync(join(tmpdir(), "aml-"));
    runtime = await startAdapter({ root: dir });
    const bad = await call(runtime!.port, "/search", { user_id: "u1" });
    expect(bad.status).toBe(400);
    const health = await fetch(`http://127.0.0.1:${runtime!.port}/health`);
    expect(health.status).toBe(200);
  });
});
