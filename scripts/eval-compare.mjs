import { analyzeTranscript } from "./lib/transcript-ctx.mjs";

const args = process.argv.slice(2);
const preIdx = args.indexOf("--pre");
const postIdx = args.indexOf("--post");
if (preIdx < 0 || postIdx < 0 || postIdx < preIdx) {
  console.error("用法: node scripts/eval-compare.mjs --pre <接入前*.jsonl...> --post <接入后*.jsonl...>");
  console.error("每组为同一固定任务各跑 N 次的 transcript；输出各组总 token 中位数与比值（趋势性佐证）。");
  process.exit(1);
}
const preFiles = args.slice(preIdx + 1, postIdx);
const postFiles = args.slice(postIdx + 1);

const totals = (files) => files.map((f) => analyzeTranscript(f).totalEstTokens);
const pre = totals(preFiles);
const post = totals(postFiles);
if (pre.length === 0 || post.length === 0) {
  console.error("两组都至少需要一份 transcript");
  process.exit(1);
}

console.log("同任务 token 消耗对比（确定性估算，模型输出非确定 → 趋势性佐证）");
console.log();
console.log("接入前（无裁剪接线）:");
pre.forEach((t, i) => console.log(`  run ${i + 1}: ${t.toLocaleString()}  (${preFiles[i]})`));
console.log(`  中位数: ${median(pre).toLocaleString()}`);
console.log("接入后（裁剪接线）:");
post.forEach((t, i) => console.log(`  run ${i + 1}: ${t.toLocaleString()}  (${postFiles[i]})`));
console.log(`  中位数: ${median(post).toLocaleString()}`);
const ratio = median(post) / median(pre);
console.log();
console.log(`中位数比值 (接入后/接入前): ${ratio.toFixed(2)}x${ratio < 1 ? " — 消耗下降" : " — 消耗上升或持平"}`);

function median(xs) {
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
