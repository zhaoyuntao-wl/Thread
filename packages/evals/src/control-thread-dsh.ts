// 0-f 对照实验：dsh + Thread（行为型）——同模型同任务，Thread 状态卡注入下继续干活
// 对照矩阵：无 Thread（control-baseline-dsh，--patch 禁用）vs 有 Thread（本脚本）——证 Thread 增量
// 判据与基线同构（共享 control-scenarios.ts）；差异 = 状态卡注入带来的决策/目标/答案保真。
// 注意：headless profile 已挂 dsh-thread（不 --patch 禁用），状态卡每轮注入 + 会话记忆在库。
// 用法：node dist/control-thread-dsh.js [--scenario decision-chain|repeat-question|goal-retention]
import { spawnSync } from "node:child_process";
import { pickScenarios, type ControlScenario } from "./control-scenarios.js";

function runDsh(task: string): string {
  const bin = process.platform === "win32" ? "cmd.exe" : "sh";
  const args =
    process.platform === "win32"
      ? ["/c", `dsh.cmd --profile headless ${JSON.stringify(task)}`]
      : ["-c", `dsh --profile headless ${JSON.stringify(task)}`];
  const r = spawnSync(bin, args, {
    encoding: "utf-8",
    timeout: 600_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    shell: false,
  });
  return (r.stdout ?? "") + "\n" + (r.stderr ?? "");
}

function judge(output: string, checks: ControlScenario["checks"]) {
  const text = output.toLowerCase();
  return checks.map((c) => {
    const hit = c.expect.some((e) => text.includes(e));
    const forbiddenHit = c.forbid?.some((f) => text.includes(f)) ?? false;
    return { label: c.label, passed: hit && !forbiddenHit };
  });
}

const arg = process.argv.find((a) => a.startsWith("--scenario="));
const cases = pickScenarios(arg?.split("=")[1]);

console.log("=== 0-f 对照实验：dsh + Thread（行为型）失忆对照 ===");
console.log("模型 = deepseek-v4-flash，思考强度 = high（与基线一致），仅差 = Thread 状态卡注入 + 会话记忆\n");
for (const c of cases) {
  console.log(`--- 场景 ${c.id}: ${c.title} ---`);
  console.log(`[会话1] ${c.session1.slice(0, 80)}...`);
  const out1 = runDsh(c.session1);
  console.log(`[会话1 输出长度] ${out1.length} 字符`);
  console.log(`[会话2] ${c.session2.slice(0, 80)}...`);
  const out2 = runDsh(c.session2);
  console.log(`[会话2 输出] ${out2.slice(0, 1200)}...`);
  const results = judge(out2, c.checks);
  console.log(`[判据]`);
  for (const r of results) {
    console.log(`  ${r.passed ? "✅" : "❌"} ${r.label}`);
  }
  console.log("");
}
