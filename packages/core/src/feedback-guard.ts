import type { FeedbackRow } from "./store.js";

// B⑥-② 反馈拦截：确定性提取"禁用指令"里的目标工具名，与待执行工具名匹配。
// 零 LLM、同步——误报可接受（阻断成本低，拒绝原因即教训原文，可见可纠偏）。
const BLOCK_PATTERNS: RegExp[] = [
  /不要(?:再|直接|再直接)?(?:用|使用|调用)?\s*[`'"]?([A-Za-z_][\w-]{2,}|[\u4e00-\u9fa5]{2,8})[`'"]?/g,
  /(?:别|禁止|禁用|勿)(?:再|直接|再直接)?(?:用|使用|调用)?\s*[`'"]?([A-Za-z_][\w-]{2,}|[\u4e00-\u9fa5]{2,8})[`'"]?/g,
  /never\s+(?:use|call)\s+[`'"]?([A-Za-z_][\w-]{2,})[`'"]?/gi,
  /don'?t\s+(?:use|call)\s+[`'"]?([A-Za-z_][\w-]{2,})[`'"]?/gi,
  /avoid\s+(?:using|calling)?\s*[`'"]?([A-Za-z_][\w-]{2,})[`'"]?/gi,
];

export function extractBlockedTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const pattern of BLOCK_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const token = m[1];
      if (token) {
        tokens.add(token.toLowerCase());
      }
    }
  }
  return [...tokens];
}

export function matchToolFeedback(
  rows: readonly FeedbackRow[],
  toolName: string,
): FeedbackRow | undefined {
  const name = toolName.toLowerCase();
  for (const row of rows) {
    for (const token of extractBlockedTokens(row.text)) {
      if (token === name || (token.length >= 3 && name.includes(token))) {
        return row;
      }
    }
  }
  return undefined;
}
