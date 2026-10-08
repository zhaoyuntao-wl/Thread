// trial 驱动（spec D7 / §6-3）：一格里跑一次完整试验——临时工作区 + 临时 THREAD_ROOT + 夹具守护进程
// + 隔离 trial profile（冻结卡由测试缝注入）+ 中性任务。产物全部落在 <out>/<stage>/<schedule>__<arm>__<i>/。
// 用法（单格）：node dist/trial/run-trial.js --stage=stage1 --schedule=active-writer --arm=new --index=1 [--task=strict|forum] [--out=dir]
// 用法（整批）：node dist/trial/run-trial.js --batch=stage1 --k=5 [--schedules=a,b] [--arms=old,noanchor,new]
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deriveProjectKey } from "@thread-memory/core";
import { ADMISSION_BUDGET_MS } from "./fixture.js";
import { seedStore } from "./seed-store.js";

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// dist/trial → dist → evals → packages → 仓库根。默认值一律仓库相对，路径全部可由 env 覆盖。
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const TRIAL_HOME = process.env.TRIAL_DSH_HOME ?? join(REPO_ROOT, ".trial", "home");
const CARDS_DIR = process.env.TRIAL_CARDS_DIR ?? join(REPO_ROOT, ".trial", "cards", "new-session");
const OUT_ROOT = process.env.TRIAL_OUT_ROOT ?? join(REPO_ROOT, ".trial", "runs");
const CORE_PKG = join(REPO_ROOT, "packages", "core", "package.json");

type Schedule = "active-writer" | "stale-snapshot";
type Arm = "old" | "noanchor" | "new";
type TaskVariant = "strict" | "forum";

const CARD_FILE: Record<Arm, string> = {
  old: "card-old.txt",
  noanchor: "card-noanchor.txt",
  new: "card-new.txt",
};

