// handoff 价值实验的评分核心：纯函数，便于单测（不碰进程与文件系统）。
export type arm = "push" | "memory" | "none";

export const CURATED_STEP = "先跑回归再动检索层";
export const STALE_STEP = "重构检索层（旧计划，尚未确认）";
export const DECISION_TECH = "BM25";

export interface RunSample {
  arm: arm;
  recall: boolean;
  curated: boolean;
  stale: boolean;
  queries: number;
  delivered: number;
  seconds: number;
}

export interface ArmSummary {
  n: number;
  recall: number;
  curated: number;
  stale: number;
  avgQueries: number;
  delivered: number;
  avgSeconds: number;
}

export function scoreAnswer(text: string): Pick<RunSample, "recall" | "curated" | "stale"> {
  return {
    recall: /bm25/i.test(text),
    curated: text.includes(CURATED_STEP.slice(0, 4)),
    stale: text.includes("重构检索层"),
  };
}

export function summarize(samples: RunSample[]): Record<arm, ArmSummary> {
  const arms: arm[] = ["push", "memory", "none"];
  const result = {} as Record<arm, ArmSummary>;
  for (const name of arms) {
    const rows = samples.filter((s) => s.arm === name);
    const avg = (pick: (s: RunSample) => number): number =>
      rows.length === 0 ? 0 : Number((rows.reduce((sum, s) => sum + pick(s), 0) / rows.length).toFixed(2));
    result[name] = {
      n: rows.length,
      recall: rows.filter((s) => s.recall).length,
      curated: rows.filter((s) => s.curated).length,
      stale: rows.filter((s) => s.stale).length,
      avgQueries: avg((s) => s.queries),
      delivered: rows.filter((s) => s.delivered > 0).length,
      avgSeconds: Math.round(avg((s) => s.seconds)),
    };
  }
  return result;
}

export function renderReport(summary: Record<arm, ArmSummary>, k: number): string {
  const row = (label: string, pick: (s: ArmSummary) => string | number): string =>
    `| ${label} | ${pick(summary.push)} | ${pick(summary.memory)} | ${pick(summary.none)} |`;
  return [
    `# handoff 价值实验（k=${k}，三臂）`,
    "",
    "| 指标 | 推送交接 | 有记忆不推送 | 无 Thread |",
    "|---|---|---|---|",
    row("召回已定方案", (s) => `${s.recall}/${s.n}`),
    row("采用策展下一步", (s) => `${s.curated}/${s.n}`),
    row("沿用旧计划", (s) => `${s.stale}/${s.n}`),
    row("平均查询次数", (s) => s.avgQueries),
    row("平均耗时（秒）", (s) => s.avgSeconds),
    row("交接已投递", (s) => `${s.delivered}/${s.n}`),
    "",
    "读法：召回由记忆层提供（推送/自取都可能达标）；策展的下一步只有交接能带过来；查询次数与耗时反映接手成本。",
  ].join("\n");
}
