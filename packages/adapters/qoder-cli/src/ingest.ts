import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { SessionEvent } from "@thread-memory/core";

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
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

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
          tool_use_id: ev.tool_use_id,
          tool_input: ev.tool_input,
          file_path: normalizeFilePath(extractFilePath(ev.tool_input), ev.cwd),
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
          file_path: normalizeFilePath(extractFilePath(ev.tool_input), ev.cwd),
          transcript_path: ev.transcript_path,
        },
      };
    case "Stop": {
      const payloadText = assistantTextFromPayload(ev);
      return {
        ...base,
        kind: "assistant_message",
        body: payloadText ?? "",
        meta: {
          transcript_path: ev.transcript_path,
          assistant_text_pending: payloadText === undefined,
        },
      };
    }
    case "PostCompact":
      return {
        ...base,
        kind: "compact_checkpoint",
        body: typeof ev.compact_summary === "string" ? ev.compact_summary : "",
        meta: {
          trigger: ev.trigger,
          model: ev.model,
          transcript_path: ev.transcript_path,
          cwd: ev.cwd,
        },
      };
    default:
      return undefined;
  }
}

export interface AssistantTurn {
  uuid: string;
  text: string;
}

export function extractLastAssistantTurn(transcriptPath: string | undefined): AssistantTurn | undefined {
  if (!transcriptPath) {
    return undefined;
  }
  let chunk: string;
  let start: number;
  try {
    const size = statSync(transcriptPath).size;
    start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const fd = openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      chunk = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }

  const lines = chunk.split("\n");
  const firstComplete = start === 0 ? 0 : 1;
  for (let i = lines.length - 1; i >= firstComplete; i--) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    let entry: { type?: string; isSidechain?: boolean; uuid?: string; message?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" || entry.isSidechain) {
      continue;
    }
    const text = extractTextFromMessage(entry.message);
    if (text) {
      return { uuid: typeof entry.uuid === "string" ? entry.uuid : "", text };
    }
  }
  return undefined;
}

function assistantTextFromPayload(ev: HookEvent): string | undefined {
  for (const field of ["message", "final_message", "assistant_message", "reply"]) {
    const value = ev[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function extractTextFromMessage(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : undefined;
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

function normalizeFilePath(filePath: string | undefined, cwd: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  if (cwd && isAbsolute(filePath)) {
    const rel = relative(cwd, filePath);
    if (!rel.startsWith("..")) {
      return rel.split(sep).join("/");
    }
  }
  return filePath.split(sep).join("/");
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