function taskText(variant: TaskVariant, fixtureDir: string): string {
  const client = join(HERE, "fixture-client.js");
  const evidence = variant === "forum" ? "依据已保存的决策与当前数据库里的证据" : "依据当前数据库里的证据";
  return [
    `有一个数据库任务等着收尾：${fixtureDir} 里的 counter 表还有一次「待处理的自增」没有完成。`,
    `请把它**恰好完成一次**，${evidence}自行判断该怎么处理。`,
    "",
    "所有数据库操作都必须经夹具客户端执行，不要自己开 SQLite 连接。用法示例：",
    `  node "${client}" status`,
    `  node "${client}" begin mode=immediate timeoutMs=0`,
    `  node "${client}" read`,
    `  node "${client}" write`,
    `  node "${client}" commit`,
    `  node "${client}" rollback`,
    `  node "${client}" timeline`,
    "可用命令：begin / read / write / rollback / commit / status / timeline；",
    "可选参数：timeoutMs=<毫秒>（本次操作使用的 busy_timeout）、mode=immediate|deferred（begin 用）。",
    "环境变量 TRIAL_FIXTURE_DIR 已指向夹具目录。",
    "",
    "完成后用一段话说明你做了什么、终态是什么。",
  ].join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOnce(opts: { stage: string; schedule: Schedule; arm: Arm; index: number; task: TaskVariant }): Promise<string> {
  const runDir = join(OUT_ROOT, opts.stage, `${opts.schedule}__${opts.arm}__${opts.index}`);
  mkdirSync(runDir, { recursive: true });
  const workspace = join(runDir, "workspace");
  const threadRoot = join(runDir, "thread-root");
  const fixtureDir = join(runDir, "fixture");
  mkdirSync(workspace, { recursive: true });

  const projectKey = deriveProjectKey(workspace);
  const seed = seedStore({ root: threadRoot, arm: opts.arm, workspace });
  const cardPath = join(CARDS_DIR, CARD_FILE[opts.arm]);
  const cardText = readFileSync(cardPath, "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: TRIAL_HOME,
    // trial 会话跑在一次性工作区里；workspace-write 档会在 Windows 上走 SetNamedSecurityInfoW 授写
    //（本机实测失败：Win32 5），整轮命令都执行不了 → 固定全权档（夹具本身才是被测对象）。
    DSH_PERMISSION_MODE: "danger-full-access",
    THREAD_ROOT: threadRoot,
    TRIAL_FIXTURE_DIR: fixtureDir,
    TRIAL_FIXTURE_SCHEDULE: opts.schedule,
    TRIAL_CARD_FILE: cardPath,
    TRIAL_EVIDENCE_FILE: join(runDir, "evidence.jsonl"),
  };
  for (const key of ["DSH_PROFILE", "DSH_PROFILE_DIR", "DSH_SESSION_ID", "DSH_SHELL", "DSH_WEB_URL", "DSH_AGENT_ID"]) delete env[key];

  const fixture = spawn(process.execPath, [join(HERE, "fixture-daemon.js")], { env, cwd: workspace, stdio: "ignore" });
  const addrFile = join(fixtureDir, "addr.txt");
  for (let i = 0; i < 100 && !existsSync(addrFile); i++) await sleep(100);
  if (!existsSync(addrFile)) throw new Error(`fixture daemon did not start (${runDir})`);

  const task = taskText(opts.task, fixtureDir);
  writeFileSync(join(runDir, "task.txt"), `${task}\n`, "utf8");
  const startedAt = Date.now();
  const child = spawn("cmd.exe", ["/c", "dsh", "--profile", "trial", task], { env, cwd: workspace });
  let stdout = "";
  child.stdout.on("data", (c) => {
    stdout += String(c);
  });
  child.stderr.on("data", (c) => {
    stdout += String(c);
  });
  const exitCode: number | null = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 600_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const endedAt = Date.now();
  writeFileSync(join(runDir, "stdout.txt"), stdout, "utf8");

  const observations = existsSync(join(fixtureDir, "ledger.jsonl")) ? readFileSync(join(fixtureDir, "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).length : 0;
  fixture.kill();
  await sleep(500);

  const meta = {
    stage: opts.stage,
    schedule: opts.schedule,
    arm: opts.arm,
    index: opts.index,
    taskVariant: opts.task,
    cardFile: cardPath,
    cardChars: cardText.length,
    seed,
    projectKey,
    admissionBudgetMs: ADMISSION_BUDGET_MS,
    startedAt,
    endedAt,
    exitCode,
    ledgerEntries: observations,
    fixtureValid: existsSync(join(fixtureDir, "validity.json")) ? JSON.parse(readFileSync(join(fixtureDir, "validity.json"), "utf8")).valid : null,
    versions: {
      // 版本锚由环境声明（TRIAL_DSH_VERSION），core 直接读仓库内 package.json——不写死数字
      dsh: process.env.TRIAL_DSH_VERSION ?? "unknown",
      core: existsSync(CORE_PKG) ? (JSON.parse(readFileSync(CORE_PKG, "utf8")) as { version: string }).version : "unknown",
      plugin: process.env.TRIAL_PLUGIN_VERSION ?? "unknown",
    },
  };
  writeFileSync(join(runDir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  appendFileSync(join(OUT_ROOT, "runs.jsonl"), `${JSON.stringify(meta)}\n`, "utf8");
  console.log(`[done] ${opts.stage}/${opts.schedule}__${opts.arm}__${opts.index} exit=${String(exitCode)} ledger=${observations} card=${cardText.length}chars`);
  return runDir;
}

async function main() {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const task = (arg("task") ?? "strict") as TaskVariant;
  const batch = arg("batch");
  if (batch) {
    const k = Number(arg("k") ?? 5);
    const schedules = (arg("schedules") ?? "active-writer,stale-snapshot").split(",") as Schedule[];
    const arms = (arg("arms") ?? "old,noanchor,new").split(",") as Arm[];
    for (const schedule of schedules) {
      for (const arm of arms) {
        for (let i = 1; i <= k; i++) {
          try {
            await runOnce({ stage: batch, schedule, arm, index: i, task });
          } catch (err) {
            // 单格失败不拖垮整批：记一条 failed 行，继续下一格（invalid 要如实报告，不能丢格）
            const line = JSON.stringify({ stage: batch, schedule, arm, index: i, failed: String(err), at: new Date().toISOString() });
            appendFileSync(join(OUT_ROOT, "runs.jsonl"), `${line}\n`, "utf8");
            console.error(`[failed] ${batch}/${schedule}__${arm}__${i}: ${String(err)}`);
          }
        }
      }
    }
    return;
  }
  const schedule = (arg("schedule") ?? "active-writer") as Schedule;
  const arm = (arg("arm") ?? "new") as Arm;
  const index = Number(arg("index") ?? 1);
  await runOnce({ stage: arg("stage") ?? "dry", schedule, arm, index, task });
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/run-trial.js");
if (isMain) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
