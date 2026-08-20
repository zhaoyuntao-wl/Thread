// 44c3c7 回放验证（批 1 验收 0.3）：对历史会话的 tool_call 事件重放产出识别规则，
// 验证 v7 分类器能命中现网论文研究产出（NOTES.md 等 7 份）。
// 只读回放：不写任何库；写入型回填（正式回填工具）留待批 5。
import { classifyReportEvent, classifyWriteEvent, defaultPaths, parseToolArgs } from "@thread-memory/core";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const cwd = getArg("--cwd") ?? process.cwd();
const sessionArg = getArg("--session");
const likeArg = getArg("--like");

const paths = defaultPaths(cwd);
const db = new Database(paths.eventsDbPath, { readonly: true, fileMustExist: true });

const sessions = likeArg
  ? db
      .prepare(`SELECT session_id, COUNT(*) AS c, MIN(ts) AS first_ts FROM events WHERE kind = 'tool_call' AND session_id LIKE ? GROUP BY session_id ORDER BY first_ts DESC`)
      .all(`%${likeArg}%`)
  : db
      .prepare(`SELECT session_id, COUNT(*) AS c, MIN(ts) AS first_ts FROM events WHERE kind = 'tool_call' GROUP BY session_id ORDER BY first_ts DESC LIMIT 10`)
      .all();

if (!sessionArg) {
  console.log(`events db: ${paths.eventsDbPath}`);
  console.log("最近有 tool_call 的会话：");
  for (const s of sessions) {
    console.log(`  ${s.session_id}  tool_call×${s.c}  首次 ${s.first_ts}`);
  }
  console.log("\n用法: node scripts/replay-assets.mjs --session <session_id> [--paths]");
  db.close();
  process.exit(0);
}

if (args.includes("--paths")) {
  // 会话写文件全景：distinct file_path（写类工具），对照产出识别规则覆盖面
  const rows = db
    .prepare(`SELECT body FROM events WHERE session_id = ? AND kind = 'tool_call' ORDER BY seq`)
    .all(sessionArg);
  const seen = new Map();
  for (const row of rows) {
    const m = row.body.match(/^([^\s]+) 调用参数：(.*)$/s);
    if (!m) {
      continue;
    }
    const parsed = parseToolArgs(m[2]);
    const fp = typeof parsed?.file_path === "string" ? parsed.file_path : undefined;
    if (fp) {
      const entry = seen.get(fp) ?? { count: 0, tools: new Set() };
      entry.count += 1;
      entry.tools.add(m[1]);
      seen.set(fp, entry);
    }
  }
  console.log(`会话 ${sessionArg} 写类工具触及的 file_path（${seen.size} 个）：`);
  for (const [fp, e] of [...seen.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const md = /\.md$/i.test(fp.replace(/\\/g, "/")) ? "  ← .md 可识别" : "";
    console.log(`  ×${e.count}  [${[...e.tools].join(", ")}]  ${fp}${md}`);
  }
  db.close();
  process.exit(0);
}

const rows = db
  .prepare(`SELECT id, body, ts FROM events WHERE session_id = ? AND kind = 'tool_call' ORDER BY seq`)
  .all(sessionArg);

console.log(`\n回放会话 ${sessionArg}（tool_call ${rows.length} 条）：\n`);
let hit = 0;
for (const row of rows) {
  // body 形如 "<tool> 调用参数：<json>"——回放需从 body 反解参数（历史 meta 无 file_path，自检修正⑦ 的前置缺陷）
  const m = row.body.match(/^([^\s]+) 调用参数：(.*)$/s);
  if (!m) {
    continue;
  }
  const toolName = m[1];
  const argsRaw = m[2].startsWith("{") ? m[2] : m[2];
  const classification = classifyWriteEvent(toolName, argsRaw) ?? classifyReportEvent(toolName, argsRaw);
  if (classification) {
    hit += 1;
    console.log(`[命中 #${hit}] event ${row.id}  ${toolName}\n  路径: ${classification.path}\n  标题: ${classification.title}\n  ts: ${row.ts}`);
  }
}
console.log(`\n合计命中 ${hit} 条产出。`);
db.close();
