import { describe, expect, it } from "vitest";
import { classifyReportEvent, classifyWriteEvent, extractTitleFromContent, parseToolArgs } from "./assets.js";

describe("parseToolArgs（dsh 字符串 / Qoder 对象双形态）", () => {
  it("JSON 字符串 → 对象", () => {
    expect(parseToolArgs('{"file_path": "a.md"}')).toEqual({ file_path: "a.md" });
  });
  it("非 JSON 字符串 → undefined（解析失败降级）", () => {
    expect(parseToolArgs("not json")).toBeUndefined();
  });
  it("对象原样返回", () => {
    const obj = { file_path: "a.md" };
    expect(parseToolArgs(obj)).toBe(obj);
  });
  it("undefined/null → undefined", () => {
    expect(parseToolArgs(undefined)).toBeUndefined();
    expect(parseToolArgs(null)).toBeUndefined();
  });
});

describe("extractTitleFromContent（首行 # 标题，截 80）", () => {
  it("取首个 markdown 标题", () => {
    expect(extractTitleFromContent("说明\n# 我的标题\n正文", "x.md")).toBe("我的标题");
  });
  it("多级 # 与多余空白", () => {
    expect(extractTitleFromContent("###   压缩治理  \n", "x.md")).toBe("压缩治理");
  });
  it("无标题 → basename 兜底", () => {
    expect(extractTitleFromContent("没有标题", "docs/a/b.md")).toBe("b.md");
    expect(extractTitleFromContent("", "D:\\x\\y.md")).toBe("y.md");
  });
  it("超长截断 80", () => {
    const long = "# " + "长".repeat(100);
    const t = extractTitleFromContent(long, "x.md");
    expect(t.length).toBeLessThanOrEqual(81);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("classifyWriteEvent（文档产出：write/edit 类 × .md 路径）", () => {
  it("write docs/**/*.md → document asset，标题 = content 首行", () => {
    const c = classifyWriteEvent("write", JSON.stringify({ file_path: "docs/local/design/v2/x.md", content: "# 设计 v3\n正文" }));
    expect(c?.isAsset).toBe(true);
    expect(c?.kind).toBe("document");
    expect(c?.path).toBe("docs/local/design/v2/x.md");
    expect(c?.title).toBe("设计 v3");
  });
  it("Windows 反斜杠路径可识别，存储保留原路径", () => {
    const c = classifyWriteEvent("write", { file_path: "D:\\work\\docs\\a.md" });
    expect(c?.isAsset).toBe(true);
    expect(c?.path).toBe("D:\\work\\docs\\a.md");
  });
  it("edit 工具取 new_string 首行", () => {
    const c = classifyWriteEvent("edit", { file_path: "README.md", new_string: "# 新标题\n内容" });
    expect(c?.title).toBe("新标题");
  });
  it("非 .md 路径 → 不识别", () => {
    expect(classifyWriteEvent("write", { file_path: "src/index.ts", content: "# x" })).toBeUndefined();
  });
  it("缺 file_path → 不识别（采集缺陷降级）", () => {
    expect(classifyWriteEvent("write", { content: "# x" })).toBeUndefined();
  });
  it("非 write 类工具 → 不识别", () => {
    expect(classifyWriteEvent("read", { file_path: "docs/a.md" })).toBeUndefined();
  });
  it("隐藏目录下的 md → 不识别（2026-08-21 狗粮实证：.changeset 噪音）", () => {
    expect(classifyWriteEvent("write", { file_path: ".changeset/feature.md", content: "# 变更" })).toBeUndefined();
    expect(classifyWriteEvent("write", { file_path: "repo/.changeset/x.md", content: "# 变更" })).toBeUndefined();
    expect(classifyWriteEvent("write", { file_path: "D:\\work\\.changeset\\x.md", content: "# 变更" })).toBeUndefined();
    // 正常目录不受影响
    expect(classifyWriteEvent("write", { file_path: "docs/design.md", content: "# 正常" })?.isAsset).toBe(true);
  });
});

describe("classifyReportEvent（报告产出：report/subagent-report）", () => {
  it("report 工具 → report asset，标题 = output 首行", () => {
    const c = classifyReportEvent("report", { output: "调研报告\n正文" }, "call-1");
    expect(c?.isAsset).toBe(true);
    expect(c?.kind).toBe("report");
    expect(c?.path).toBe("reports/report-call-1.md");
    expect(c?.title).toBe("调研报告");
  });
  it("subagent-report 无 callId", () => {
    const c = classifyReportEvent("subagent-report", { content: "# 子代理结论" });
    expect(c?.path).toBe("reports/subagent-report.md");
    expect(c?.title).toBe("子代理结论");
  });
  it("非报告工具 → 不识别", () => {
    expect(classifyReportEvent("pwsh", { output: "x" })).toBeUndefined();
  });
});
