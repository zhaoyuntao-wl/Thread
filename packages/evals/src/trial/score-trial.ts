// 评分（spec D5 / §5 / §6-4）：recovery 与 source-lookup **分开**，全部从夹具 ledger（有序命令 + 扩展码 + 墙钟）
// 与会话事件（tool/call、tool/result）判定——不看模型自己的解释，也不看 stdout。
// 用法：node dist/trial/score-trial.js --runs=<runs 根> [--stage=stage1]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const DECISION_MARK = "SQLite 写失败时先用有界等待";
const CLAUSE_MARK = "必须回滚、在新事务里重读";

interface Ledger {
  t: number;
  wall: number;
  actor: "fixture" | "agent";
  cmd: string;
  ok: boolean;
  code?: string;
  extendedCode?: number;
  n?: number | null;
  timeoutMs?: number;
  ms?: number;
  detail?: string;
}

const STATE_CHANGING = (cmd: string, ok: boolean) => ok && /^R\.(BEGIN|ROLLBACK|COMMIT)|^R\.write/.test(cmd);

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return undefined;
      }
    })
    .filter((x): x is T => x !== undefined);
}

interface RecoveryVerdict {
  pass: boolean;
  reasons: string[];
  detail: Record<string, unknown>;
}

function scoreRecovery(schedule: string, ledger: Ledger[], final: { n?: number | null; rInTransaction?: boolean } | undefined, validityValid: boolean | null): RecoveryVerdict {
  const reasons: string[] = [];
  const agent = ledger.filter((e) => e.actor === "agent");
  const okWrites = agent.filter((e) => e.cmd === "R.write(+1)" && e.ok);
  const okCommits = agent.filter((e) => e.cmd === "R.COMMIT" && e.ok);
  const rollback = agent.find((e) => e.cmd === "R.ROLLBACK" && e.ok);
  const busy = agent.find((e) => !e.ok && e.code === "SQLITE_BUSY");
  // 517 由**夹具在交接前**制造（spec §3 schedule 2），不是要求 agent 自己撞一次：
  // 直接回滚重来的 agent 是正确行为，不该因为"没亲眼看到 517"被判失败（2026-10-07 修）。
  const snapshot = ledger.find((e) => !e.ok && e.code === "SQLITE_BUSY_SNAPSHOT");
  const detail: Record<string, unknown> = {
    agentCommands: agent.map((e) => `${e.cmd}${e.ok ? "" : `(${e.code})`}${e.timeoutMs !== undefined ? `@${e.timeoutMs}ms` : ""}`),
    okWrites: okWrites.length,
    okCommits: okCommits.length,
    finalN: final?.n ?? null,
    rInTransaction: final?.rInTransaction ?? null,
  };

  if (validityValid !== true) reasons.push("夹具有效性未通过");
  if (final?.n === undefined || final?.n === null) reasons.push("缺少终态");
  if (final?.rInTransaction !== false) reasons.push("R 仍有未关闭事务");
  if (okCommits.length !== 1) reasons.push(`接收方提交次数 = ${okCommits.length}（应为 1）`);
  if (okWrites.length !== 1) reasons.push(`接收方成功自增次数 = ${okWrites.length}（应为 1）`);

  if (schedule === "active-writer") {
    if (busy === undefined) reasons.push("未观测到受限准入尝试（primary code 5）");
    else if ((busy.timeoutMs ?? 0) > 1000) reasons.push(`准入等待超出预算：timeoutMs=${String(busy.timeoutMs)}`);
    if (final?.n !== 1) reasons.push(`终态 n = ${String(final?.n)}（应为 1）`);
    const release = ledger.find((e) => e.cmd === "release:W.COMMIT");
    if (release !== undefined && okWrites[0] !== undefined && okWrites[0].wall < release.wall) reasons.push("在 W 释放前就写入成功（夹具未按观测释放？）");
  } else {
    if (snapshot === undefined) reasons.push("未观测到陈旧快照写失败（extended code 517）");
    if (okWrites[0] !== undefined && (rollback === undefined || okWrites[0].wall < rollback.wall)) reasons.push("回滚之前就写入成功（旧快照里不该成功）");
    if (rollback === undefined) reasons.push("未回滚陈旧事务");
    const readAfter = agent.find((e) => e.cmd === "R.read" && e.ok && e.n === 1 && (rollback === undefined || e.wall > rollback.wall));
    if (readAfter === undefined) reasons.push("回滚后未重读到当前值 1");
    if (final?.n !== 2) reasons.push(`终态 n = ${String(final?.n)}（应为 2）`);
  }
  return { pass: reasons.length === 0, reasons, detail };
}

interface LookupVerdict {
  called: boolean;
  beforeFirstAction: boolean | null;
  returnedDecision: boolean;
  returnedHasClause: boolean;
  resultHash: string | null;
  sourceEventId: number | null;
  pass: boolean;
}

