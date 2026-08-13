export const MAX_BODY_CHARS = 100_000;

export type EventKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "session_start"
  | "session_end"
  | "compact_checkpoint";

export interface SessionEvent {
  id: number;
  session_id: string;
  kind: EventKind;
  ts: string;
  seq: number;
  body: string;
  meta?: Record<string, unknown>;
  truncated: boolean;
}

export function truncateBody(body: string, maxChars: number = MAX_BODY_CHARS): { body: string; truncated: boolean } {
  if (body.length <= maxChars) {
    return { body, truncated: false };
  }
  const kept = body.slice(0, maxChars);
  return { body: `${kept}\n... [truncated ${body.length - maxChars} chars]`, truncated: true };
}
