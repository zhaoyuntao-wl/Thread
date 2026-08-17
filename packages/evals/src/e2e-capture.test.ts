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

  it("captures assistant replies from the transcript and proposes decisions", () => {
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
    expect(store.getLatestProposed("e2e-1")?.text).toBe("使用 JWT 做认证");
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
