import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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

function findFiles(dir: string, suffix: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) findFiles(path, suffix, acc);
    else if (name.endsWith(suffix)) acc.push(path);
  }
  return acc;
}

// 不推断项目键：直接扫临时根里插件写下的库，避免「键算错 → 计数全 0」这类静默错误。
function inspect(): { queries: number; delivered: number } {
  const out = { queries: 0, delivered: 0 };
  for (const dbPath of findFiles(runRoot, "structured.db")) {
    try {
      const db = new Database(dbPath, { readonly: true });
      out.delivered += (
        db.prepare("SELECT COUNT(*) AS c FROM handoffs WHERE status IN ('delivered','ack')").get() as { c: number }
      ).c;
      db.close();
    } catch (err) {
      console.error("inspect structured failed:", dbPath, (err as Error).message);
    }
  }
  for (const dbPath of findFiles(runRoot, "events.db")) {
    try {
      const db = new Database(dbPath, { readonly: true });
      out.queries += (
        db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind='tool_call' AND body LIKE '%query_session_memory%'").get() as {
          c: number;
        }
      ).c;
      db.close();
    } catch (err) {
      console.error("inspect events failed:", dbPath, (err as Error).message);
    }
  }
  return out;
}

function runOnce(a: arm, index: number): RunSample {
  const { workspace } = seedArm(runRoot, a);
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
      THREAD_CWD: workspace,
      THREAD_TASK_ID: TASK_ID,
      THREAD_ROLE: "dev",
      DSH_PERMISSION_MODE: "danger-full-access",
    },
  });
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const { queries, delivered } = inspect();
  const sample: RunSample = { arm: a, ...scoreAnswer(text), queries, delivered, seconds: Math.round((Date.now() - started) / 1000) };
  console.log(
    `${a}#${index} recall=${sample.recall} curated=${sample.curated} queries=${queries} delivered=${delivered} ${sample.seconds}s exit=${String(res.status)}`,
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
  // 隔离自检：空记忆臂不可能知道种子里的字串；命中即说明运行没落在隔离根上，不出报表。
  const leaked = samples.filter((s) => s.arm === "none" && (s.curated || s.stale));
  if (leaked.length > 0) {
    console.error(`[handoff-ab] isolation self-check failed: none arm hit seed strings ${leaked.length}/${K}.`);
    writeFileSync(join(outRoot, "handoff-ab.invalid.json"), JSON.stringify({ k: K, samples }, null, 2));
    process.exit(2);
  }
  // 计数自检：push 臂必然产生「已投递」交接；为 0 说明库扫描没接上，此时出的表不可信。
  if (samples.filter((s) => s.arm === "push" && s.delivered > 0).length === 0) {
    console.error("[handoff-ab] counter self-check failed: push arm delivered=0 across all runs (DB scan not wired).");
    writeFileSync(join(outRoot, "handoff-ab.invalid.json"), JSON.stringify({ k: K, samples }, null, 2));
    process.exit(3);
  }
  const summary = summarize(samples);
  const report = renderReport(summary, K);
  writeFileSync(join(outRoot, "handoff-ab.json"), JSON.stringify({ k: K, summary, samples }, null, 2));
  writeFileSync(join(outRoot, "handoff-ab.md"), `${report}\n`);
  console.log(`\n${report}`);
}

main();
