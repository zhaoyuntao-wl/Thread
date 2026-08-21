// 0-f 对照实验：Claude Code 原生（无 Thread）失忆基线——同模型（DeepSeek V4 Flash）不同 Agent
// 控制变量：思考强度与 dsh 侧对齐（dsh settings.yaml: reasoningEffort: high → Claude 用 --effort high）
// 端点：DeepSeek Anthropic 兼容（--settings 覆盖本机智谱配置，不动用户的 .claude/settings.json）
// 判据与 dsh 基线同构（共享 control-scenarios.ts），直接对齐对比。
// 用法：DEEPSEEK_API_KEY=<key> node dist/control-baseline-claude.js [--scenario <id>]
import { spawnSync } from "node:child_process";
import { pickScenarios, type ControlScenario } from "./control-scenarios.js";

// 独立 settings：覆盖为 DeepSeek Anthropic 兼容端点（不动用户 .claude/settings.json 的智谱配置）
function deepseekSettings(): string {
  return JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: process.env.DEEPSEEK_API_KEY ?? "",
    },
  });
}

function runClaude(task: string): string {
  const r = spawnSync(
    "cmd.exe",
    [
      "/c",
      `claude.cmd -p ${JSON.stringify(task)} --output-format text --effort high --settings ${JSON.stringify(deepseekSettings())} --model deepseek-v4-flash`,
    ],
    {
      encoding: "utf-8",
      timeout: 600_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      shell: false,
    },
  );
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

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("需要 DEEPSEEK_API_KEY（可从 ~/.dsh/.credentials.yaml 读取）");
  process.exit(1);
}

console.log("=== 0-f 对照实验：Claude Code 原生（无 Thread）失忆基线 ===");
console.log("模型 = deepseek-v4-flash（与 dsh 同模型同 key），思考强度 = high（与 dsh reasoningEffort: high 对齐）\n");
for (const c of cases) {
  console.log(`--- 场景 ${c.id}: ${c.title} ---`);
  console.log(`[会话1] ${c.session1.slice(0, 80)}...`);
  const out1 = runClaude(c.session1);
  console.log(`[会话1 输出长度] ${out1.length} 字符`);
  console.log(`[会话2] ${c.session2.slice(0, 80)}...`);
  const out2 = runClaude(c.session2);
  console.log(`[会话2 输出] ${out2.slice(0, 1200)}...`);
  const results = judge(out2, c.checks);
  console.log(`[判据]`);
  for (const r of results) {
    console.log(`  ${r.passed ? "✅" : "❌"} ${r.label}`);
  }
  console.log("");
}
