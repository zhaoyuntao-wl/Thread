// 结果报表（spec §5）：把逐格 score.json 汇总成回帖可用的表格 + 逐格记录附录。
// 只报 count/k 与原始记录，不做显著性宣称（D10 表述纪律）。
// 用法：node dist/trial/report-trial.js --runs=<runs 根> --stage=stage1 [--out=report.md]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface Score {
  run: string;
  schedule: string;
  arm: string;
  index: number;
  taskVariant: string;
  exitCode: number | null;
  fixtureValid: boolean | null;
  recovery: { pass: boolean; reasons: string[]; detail: Record<string, unknown> };
  lookup: { called: boolean; beforeFirstAction: boolean | null; returnedDecision: boolean; returnedHasClause: boolean; resultHash: string | null; sourceEventId: number | null; pass: boolean };
}

function main() {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "..", "..");
  const runsRoot = arg("runs") ?? join(repoRoot, ".trial", "runs");
  const stage = arg("stage") ?? "stage1";
  const stageRoot = join(runsRoot, stage);
  if (!existsSync(stageRoot)) throw new Error(`no runs at ${stageRoot}`);

  const scores: Score[] = [];
  for (const entry of readdirSync(stageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scorePath = join(stageRoot, entry.name, "score.json");
    if (existsSync(scorePath)) scores.push(JSON.parse(readFileSync(scorePath, "utf8")) as Score);
  }
  scores.sort((a, b) => (a.schedule + a.arm + String(a.index)).localeCompare(b.schedule + b.arm + String(b.index)));

  const armLabel: Record<string, string> = { old: "old card (1.0.11, anchor)", noanchor: "old card, no anchor", new: "new card (1.0.12, anchor)" };
  const cells = new Map<string, Score[]>();
  for (const s of scores) {
    const key = `${s.schedule}||${s.arm}`;
    cells.set(key, [...(cells.get(key) ?? []), s]);
  }

  const lines: string[] = [];
  lines.push(`# stage: ${stage}`, "", `trials scored: ${scores.length}`, "", "| cell (schedule × card) | recovery | source lookup | invalid |", "|---|---|---|---|");
  for (const [key, list] of cells) {
    const [schedule, arm] = key.split("||");
    const rec = list.filter((s) => s.recovery.pass).length;
    const look = list.filter((s) => s.lookup.pass).length;
    const invalid = list.filter((s) => s.fixtureValid !== true).length;
    lines.push(`| ${schedule} · ${armLabel[arm] ?? arm} | ${rec}/${list.length} | ${look}/${list.length} | ${invalid} |`);
  }

  lines.push("", "## per-trial records", "");
  for (const s of scores) {
    lines.push(
      `- \`${s.schedule} · ${s.arm} #${s.index}\` task=${s.taskVariant} exit=${String(s.exitCode)} fixtureValid=${String(s.fixtureValid)} ` +
        `recovery=${s.recovery.pass ? "pass" : `fail(${s.recovery.reasons.join("; ")})`} ` +
        `lookup=${s.lookup.pass ? "pass" : "fail"}(called=${String(s.lookup.called)}, beforeFirstAction=${String(s.lookup.beforeFirstAction)}, decisionDelivered=${String(s.lookup.returnedDecision)}, clauseRetained=${String(s.lookup.returnedHasClause)}, resultHash=${String(s.lookup.resultHash)}) ` +
        `commands=[${(s.recovery.detail.agentCommands as string[] | undefined)?.join(" → ") ?? ""}] finalN=${String(s.recovery.detail.finalN)}`,
    );
  }

  const outPath = arg("out") ?? join(stageRoot, "report.md");
  writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(lines.slice(0, 4 + cells.size + 2).join("\n"));
  console.log(`\nreport: ${outPath}`);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/report-trial.js");
if (isMain) main();
