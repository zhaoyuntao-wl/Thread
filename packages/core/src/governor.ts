import type { EventKind } from "./events.js";

export interface SpillDecision {
  spill: boolean;
  kept: string;
  ref?: string;
}

// 大正文 spill：正文 > 阈值 → 保留前 keptChars 字符摘要 + ref 引用；原文进 spills 表或指向底座日志
export class SpillPolicy {
  constructor(
    private threshold = 4096,
    private keptChars = 400,
  ) {}

  evaluate(body: string, opts: { ref?: string } = {}): SpillDecision {
    if (body.length <= this.threshold) {
      return { spill: false, kept: body };
    }
    return { spill: true, kept: body.slice(0, this.keptChars), ref: opts.ref };
  }
}

// FTS 分层：只索引轻量文本（indexable），tool_call/tool_result 大块不建全文索引，检索按引用回拉
export const INDEXABLE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "user_message",
  "assistant_message",
  "compact_checkpoint",
]);

export function isIndexable(kind: EventKind): boolean {
  return INDEXABLE_KINDS.has(kind);
}
