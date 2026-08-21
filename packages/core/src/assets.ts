// 产出识别（max 详细设计 0.2）：采集链确定性规则，零 LLM。
// 判定 = 工具名 × 文件路径 × 内容首行；产出 → knowledge_assets 登记（store.registerAsset 写时建边）。
// 解析失败降级：file_path 缺失 → undefined（旁路可失败不阻塞主路径）。

export interface AssetClassification {
  isAsset: boolean;
  kind: "document" | "report";
  /** 文档路径（原样保留，Windows 反斜杠不动）；报告为合成路径 reports/<tool>-<callId>.md */
  path: string;
  /** 首行 # 标题（截 80）；兜底 = 文件 basename / 报告名 */
  title: string;
  /** 标题提取来源（write 的 content / edit 的 new_string / report 的 output） */
  content?: string;
}

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "create_file",
  "write_to_file",
  "replace_in_file",
  "apply_patch",
  "str_replace_editor",
]);

const REPORT_TOOLS = new Set(["report", "subagent-report", "subagent_report"]);

const TITLE_MAX = 80;

export function parseToolArgs(argumentsRaw: unknown): Record<string, unknown> | undefined {
  if (typeof argumentsRaw === "string") {
    try {
      return JSON.parse(argumentsRaw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (argumentsRaw && typeof argumentsRaw === "object") {
    return argumentsRaw as Record<string, unknown>;
  }
  return undefined;
}

export function extractTitleFromContent(content: string | undefined, fallback: string): string {
  if (content) {
    const m = content.match(/^\s*#+\s+(.+)$/m);
    if (m) {
      const t = m[1].trim().replace(/\s+/g, " ");
      if (t) {
        return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
      }
    }
  }
  const base = fallback.replace(/\\/g, "/").split("/").pop() ?? fallback;
  return base.length > TITLE_MAX ? `${base.slice(0, TITLE_MAX)}…` : base;
}

// 文档产出：write/edit 类工具 + 目标为 .md 文件（路径归一化后判定，存储保留原路径）。
// 隐藏目录排除（2026-08-21 狗粮实证）：.changeset/.git 等隐藏目录下的 md 是工程记录不是产出——
// 模型常反复编辑它们，自动登记既制造噪音又推高重复行。
export function classifyWriteEvent(toolName: string, args: unknown): AssetClassification | undefined {
  if (!WRITE_TOOLS.has(toolName)) {
    return undefined;
  }
  const parsed = parseToolArgs(args);
  const filePath = typeof parsed?.file_path === "string" ? parsed.file_path : undefined;
  if (!filePath || !/\.md$/i.test(filePath.replace(/\\/g, "/"))) {
    return undefined;
  }
  if (isHiddenPath(filePath)) {
    return undefined;
  }
  const content =
    typeof parsed?.content === "string"
      ? parsed.content
      : typeof parsed?.new_string === "string"
        ? parsed.new_string
        : undefined;
  return { isAsset: true, kind: "document", path: filePath, title: extractTitleFromContent(content, filePath), content };
}

// 隐藏目录判定：任一路径段以 . 开头（. 与 .. 除外）——与 expandAssetPaths 的目录递归跳过策略一致
function isHiddenPath(p: string): boolean {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");
}

// 报告标题：output 首个非空行（去 markdown # 前缀），兜底工具名
function firstLineTitle(output: string | undefined, fallback: string): string {
  if (output) {
    const line = output.split("\n").find((l) => l.trim() !== "")?.trim().replace(/\s+/g, " ").replace(/^#+\s*/, "");
    if (line) {
      return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
    }
  }
  const base = fallback.replace(/\\/g, "/").split("/").pop() ?? fallback;
  return base.length > TITLE_MAX ? `${base.slice(0, TITLE_MAX)}…` : base;
}

// 报告产出：report/subagent-report 工具，标题 = 参数 output 首行
export function classifyReportEvent(toolName: string, args: unknown, callId?: string): AssetClassification | undefined {
  if (!REPORT_TOOLS.has(toolName)) {
    return undefined;
  }
  const parsed = parseToolArgs(args);
  const output =
    typeof parsed?.output === "string"
      ? parsed.output
      : typeof parsed?.content === "string"
        ? parsed.content
        : typeof args === "string"
          ? args
          : undefined;
  const syntheticPath = `reports/${toolName}${callId ? `-${callId}` : ""}.md`;
  return {
    isAsset: true,
    kind: "report",
    path: syntheticPath,
    title: firstLineTitle(output, `${toolName}${callId ? ` ${callId}` : ""}`),
    content: output,
  };
}
