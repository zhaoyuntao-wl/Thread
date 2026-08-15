import { describe, expect, it } from "vitest";
import { extractBlockedTokens, matchToolFeedback } from "./feedback-guard.js";
import type { FeedbackRow } from "./store.js";

const row = (text: string, kind: "preference" | "correction" = "correction"): FeedbackRow =>
  ({ id: 1, session_id: "s1", text, kind, created_at: "2026-08-15T00:00:00Z" }) as FeedbackRow;

describe("extractBlockedTokens（B⑥-② 禁用指令 token 提取）", () => {
  it("提取中文指令后的工具名", () => {
    expect(extractBlockedTokens("不要用 pwsh 直接改文件")).toContain("pwsh");
    expect(extractBlockedTokens("别再用 Read 读大文件")).toContain("read");
    expect(extractBlockedTokens("禁止调用 query_session_memory 做验证")).toContain("query_session_memory");
  });

  it("提取英文指令后的工具名", () => {
    expect(extractBlockedTokens("never use bash")).toContain("bash");
    expect(extractBlockedTokens("don't call git_commit")).toContain("git_commit");
    expect(extractBlockedTokens("avoid using pwsh")).toContain("pwsh");
  });

  it("无禁用指令时返回空", () => {
    expect(extractBlockedTokens("我记下了用 JWT 做认证")).toHaveLength(0);
    expect(extractBlockedTokens("项目决策：状态卡预算 200 行")).toHaveLength(0);
  });
});

describe("matchToolFeedback（工具名匹配）", () => {
  it("命中：token 与工具名相等（大小写不敏感）", () => {
    const hit = matchToolFeedback([row("不要用 pwsh 改配置")], "pwsh");
    expect(hit?.text).toContain("pwsh");
  });

  it("命中：工具名包含 token（如 edit → edit_file）", () => {
    const hit = matchToolFeedback([row("不要用 edit 直接改")], "edit_file");
    expect(hit?.text).toContain("edit");
  });

  it("不命中：无关教训", () => {
    expect(matchToolFeedback([row("不要用 pwsh 改配置")], "read")).toBeUndefined();
  });

  it("不命中：短 token 不参与包含匹配（噪声防护）", () => {
    // "别问了" 提取中文 token，不影响任何英文工具名
    expect(matchToolFeedback([row("以后别问了")], "write")).toBeUndefined();
  });

  it("命中后返回第一条匹配教训原文", () => {
    const rows = [row("第一条无关"), row("不要用 grep"), row("也不要再用 grep")];
    expect(matchToolFeedback(rows, "grep")?.text).toBe("不要用 grep");
  });
});
