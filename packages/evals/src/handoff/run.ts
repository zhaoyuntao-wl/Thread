import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { hashProjectKey } from "@thread-memory/core";
import { type RunSample, type arm, renderReport, scoreAnswer, summarize } from "./score.js";
import { HANDOFF_TASK, TASK_ID, seedArm } from "./seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");

function argValue(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : Number(hit.split("=")[1]);
}

const K = argValue("k", 5);
const outRoot = process.env.HANDOFF_OUT_ROOT ?? join(repo, ".evals", "runs");
const home = process.env.HANDOFF_DSH_HOME ?? join(outRoot, "home");
const realHome = process.env.REAL_DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".dsh");
const profile = process.env.HANDOFF_PROFILE ?? "headless";
const runRoot = join(outRoot, "current");

function prepareHome(): void {
  const target = join(home, "profiles", profile);
  cpSync(join(realHome, "profiles", profile), target, { recursive: true });
  for (const file of ["settings.yaml", ".credentials.yaml"]) {
    try {
      cpSync(join(realHome, file), join(home, file));
    } catch {
      // 可选文件
    }
  }
  const patchPath = join(target, "cordis.patch.yml");
  const patched = readFileSync(patchPath, "utf8").replace(/THREAD_ROOT:\s*'[^']*'/, `THREAD_ROOT: '${runRoot.replace(/\\/g, "/")}'`);
  writeFileSync(patchPath, patched, "utf8");
}

function inspect(projectKey: string): { queries: number; delivered: number } {
  const out = { queries: 0, delivered: 0 };
  try {
    const db = new Database(join(runRoot, "structured.db"), { readonly: true });
    out.delivered = (db.prepare("SELECT COUNT(*) AS c FROM handoffs WHERE status IN ('delivered','ack')").get() as { c: number }).c;
    db.close();
  } catch (err) {
    console.error("inspect structured failed:", (err as Error).message);
  }
  const eventsPath = join(runRoot, "projects", hashProjectKey(projectKey), "events.db");
  try {
    const db = new Database(eventsPath, { readonly: true });
    out.queries = (
      db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind='tool_call' AND body LIKE '%query_session_memory%'").get() as { c: number }
    ).c;
    db.close();
  } catch (err) {
    console.error("inspect events failed:", eventsPath, (err as Error).message);
  }
  return out;
}

function runOnce(a: arm, index: number): RunSample {
  const { projectKey, workspace } = seedArm(runRoot, a);
  const started = Date.now();
  const res = spawnSync("dsh", ["--profile", profile, `"${HANDOFF_TASK}"`], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 240000,
    shell: true,
    env: {
      ...process.env,
      DSH_HOME: home,
      THREAD_ROOT: runRoot,
      // 显式钉住会话工作区：插件与种子必须落在同一个项目桶，否则交接寻址失败
      THREAD_CWD: workspace,
      THREAD_TASK_ID: TASK_ID,
      THREAD_ROLE: "dev",
      DSH_PERMISSION_MODE: "danger-full-access",
    },
  });
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const { queries, delivered } = inspect(projectKey);
  const sample: RunSample = { arm: a, ...scoreAnswer(text), queries, delivered, seconds: Math.round((Date.now() - started) / 1000) };
  console.log(
    `${a}#${index} 召回=${sample.recall} 策展=${sample.curated} 查询=${queries} 交付=${delivered} ${sample.seconds}s (exit=${String(res.status)})`,
  );
  return sample;
}

function main(): void {
  mkdirSync(runRoot, { recursive: true });
  prepareHome();
  const samples: RunSample[] = [];
  const arms: arm[] = ["push", "memory", "none"];
  for (let i = 1; i <= K; i++) {
    for (const a of arms) samples.push(runOnce(a, i));
  }
  // 隔离自检（2026-11-13 实测教训）：空记忆臂不可能知道种子里的字串。
  // 命中即说明运行没有落在预期根上（工作区在仓库内 → 项目键可能塌到仓库桶），此时不得出报表。
  const leaked = samples.filter((s) => s.arm === "none" && (s.curated || s.stale));
  if (leaked.length > 0) {
    console.error(
      `[handoff-ab] 隔离自检失败：none 臂 ${leaked.length} 次命中了种子字串，说明运行未落在隔离根（检查 THREAD_ROOT / THREAD_CWD / DSH_HOME，以及工作区不要放在 git 仓库内）。`,
    );
    writeFileSync(join(outRoot, "handoff-ab.invalid.json"), JSON.stringify({ k: K, samples }, null, 2));
    process.exit(2);
  }
  const summary = summarize(samples);
  const report = renderReport(summary, K);
  writeFileSync(join(outRoot, "handoff-ab.json"), JSON.stringify({ k: K, summary, samples }, null, 2));
  writeFileSync(join(outRoot, "handoff-ab.md"), `${report}\n`);
  console.log(`\n${report}`);
}

main();
