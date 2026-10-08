// 冻结卡渲染（spec D2 / D8 / §4）：同一份存储输入 → 三臂卡文本 + sha256。
//   A 旧卡   = core 1.0.11 渲染器（纯头部截断），决策行带 source_event（有锚）
//   B 无锚臂 = core 1.0.11 渲染器，决策行不带 source_event（无锚）
//   C 新卡   = core 1.0.12 渲染器（头+尾保留），有锚
// 每臂渲染两次比对 hash（确定性），并断言判据：A/B 必须丢掉适用条件从句、B 必须没有锚、C 必须保住从句。
// 用法：node dist/trial/freeze-card.js [--out=<dir>] [--situation=new-session|normal]
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { ThreadStore, buildStatusCard, type StatusCardSituation } from "@thread-memory/core";
import { buildStatusCard as buildStatusCard11011 } from "./frozen/status-card-1-0-11.js";

// 决策原文：动作在前、**区分两条 schedule 的适用条件放句尾**（论坛反馈的原始形态）。
export const DECISION_TEXT =
  "SQLite 写失败时先用有界等待（busy_timeout ≤ 1000ms）重试一次，成功后只提交一次、绝不重复自增，" +
  "并把实际耗时与错误码写进记录，便于事后核对整条时间线；重试期间不要新建连接、不要关闭既有事务，" +
  "保持同一连接的操作顺序可追溯；但若失败是快照过期（SQLITE_BUSY_SNAPSHOT / 517），" +
  "必须回滚、在新事务里重读当前值、重算后再提交一次，不得在旧快照里重试。";

// 判据串：区分两条 schedule 的那条规则（B/A 丢它、C 保它）
export const CLAUSE_MARK = "必须回滚、在新事务里重读";
const ANCHOR_MARK = "源#e";
export const SESSION_ID = "session-trial-0001";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

function seed(withAnchor: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "trial-seed-"));
  const store = new ThreadStore({
    eventsPath: join(dir, "events.db"),
    structuredPath: join(dir, "structured.db"),
  });
  const event = store.append({
    session_id: SESSION_ID,
    kind: "user_message",
    ts: new Date().toISOString(),
    body: `请按这条规则处理数据库写入失败：${DECISION_TEXT}`,
  });
  const decision = store.addDecision(SESSION_ID, DECISION_TEXT, withAnchor ? { sourceEvent: event.id } : {});
  return { dir, store, event, decision };
}

function main() {
  const outArg = process.argv.find((a) => a.startsWith("--out="));
  const situationArg = process.argv.find((a) => a.startsWith("--situation="));
  const situation = (situationArg?.split("=")[1] ?? "new-session") as StatusCardSituation;
  const outDir = outArg?.split("=")[1] ?? join(resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "..", ".."), ".trial", "cards", situation);
  mkdirSync(outDir, { recursive: true });

  const render = (withAnchor: boolean, renderer: "old" | "new") => {
    const { dir, store, event, decision } = seed(withAnchor);
    const opts = { sessionId: SESSION_ID, situation };
    const build = renderer === "old" ? buildStatusCard11011 : buildStatusCard;
    const first = build(store, opts);
    const second = build(store, opts);
    store.close();
    rmSync(dir, { recursive: true, force: true });
    return { card: first, stable: first === second, eventId: event.id, decisionId: decision.id, sourceEvent: decision.source_event };
  };

  const arms = {
    old: render(true, "old"),
    noanchor: render(false, "old"),
    new: render(true, "new"),
  };

  const report = Object.entries(arms).map(([arm, r]) => {
    const file = join(outDir, `card-${arm}.txt`);
    writeFileSync(file, `${r.card}\n`, "utf8");
    return {
      arm,
      file,
      sha256_16: sha(r.card),
      deterministic: r.stable,
      decisionId: r.decisionId,
      sourceEvent: r.sourceEvent,
      eventId: r.eventId,
      cardChars: r.card.length,
      hasClause: r.card.includes(CLAUSE_MARK),
      hasAnchor: r.card.includes(ANCHOR_MARK),
    };
  });

  const decisionLine = (arm: keyof typeof arms) =>
    arms[arm].card.split("\n").find((l) => l.includes(`#${arms[arm].decisionId}`)) ?? "(决策行未出现在卡上)";

  const checks = [
    { name: "A 旧卡：丢从句、留锚", ok: !arms.old.card.includes(CLAUSE_MARK) && arms.old.card.includes(ANCHOR_MARK) },
    { name: "B 无锚臂：丢从句、无锚", ok: !arms.noanchor.card.includes(CLAUSE_MARK) && !arms.noanchor.card.includes(ANCHOR_MARK) },
    { name: "C 新卡：保住从句、留锚", ok: arms.new.card.includes(CLAUSE_MARK) && arms.new.card.includes(ANCHOR_MARK) },
    { name: "三臂均确定性（两次渲染同 hash）", ok: report.every((r) => r.deterministic) },
  ];

  writeFileSync(
    join(outDir, "cards.json"),
    `${JSON.stringify({ situation, decisionText: DECISION_TEXT, decisionChars: DECISION_TEXT.length, clauseMark: CLAUSE_MARK, arms: report, checks }, null, 2)}\n`,
    "utf8",
  );

  console.log(`situation=${situation} out=${outDir}`);
  console.log(`决策原文 ${DECISION_TEXT.length} 字；从句标记 "${CLAUSE_MARK}" 起始于第 ${DECISION_TEXT.indexOf(CLAUSE_MARK) + 1} 字`);
  for (const r of report) {
    console.log(`\n[${r.arm}] ${r.cardChars} chars sha=${r.sha256_16} clause=${r.hasClause} anchor=${r.hasAnchor}`);
    console.log(`  决策行: ${decisionLine(r.arm as keyof typeof arms)}`);
  }
  console.log("");
  for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.name}`);
  if (checks.some((c) => !c.ok)) {
    console.error("\n断言未通过：决策原文长度/措辞需要调整，或渲染器与预期不符——不要带着未验证的卡进入 trial。");
    process.exit(1);
  }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/freeze-card.js");
if (isMain) main();
