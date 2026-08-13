import type { SessionEvent } from "@thread/core";

interface HookEvent {
  session_id?: string;
  hook_event_name?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  [key: string]: unknown;
}

const TOOL_BODY_PREFIX = 2000;

export function parseHookEvent(
  hookEvent: unknown,
  opts: { ts?: string } = {},
): Omit<SessionEvent, "id" | "seq" | "truncated"> | undefined {
  if (typeof hookEvent !== "object" || hookEvent === null) {
    return undefined;
  }
  const ev = hookEvent as HookEvent;
  if (typeof ev.session_id !== "string" || ev.session_id.length === 0) {
    return undefined;
  }
  const ts = opts.ts ?? new Date().toISOString();
  const base = { session_id: ev.session_id, ts };

  switch (ev.hook_event_name) {
    case "UserPromptSubmit":
      return {
        ...base,
        kind: "user_message",
        body: typeof ev.prompt === "string" && ev.prompt.length > 0 ? ev.prompt : stringify(ev),
        meta: { transcript_path: ev.transcript_path, cwd: ev.cwd },
      };
    case "PreToolUse":
      return {
        ...base,
        kind: "tool_call",
        body: buildToolCallBody(ev),
        meta: {
          tool_name: ev.tool_name,
          tool_input: ev.tool_input,
          file_path: extractFilePath(ev.tool_input),
          transcript_path: ev.transcript_path,
        },
      };
    case "PostToolUse":
      return {
        ...base,
        kind: "tool_result",
        body: stringify(ev.tool_response),
        meta: {
          tool_name: ev.tool_name,
          tool_use_id: ev.tool_use_id,
          file_path: extractFilePath(ev.tool_input),
          transcript_path: ev.transcript_path,
        },
      };
    case "Stop":
      return {
        ...base,
        kind: "assistant_message",
        body: "[assistant turn completed]",
        meta: { transcript_path: ev.transcript_path },
      };
    default:
      return undefined;
  }
}

function buildToolCallBody(ev: HookEvent): string {
  const name = typeof ev.tool_name === "string" ? ev.tool_name : "tool";
  const args = stringify(ev.tool_input);
  const summary = args.length > TOOL_BODY_PREFIX ? `${args.slice(0, TOOL_BODY_PREFIX)}...` : args;
  return `${name} 调用参数：${summary}`;
}

function extractFilePath(toolInput: unknown): string | undefined {
  if (typeof toolInput !== "object" || toolInput === null) {
    return undefined;
  }
  const path = (toolInput as Record<string, unknown>).file_path;
  return typeof path === "string" ? path : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
