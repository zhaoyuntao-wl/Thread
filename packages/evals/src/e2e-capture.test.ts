import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectKeyHash, ThreadStore } from "@thread-memory/core";

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}

const repoRoot = findRepoRoot();
const captureScript = join(repoRoot, "scripts", "capture.mjs");

let dir: string;
let root: string;
let eventsPath: string;
let structuredPath: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-e2e-"));
  root = join(dir, "thread-root");
  // capture 按 cwd 推导项目键 hash 定位事件库
  eventsPath = join(root, "projects", deriveProjectKeyHash(repoRoot), "events.db");
  structuredPath = join(root, "structured.db");
});

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

function capture(payload: unknown): void {
  const res = spawnSync(process.execPath, [captureScript], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, THREAD_ROOT: root },
  });
  expect(res.status, res.stderr).toBe(0);
}

describe("capture.mjs production pipeline (B④ 双库)", () => {
  it("captures user prompts and populates structured tables", () => {
    capture({
      session_id: "e2e-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "帮我实现登录功能",
      cwd: repoRoot,
    });
    store = new ThreadStore({ eventsPath, structuredPath });
    const events = store.getRecentEvents("e2e-1", 10);
    expect(events.some((e) => e.kind === "user_message" && e.body === "帮我实现登录功能")).toBe(true);
    expect(store.getActiveGoals("e2e-1").map((g) => g.text)).toEqual(["帮我实现登录功能"]);
  });

  it("captures assistant replies from the transcript without NL proposals（2026-08-21 结构通道化）", () => {
    const transcript = join(dir, "e2e.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "user", uuid: "u1", message: { content: [{ type: "text", text: "帮我实现登录功能" }] } }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          message: { content: [{ type: "text", text: "我记下了使用 JWT 做认证" }] },
        }),
      ].join("\n") + "\n",
    );
    capture({
      session_id: "e2e-1",
      hook_event_name: "Stop",
      transcript_path: transcript,
    });
    store.close();
    store = new ThreadStore({ eventsPath, structuredPath });
    const events = store.getRecentEvents("e2e-1", 10);
    const assistant = events.find((e) => e.kind === "assistant_message");
    expect(assistant?.body).toBe("我记下了使用 JWT 做认证");
    // assistant 文本不再提案决策（模型通道 = record_decision 工具）
    expect(store.getDecisions("e2e-1")).toHaveLength(0);
  });

  it("/thread-reg dec 命令创建 active 决策（用户显式通道；2026-08-21 命令重构）", () => {
    capture({
      session_id: "e2e-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "/thread-reg dec 使用 JWT 做认证",
      cwd: repoRoot,
    });
    store.close();
    store = new ThreadStore({ eventsPath, structuredPath });
    const decisions = store.getActiveDecisions("e2e-1");
    expect(decisions.some((d) => d.text === "使用 JWT 做认证")).toBe(true);
  });

  it("read 工具流（md 内容经 tool 事件进入）→ 结构化表零行（2026-08-21 读文件免疫）", () => {
    const mdContent = [
      "# 角色",
      "你是一个资深工程师",
      "帮我实现登录模块",
      "## 要求",
      "- 支持 JWT",
      "- 以后优先用 pnpm",
    ].join("\n");
    capture({
      session_id: "e2e-3",
      hook_event_name: "PreToolUse",
      tool_name: "read",
      tool_use_id: "call_read_1",
      tool_input: { file_path: "prompt.md" },
      cwd: repoRoot,
    });
    capture({
      session_id: "e2e-3",
      hook_event_name: "PostToolUse",
      tool_name: "read",
      tool_use_id: "call_read_1",
      tool_input: { file_path: "prompt.md" },
      tool_response: { kind: "completed", content: mdContent },
      cwd: repoRoot,
    });
    store.close();
    store = new ThreadStore({ eventsPath, structuredPath });
    expect(store.getActiveGoals("e2e-3")).toHaveLength(0);
    expect(store.getDecisions("e2e-3")).toHaveLength(0);
    expect(store.getFeedback("e2e-3")).toHaveLength(0);
    // 事件流水保留原文（真相源不变）
    const results = store
      .getRecentEvents("e2e-3", 10)
      .filter((e) => e.kind === "tool_result");
    expect(results.length).toBeGreaterThan(0);
  });

  it("records file lineage edges from tool results", () => {
    capture({
      session_id: "e2e-1",
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "src/auth.ts" },
      tool_response: { kind: "completed" },
      cwd: repoRoot,
    });
    store.close();
    store = new ThreadStore({ eventsPath, structuredPath });
    expect(store.getEventsForFile("e2e-1", "src/auth.ts").length).toBe(1);
  });

  it("captures tool_call with qoder://toolcall origin and dedupes on replay", () => {
    const payload = {
      session_id: "e2e-2",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "call_00_dedupe1",
      tool_input: { command: "ls" },
      cwd: repoRoot,
    };
    capture(payload);
    capture(payload);
    store.close();
    store = new ThreadStore({ eventsPath, structuredPath });
    const calls = store
      .getRecentEvents("e2e-2", 10)
      .filter((e) => e.kind === "tool_call" && e.meta?.tool_use_id === "call_00_dedupe1");
    expect(calls).toHaveLength(1);
  });
});
