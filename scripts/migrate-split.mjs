#!/usr/bin/env node
// B④ 迁移 CLI 包装：核心逻辑在 @thread/core migrate.ts，本脚本只做参数解析 + 报告输出。
// 用法：node scripts/migrate-split.mjs [--old <sms.db 路径>] [--root <THREAD_ROOT>] [--project-key <键>] [--dry-run] [--replay]
import { migrateSplit, snapshotTableMaxIds, replayIncrement } from "@thread/core";
import { deriveProjectKey, hashProjectKey } from "@thread/core";
import { existsSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const oldPath = flag("old") ?? ".thread/sms.db";
const root = flag("root") ?? process.env.THREAD_ROOT ?? join(homedir(), ".thread");
const projectKey = flag("project-key") ?? deriveProjectKey(process.cwd());
const dryRun = args.includes("--dry-run");
const replay = args.includes("--replay");
const force = args.includes("--force");

if (!existsSync(oldPath)) {
  console.error(`旧库不存在: ${oldPath}`);
  process.exit(1);
}

if (replay) {
  const snapshot = snapshotTableMaxIds(oldPath);
  const result = replayIncrement(oldPath, root, projectKey, snapshot);
  console.log(
    JSON.stringify(
      { action: "replay", projectKey, snapshot, result },
      null,
      2,
    ),
  );
  process.exit(0);
}

// --force：hooks 可能已预热目标库（id 空间冲突无法合并），备份删除后迁移。
// 删除与迁移连续执行缩小竞态窗口；若仍冲突可重跑（重复删除+迁移）。
if (force && !dryRun) {
  const bak = join(root, "..", ".thread.bak-b4-temp");
  const structuredDb = join(root, "structured.db");
  const eventsDir = join(root, "projects", hashProjectKey(projectKey));
  mkdirSync(bak, { recursive: true });
  if (existsSync(structuredDb)) {
    copyFileSync(structuredDb, join(bak, `structured-${Date.now()}.db`));
    rmSync(structuredDb, { force: true });
  }
  if (existsSync(eventsDir)) {
    rmSync(eventsDir, { recursive: true, force: true });
  }
  console.log(`已备份并删除目标库（备份目录: ${bak}）`);
}

const result = migrateSplit({ oldPath, root, projectKey, dryRun });
console.log(JSON.stringify({ action: dryRun ? "dry-run" : "migrate", oldPath, root, ...result }, null, 2));
if (!dryRun) {
  console.log(`旧库已备份: ${oldPath}.bak-b4`);
  console.log(`新库: ${root}/structured.db + ${root}/projects/<hash>/events.db`);
  console.log("提示: 切换 capture/status-card 到新库后，如旧库有迁移窗口新增事件，可再次运行 --replay 补拉。");
}
