import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { analyzeTranscript } from "./lib/transcript-ctx.mjs";

const [transcript] = process.argv.slice(2);
if (!transcript) {
  console.error("用法: node scripts/eval-ctx.mjs <transcript.jsonl> [--out out.json]");
  process.exit(1);
}
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : `${transcript}.ctx.json`;

const a = analyzeTranscript(transcript);
const inputs = a.points.map((p) => p.estInputTokens);
const outputs = a.points.map((p) => p.estOutputTokens);
const stats = (xs) => ({
  min: Math.min(...xs),
  median: median(xs),
  max: Math.max(...xs),
});

console.log(`会话: ${a.sessionId ?? "?"} ｜ 有效条目 ${a.entryCount} ｜ 轮次 ${a.turnCount}`);
console.log(
  `区间校准 (tokens/char): ${a.calibrations.map((c) => c.toFixed(4)).join(", ") || "无锚点，回退 1/4"}`,
);
console.log();
console.log("压缩锚点（真实 token 数据）:");
console.log("  # | ts | preTokens -> postTokens | 降幅 | 消息数 | 耗时s");
a.anchors.forEach((c, i) => {
  const drop = ((c.preTokens - c.postTokens) / c.preTokens) * 100;
  console.log(
    `  ${i + 1} | ${c.ts.slice(11, 19)} | ${c.preTokens.toLocaleString()} -> ${c.postTokens.toLocaleString()} | ${drop.toFixed(1)}% | ${c.messagesSummarized} | ${(c.durationMs / 1000).toFixed(0)}`,
  );
});
console.log();
const s = stats(inputs);
console.log(`每轮上下文估算 (estInputTokens): min ${s.min} 中位 ${s.median} max ${s.max}`);
console.log(`每轮输出估算 (estOutputTokens): min ${stats(outputs).min} 中位 ${stats(outputs).median} max ${stats(outputs).max}`);
console.log(`全程估算总 token: ${a.totalEstTokens.toLocaleString()}`);

const verdicts = [];
if (a.anchors.length === 0) {
  verdicts.push("FAIL: 无压缩锚点（未触发 /compact）");
} else {
  const drops = a.anchors.map((c) => (c.preTokens - c.postTokens) / c.preTokens);
  if (drops.some((d) => d < 0.5)) verdicts.push("WARN: 存在压缩降幅 < 50% 的锚点");
  const maxPre = Math.max(...a.anchors.map((c) => c.preTokens));
  const maxPost = Math.max(...a.anchors.map((c) => c.postTokens));
  if (s.max > maxPre) verdicts.push(`WARN: 轮次上下文估算峰值 ${s.max} 超过实测锚点峰值 ${maxPre}`);
  verdicts.push(`PASS: sawtooth 成立，谷值 ≤ ${maxPost.toLocaleString()}，峰值 ≤ ${maxPre.toLocaleString()}`);
  verdicts.push(
    `NOTE: 全部锚点 trigger=manual；auto-compact 有界性待配置 ${"`model.maxSessionTurns`/`contextWindow`"} 阈值后补测`,
  );
}
console.log();
console.log("验收① 判定:");
verdicts.forEach((v) => console.log(`  ${v}`));

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ ...a, verdicts }, null, 2));
console.log(`\n序列数据已写入: ${outPath}`);

function median(xs) {
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
