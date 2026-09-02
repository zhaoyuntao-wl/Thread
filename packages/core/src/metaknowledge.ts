// metaknowledge 边界标注（2026-09-02 迭代 B，R3 三件套）：传达"知道什么 / 不知道什么 / 需要查什么"。
// 判定纪律（决策 #29）：边界声明 = 静态文本；检索建议词 = 行文本 stopword 过滤后前 2 词（位置优先，无语义判断）；
// 溯源锚 = 结构化行 #id（query kind=decision 可定位原文出处）+ 声明"卡片未列出≠不存在"。
import { segmentQuery } from "./segment.js";

export const MEMORY_BOUNDARY =
  "记忆边界：卡片只含生效状态摘要；完整决策链/事件原文经 query_session_memory 可查，卡片未列出≠不存在，未记录内容不在记忆内。";

// 检索建议词：stopword 过滤后的前 2 个实义词（空格连接），供模型"深挖"时直接作 query
export function buildQuerySuggestions(text: string): string {
  return segmentQuery(text).slice(0, 2).join(" ");
}

export function suggestionsFrom(rows: Array<{ text: string }>, max = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const q = buildQuerySuggestions(row.text);
    if (!q || seen.has(q)) {
      continue;
    }
    seen.add(q);
    out.push(`query='${q}'`);
    if (out.length >= max) {
      break;
    }
  }
  return out;
}
