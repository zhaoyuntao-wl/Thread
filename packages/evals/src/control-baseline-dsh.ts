// 0-f 对照实验：dsh 原生（无 Thread）失忆基线
// 行为型：两次 headless 调用模拟"跨会话"，第二次让模型继续干活，
// 判据 = 第二次输出中的客观事实保留（是否按前序决策/是否重复提问/是否记得早期目标）。
// 关键：--patch 禁用 dsh-thread + mcp-thread → 干净的无 Thread 基线（状态卡注入会污染对照）。
// 用法：node dist/control-baseline-dsh.js [--scenario decision-chain|repeat-question|goal-retention]
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_SCENARIOS, pickScenarios, type ControlScenario } from "./control-scenarios.js";

function runDsh(task: string): string {
  // Windows：dsh 是 .ps1 shim，直接 spawn dsh.cmd 拿不到输出（npm shim shebang 问题）；
  // 经 cmd.exe /c 包装后 stdio pipe 捕获可用（实测 status 0 + stdout 正常）。
  // --patch 禁用 dsh-thread + mcp-thread：无状态卡注入的干净基线。
  // cmd /c 引号拼接易错：patch 路径放短无空格目录（系统 temp 无空格），task 用 JSON 转义。
  const dir = mkdtempSync(join(tmpdir(), "t0f-"));
  const patchFile = join(dir, "d.yml");
  writeFileSync(patchFile, "- id: dsh-thread\n  disabled: true\n- id: mcp-thread\n  disabled: true\n", "utf-8");
  const bin = process.platform === "win32" ? "cmd.exe" : "sh";
  const taskArg = JSON.stringify(task);
  const patchArg = `--patch ${patchFile}`;
  const args =
    process.platform === "win32"
      ? ["/c", `dsh.cmd --profile headless ${patchArg} ${taskArg}`]
      : ["-c", `dsh --profile headless ${patchArg} ${taskArg}`];
  const r = spawnSync(bin, args, {
    encoding: "utf-8",
    timeout: 600_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    shell: false,
  });
  rmSync(dir, { recursive: true, force: true });
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

console.log("=== 0-f 对照实验：dsh 原生（无 Thread，--patch 禁用 dsh-thread）失忆基线 ===");
console.log(`模型 = deepseek-v4-flash（settings.yaml reasoningEffort: high）\n`);
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
void CONTROL_SCENARIOS;
