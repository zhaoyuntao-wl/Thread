import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractLastAssistantTurn, parseHookEvent } from "./ingest.js";

const dir = mkdtempSync(join(tmpdir(), "thread-ingest-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  session_id: "s1",
  transcript_path: join(dir, "t.jsonl"),
  cwd: join(dir, "repo"),
};

describe("parseHookEvent", () => {
  it("maps UserPromptSubmit to user_message with prompt body", () => {
    const ev = parseHookEvent({
      ...BASE,
      hook_event_name: "UserPromptSubmit",
      prompt: "帮我实现登录功能",
    });
    expect(ev?.kind).toBe("user_message");
    expect(ev?.body).toBe("帮我实现登录功能");
    expect(ev?.meta).toMatchObject({ transcript_path: BASE.transcript_path });
  });

  it("maps PreToolUse to tool_call with tool and file lineage meta", () => {
    const ev = parseHookEvent({
      ...BASE,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "src/auth.ts", content: "x" },
    });
    expect(ev?.kind).toBe("tool_call");
    expect(ev?.body).toContain("Write");
    expect(ev?.meta).toMatchObject({ tool_name: "Write", file_path: "src/auth.ts" });
  });

  it("maps PostToolUse to tool_result", () => {
    const ev = parseHookEvent({
      ...BASE,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_response: { kind: "completed" },
    });
    expect(ev?.kind).toBe("tool_result");
    expect(ev?.body).toContain("completed");
  });

  it("uses assistant text from Stop payload when present", () => {
    const ev = parseHookEvent({
      ...BASE,
      hook_event_name: "Stop",
      message: "我记下了使用 JWT 做认证",
    });
    expect(ev?.kind).toBe("assistant_message");
    expect(ev?.body).toBe("我记下了使用 JWT 做认证");
    expect(ev?.meta?.assistant_text_pending).toBe(false);
  });

  it("marks Stop events without text as pending transcript extraction", () => {
    const ev = parseHookEvent({ ...BASE, hook_event_name: "Stop" });
    expect(ev?.kind).toBe("assistant_message");
    expect(ev?.body).toBe("");
    expect(ev?.meta?.assistant_text_pending).toBe(true);
  });

  it("drops events without session_id", () => {
    expect(parseHookEvent({ hook_event_name: "Stop" })).toBeUndefined();
    expect(parseHookEvent(null)).toBeUndefined();
    expect(parseHookEvent("not json")).toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")(
    "normalizes absolute file paths relative to cwd",
    () => {
      const ev = parseHookEvent({
        ...BASE,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "D:\\Agent-work\\workspace\\Thread\\src\\auth.ts" },
        cwd: "D:\\Agent-work\\workspace\\Thread",
      });
      expect(ev?.meta?.file_path).toBe("src/auth.ts");
    },
  );
});

describe("extractLastAssistantTurn", () => {
  it("extracts the last non-sidechain assistant text from a transcript", () => {
    const transcript = join(dir, "extract.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "user", uuid: "u1", message: { content: [{ type: "text", text: "hi" }] } }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          isSidechain: true,
          message: { content: [{ type: "text", text: "sidechain noise" }] },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a2",
          message: {
            content: [
              { type: "text", text: "我记下了用 Vite" },
              { type: "tool_use", name: "Bash", input: { command: "ls" } },
            ],
          },
        }),
        JSON.stringify({ type: "active-leaf", sessionId: "s1", leafUuid: "a2" }),
      ].join("\n") + "\n",
    );
    const turn = extractLastAssistantTurn(transcript);
    expect(turn).toEqual({ uuid: "a2", text: "我记下了用 Vite" });
  });

  it("returns undefined for missing or assistant-free transcripts", () => {
    expect(extractLastAssistantTurn(undefined)).toBeUndefined();
    expect(extractLastAssistantTurn(join(dir, "nope.jsonl"))).toBeUndefined();
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, JSON.stringify({ type: "user", uuid: "u1" }) + "\n");
    expect(extractLastAssistantTurn(empty)).toBeUndefined();
  });
});
