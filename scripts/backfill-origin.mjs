#!/usr/bin/env node
// A3 历史回填：为 origin IS NULL 的存量事件补幂等键（规则与 capture.mjs 一致）。
// 用法：node scripts/backfill-origin.mjs [--root <THREAD_ROOT>] [--apply]
// 默认 dry-run 只打印计划；--apply 才写库。严禁在未指定 --root 时对非生产库演练。
import { createHash } from "node:crypto";
import { ThreadStore, defaultPaths } from "@thread/core";

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root = rootFlag >= 0 ? args[rootFlag + 1] : undefined;
const apply = args.includes("--apply");
if (root) {
  process.env.THREAD_ROOT = root;
}

// 与 capture.mjs 兜底同款：sha256(body\n ts) 前 16 位
function hashOrigin(body, ts) {
  return createHash("sha256").update(`${body}\n${ts}`).digest("hex").slice(0, 16);
}

function originFor(row) {
  let meta = {};
  if (typeof row.meta === "string" && row.meta.length > 0) {
    try {
      meta = JSON.parse(row.meta);
    } catch {
      // meta 解析失败按无字段处理，哈希兜底
    }
  }
  const toolUseId = typeof meta.tool_use_id === "string" ? meta.tool_use_id : "";
  const assistantUuid = typeof meta.assistant_uuid === "string" ? meta.assistant_uuid : "";
  if (assistantUuid.length > 0) {
    return `qoder://transcript#${assistantUuid}`;
  }
  if (row.kind === "tool_call") {
    return toolUseId.length > 0
      ? `qoder://toolcall#${toolUseId}`
      : `qoder://toolcall#sha256-${hashOrigin(row.body, row.ts)}`;
  }
  if (toolUseId.length > 0) {
    return `qoder://transcript#${toolUseId}`;
  }
  if (row.kind === "user_message" || row.kind === "assistant_message" || row.kind === "compact_checkpoint") {
    return `qoder://transcript#sha256-${hashOrigin(row.body, row.ts)}`;
  }
  return undefined;
}

const paths = defaultPaths();
const store = new ThreadStore({ eventsPath: paths.eventsDbPath, structuredPath: paths.structuredDbPath });
try {
  const rows = store
    .eventsDb
    .prepare(`SELECT id, kind, ts, body, meta FROM events WHERE origin IS NULL ORDER BY id`)
    .all();
  if (rows.length === 0) {
    console.log("无需回填：origin IS NULL 事件为 0。");
    process.exit(0);
  }
  const plans = rows
    .map((row) => ({ row, origin: originFor(row) }))
    .filter((p) => p.origin !== undefined);
  const skipped = rows.length - plans.length;
  const byKind = {};
  for (const p of plans) {
    byKind[p.row.kind] = (byKind[p.row.kind] ?? 0) + 1;
  }
  console.log(`计划回填 ${plans.length} 条（跳过 ${skipped} 条无规则 kind）`);
  console.log("按 kind：", JSON.stringify(byKind));
  for (const p of plans.slice(0, 5)) {
    console.log(`  样本 id=${p.row.id} kind=${p.row.kind} -> ${p.origin}`);
  }
  if (!apply) {
    console.log("dry-run：加 --apply 执行写库。");
    process.exit(0);
  }
  const update = store
    .eventsDb
    .prepare(`UPDATE events SET origin = ? WHERE id = ?`);
  store
    .eventsDb
    .transaction((items) => {
      for (const p of items) update.run(p.origin, p.row.id);
    })(plans);
  const remaining = store
    .eventsDb
    .prepare(`SELECT count(*) c FROM events WHERE origin IS NULL`)
    .get().c;
  console.log(`已回填 ${plans.length} 条；剩余 NULL：${remaining}`);
} finally {
  store.close();
}
