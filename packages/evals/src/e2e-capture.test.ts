import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ThreadStore } from "@thread/core";

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
let dbPath: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-e2e-"));
  dbPath = join(dir, "e2e.db");
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
    env: { ...process.env, THREAD_DB: dbPath },
  });
  expect(res.status, res.stderr).toBe(0);
}

describe("capture.mjs production pipeline", () => {
  it("captures user prompts and populates structured tables", () => {
    capture({
      session_id: "e2e-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "帮我实现登录功能",
      cwd: repoRoot,
    });
    store = new ThreadStore({ path: dbPath });
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
    store = new ThreadStore({ path: dbPath });
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
    store = new ThreadStore({ path: dbPath });
    expect(store.getEventsForFile("e2e-1", "src/auth.ts").length).toBe(1);
  });
});