function scoreLookup(evidence: { t: number; type?: string; kind?: string; sample?: string }[], ledger: Ledger[]): LookupVerdict {
  const calls = evidence.filter((e) => e.kind === "tool/call" && typeof e.sample === "string" && /query_session_memory/i.test(e.sample));
  const results = evidence.filter((e) => e.kind === "tool/result" && typeof e.sample === "string");
  const delivering = results.filter((e) => (e.sample ?? "").includes(DECISION_MARK));
  const firstAction = ledger.filter((e) => e.actor === "agent" && STATE_CHANGING(e.cmd, e.ok)).sort((a, b) => a.wall - b.wall)[0];
  const firstCall = calls.sort((a, b) => a.t - b.t)[0];
  const firstDelivery = delivering.sort((a, b) => a.t - b.t)[0];
  const sourceEventId = firstDelivery === undefined ? null : Number((firstDelivery.sample ?? "").match(/"seq":\s*(\d+)/)?.[1] ?? Number.NaN) || null;
  const before = firstCall !== undefined && firstAction !== undefined ? firstCall.t < firstAction.wall : null;
  const returnedHasClause = firstDelivery !== undefined && (firstDelivery.sample ?? "").includes(CLAUSE_MARK);
  return {
    called: firstCall !== undefined,
    beforeFirstAction: before,
    returnedDecision: firstDelivery !== undefined,
    returnedHasClause,
    resultHash: firstDelivery === undefined ? null : createHash("sha256").update(firstDelivery.sample ?? "", "utf8").digest("hex").slice(0, 16),
    sourceEventId,
    pass: before === true && firstDelivery !== undefined,
  };
}

function scoreRun(runDir: string) {
  const meta = readJson<Record<string, unknown>>(join(runDir, "run.json")) ?? {};
  const schedule = String(meta.schedule ?? "");
  const ledger = readJsonl<Ledger>(join(runDir, "fixture", "ledger.jsonl"));
  const stateFile = readJson<{ final?: { n?: number | null; rInTransaction?: boolean } }>(join(runDir, "fixture", "state.json"));
  const finalFile = readJson<{ final?: { n?: number | null; rInTransaction?: boolean } }>(join(runDir, "fixture", "final.json"));
  const validity = readJson<{ valid?: boolean }>(join(runDir, "fixture", "validity.json"));
  const evidence = readJsonl<{ t: number; type?: string; kind?: string; sample?: string }>(join(runDir, "evidence.jsonl"));
  const finalState = stateFile?.final ?? finalFile?.final;
  const recovery = scoreRecovery(schedule, ledger, finalState, validity?.valid ?? null);
  const lookup = scoreLookup(evidence, ledger);
  const score = {
    run: runDir.split(/[\\/]/).slice(-3).join("/"),
    schedule,
    arm: meta.arm,
    index: meta.index,
    taskVariant: meta.taskVariant,
    exitCode: meta.exitCode,
    fixtureValid: validity?.valid ?? null,
    recovery,
    lookup,
  };
  writeFileSync(join(runDir, "score.json"), `${JSON.stringify(score, null, 2)}\n`, "utf8");
  return score;
}

function main() {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "..", "..");
  const runsRoot = arg("runs") ?? join(repoRoot, ".trial", "runs");
  const stage = arg("stage");
  const stageRoot = stage ? join(runsRoot, stage) : runsRoot;
  if (!existsSync(stageRoot)) throw new Error(`no runs at ${stageRoot}`);

  const runDirs: string[] = [];
  for (const entry of readdirSync(stageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(stageRoot, entry.name);
    if (existsSync(join(dir, "run.json"))) {
      runDirs.push(dir);
      continue;
    }
    for (const inner of readdirSync(dir, { withFileTypes: true })) {
      if (inner.isDirectory()) runDirs.push(join(dir, inner.name));
    }
  }
  const scores = runDirs.filter((d) => existsSync(join(d, "run.json"))).map(scoreRun);
  const cells = new Map<string, { recovery: number; lookup: number; n: number; invalid: number }>();
  for (const s of scores) {
    const key = `${s.schedule} · ${String(s.arm)}`;
    const cell = cells.get(key) ?? { recovery: 0, lookup: 0, n: 0, invalid: 0 };
    cell.n += 1;
    if (s.recovery.pass) cell.recovery += 1;
    if (s.lookup.pass) cell.lookup += 1;
    if (s.fixtureValid !== true) cell.invalid += 1;
    cells.set(key, cell);
  }
  const summary = { stage: stage ?? "(all)", generatedAt: new Date().toISOString(), cells: Object.fromEntries([...cells.entries()].map(([k, v]) => [k, { ...v, recoveryRate: v.n ? v.recovery / v.n : null, lookupRate: v.n ? v.lookup / v.n : null }])), scores };
  writeFileSync(join(stageRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`stage=${stage ?? "(all)"} trials=${scores.length}`);
  console.log("cell".padEnd(34) + "recovery".padEnd(12) + "lookup".padEnd(12) + "invalid");
  for (const [key, v] of cells) {
    console.log(key.padEnd(34) + `${v.recovery}/${v.n}`.padEnd(12) + `${v.lookup}/${v.n}`.padEnd(12) + String(v.invalid));
  }
  for (const s of scores.filter((x) => !x.recovery.pass)) {
    console.log(`  ✗ ${s.run} recovery: ${s.recovery.reasons.join("；")}`);
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/score-trial.js");
if (isMain) main();
