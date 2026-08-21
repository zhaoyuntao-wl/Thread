import { ThreadStore, applyAnalysis, classifyReportEvent, classifyWriteEvent, deriveProjectKey, extractTitleFromContent, sedimentClosingTodos } from "@thread-memory/core";
import { defaultPaths, extractLastAssistantTurn, parseHookEvent } from "@thread/adapter-qoder-cli";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// ─── 命令语法（2026-08-21 全量重构，与 dsh 插件同语法）───
// 资源四类：ast 产出 / dec 决策 / fdb 偏好·教训 / gol 目标。
// thread-reg 注册 / thread-rev 解除（决策·偏好·产出删除、目标废弃）/ thread-pub 隔离行转共享 /
// thread-cfm 待处理收件箱（t#待办 / c#候选）/ thread-iso / thread-uniso。自然语言白名单保留为副通道。
// Qoder 无命令 UI：命令走消息回退路径（列表动作无显示通道，注册/解除/沉淀/收件箱动作全执行）。
const RESOURCE = "(ast|dec|fdb|gol)";
const REG_LIST_RE = new RegExp(`^\\/thread-reg\\s+${RESOURCE}$`);
const REG_TEXT_RE = new RegExp(`^\\/thread-reg\\s+${RESOURCE}\\s+(.+)$`, "s");
const DEC_SUPERSEDES_RE = /^(.*?)\s+--supersedes\s+(\d+)$/s;
const REV_LIST_RE = new RegExp(`^\\/thread-rev\\s+${RESOURCE}$`);
const REV_IDS_RE = new RegExp(`^\\/thread-rev\\s+${RESOURCE}\\s+(all|\\d+(?:\\s*,\\s*\\d+)*)$`);
const PUB_BARE_LIST_RE = /^\/thread-pub$/;
const PUB_LIST_RE = new RegExp(`^\\/thread-pub\\s+${RESOURCE}$`);
const PUB_IDS_RE = new RegExp(`^\\/thread-pub\\s+${RESOURCE}\\s+(all|\\d+(?:\\s*,\\s*\\d+)*)$`);
const PUBLISH_NL_RE = /^把(?:刚才|刚才的)?(?:这个)?(?:决策|决定|目标|偏好)(?:共享|公开|同步)(?:出去|给项目)?$/;
const ISOLATE_RE = /^(?:\/thread-iso|隔离|开始隔离|进入隔离|临时隔离|静默|免打扰|别打扰)$/;
const UNISOLATE_RE = /^(?:\/thread-uniso|解除隔离|退出隔离|恢复共享)$/;
const CFM_LIST_RE = /^\/thread-cfm$/;
const CFM_DO_RE = /^\/thread-cfm\s+do\s+([tc]#\d+)(?:\s+(.+))?$/s;
const CFM_CNL_RE = /^\/thread-cfm\s+cnl\s+([tc]#\d+)$/;
const CFM_CNL_ALL_RE = /^\/thread-cfm\s+cnl\s+all$/;
// 收尾词白名单（1.2 收尾自动沉淀，Qoder 无 turn/end 事件，收尾词消息即触发；幂等靠 basis 去重）
const CLOSING_WORD_RE = /^(?:先收了|先收|收工了|收工|今天到这|明天继续|歇了|歇|先记|暂时这样)$/;

function parseIds(raw) {
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function parseRegCommand(body) {
  const text = body.trim();
  const list = text.match(REG_LIST_RE);
  if (list) {
    return { action: "list", resource: list[1] };
  }
  const m = text.match(REG_TEXT_RE);
  if (!m) {
    return undefined;
  }
  const resource = m[1];
  const rest = m[2].trim();
  if (resource === "dec") {
    const sm = rest.match(DEC_SUPERSEDES_RE);
    if (sm && sm[1].trim() && sm[2]) {
      return { action: "register", resource, text: sm[1].trim(), supersedesId: Number(sm[2]) };
    }
  }
  if (!rest || rest.startsWith("--")) {
    return undefined;
  }
  return { action: "register", resource, text: rest };
}

function parseRevCommand(body) {
  const text = body.trim();
  const list = text.match(REV_LIST_RE);
  if (list) {
    return { action: "list", resource: list[1] };
  }
  const m = text.match(REV_IDS_RE);
  if (!m) {
    return undefined;
  }
  return { action: "revoke", resource: m[1], ids: m[2] === "all" ? undefined : parseIds(m[2]) };
}

function parsePubCommand(body) {
  const text = body.trim();
  if (PUB_BARE_LIST_RE.test(text)) {
    return { action: "list" };
  }
  const list = text.match(PUB_LIST_RE);
  if (list) {
    return { action: "list", resource: list[1] };
  }
  const m = text.match(PUB_IDS_RE);
  if (!m) {
    return undefined;
  }
  return { action: "publish", resource: m[1], ids: m[2] === "all" ? undefined : parseIds(m[2]) };
}

function parseCfmCommand(body) {
  const text = body.trim();
  if (CFM_LIST_RE.test(text)) {
    return { action: "list" };
  }
  if (CFM_CNL_ALL_RE.test(text)) {
    return { action: "cnl-all" };
  }
  const d = text.match(CFM_DO_RE);
  if (d) {
    return { action: "do", target: d[1][0], id: Number(d[1].slice(2)), text: d[2]?.trim() || undefined };
  }
  const c = text.match(CFM_CNL_RE);
  if (c) {
    return { action: "cnl", target: c[1][0], id: Number(c[1].slice(2)) };
  }
  return undefined;
}

function parseIsoCommand(body) {
  const text = body.trim();
  if (ISOLATE_RE.test(text)) {
    return { action: "isolate" };
  }
  if (UNISOLATE_RE.test(text)) {
    return { action: "unisolate" };
  }
  return undefined;
}

function isThreadCommandLine(body) {
  return parseIsoCommand(body) !== undefined
    || parseRegCommand(body) !== undefined
    || parseRevCommand(body) !== undefined
    || parsePubCommand(body) !== undefined
    || parseCfmCommand(body) !== undefined;
}

function readAssetTitle(path, cwd) {
  const resolved = isAbsolute(path) ? path : join(cwd, path);
  try {
    return extractTitleFromContent(readFileSync(resolved, "utf8").slice(0, 800), path);
  } catch {
    return extractTitleFromContent(undefined, path);
  }
}

// thread-asset 路径展开（2026-08-21）：文件 → [文件]；目录 → 递归登记目录内常规文件（跳过隐藏目录，上限 50）
const MAX_ASSET_DIR_FILES = 50;
const ASSET_SKIP_DIRS = new Set(["node_modules", ".git", ".dsh", "dist", "coverage"]);

function expandAssetPaths(path, cwd) {
  const resolved = isAbsolute(path) ? path : join(cwd, path);
  let st;
  try {
    st = statSync(resolved);
  } catch {
    return [path];
  }
  if (st.isFile() || !st.isDirectory()) {
    return [path];
  }
  const files = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (files.length >= MAX_ASSET_DIR_FILES) {
        return false;
      }
      if (e.isDirectory()) {
        if (ASSET_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) {
          continue;
        }
        if (!walk(join(dir, e.name), `${rel}/${e.name}`)) {
          return false;
        }
      } else if (e.isFile()) {
        files.push(`${rel}/${e.name}`.replace(/^\//, ""));
      }
    }
    return true;
  };
  walk(resolved, path.replace(/[\\/]+$/, "").replace(/\\/g, "/"));
  return files;
}

function tableForResource(kind) {
  return kind === "ast" ? "knowledge_assets" : kind === "dec" ? "decisions" : kind === "fdb" ? "feedback" : "goals";
}

function publishLatestIsolated(store, sessionId) {
  for (const table of ["knowledge_assets", "decisions", "feedback", "goals"]) {
    const row = store.structuredDb
      .prepare(`SELECT id FROM ${table} WHERE session_id = ? AND isolation = 1 ORDER BY id DESC LIMIT 1`)
      .get(sessionId);
    if (row) {
      store.unisolateRow(sessionId, table, row.id);
      return;
    }
  }
}

// 显式通道命令执行（2026-08-21 命令重构；Qoder 无显示通道，list 动作 no-op，写动作全执行）
function handleRegCommand(store, sessionId, cmd, opts) {
  if (cmd.action === "list") {
    return;
  }
  const { resource, text } = cmd;
  if (resource === "ast") {
    for (const p of expandAssetPaths(text, opts.cwd)) {
      withBusyRetry(() => store.registerAsset({
        sessionId,
        path: p,
        title: readAssetTitle(p, opts.cwd),
        projectKey: opts.projectKey,
        isolation: opts.isolation,
      }));
    }
    return;
  }
  if (resource === "dec") {
    if (cmd.supersedesId !== undefined) {
      store.supersedeDecisionById(sessionId, cmd.supersedesId, text);
      return;
    }
    store.addDecision(sessionId, text, { projectKey: opts.projectKey, isolation: opts.isolation });
    return;
  }
  if (resource === "fdb") {
    const kind = /不要|别|别再|不要再/.test(text) ? "correction" : "preference";
    store.addFeedback(sessionId, text, kind, { projectKey: opts.projectKey, isolation: opts.isolation });
    return;
  }
  store.addGoal(sessionId, text, { projectKey: opts.projectKey, isolation: opts.isolation });
}

function handleRevCommand(store, sessionId, cmd) {
  if (cmd.action === "list") {
    return;
  }
  const { resource, ids } = cmd;
  if (resource === "ast") {
    for (const id of ids ?? store.listAssets({ sessionId }).map((a) => a.id)) {
      store.deleteAsset(id);
    }
    return;
  }
  if (resource === "dec") {
    for (const id of ids ?? store.getDecisions(sessionId).map((d) => d.id)) {
      store.deleteDecision(id);
    }
    return;
  }
  if (resource === "fdb") {
    for (const id of ids ?? store.getFeedback(sessionId, 1000).map((f) => f.id)) {
      store.deleteFeedback(id);
    }
    return;
  }
  const active = store.getActiveGoals(sessionId).map((g) => g.id);
  for (const id of ids ?? active) {
    if (active.includes(id)) {
      store.updateGoalStatus(sessionId, id, "abandoned");
    }
  }
}

function handlePubCommand(store, sessionId, cmd) {
  if (cmd.action === "list") {
    return;
  }
  const table = tableForResource(cmd.resource);
  const kindMap = { ast: "ast", dec: "decision", fdb: "feedback", gol: "goal" };
  const rows = store.listIsolatedRows(sessionId).filter((r) => r.kind === kindMap[cmd.resource]);
  for (const id of cmd.ids ?? rows.map((r) => r.id)) {
    store.unisolateRow(sessionId, table, id);
  }
}

function handleCfmCommand(store, sessionId, cmd, projectKey) {
  if (cmd.action === "list") {
    return;
  }
  if (cmd.action === "do") {
    if (cmd.target === "t") {
      store.updateTodoStatus(cmd.id, "done");
    } else {
      store.promoteCandidate(cmd.id, cmd.text);
    }
    return;
  }
  if (cmd.action === "cnl") {
    if (cmd.target === "t") {
      store.updateTodoStatus(cmd.id, "dropped");
    } else {
      store.ignoreCandidate(cmd.id);
    }
    return;
  }
  for (const t of store.listTodos({ sessionId, status: "pending", limit: 1000 })) {
    store.updateTodoStatus(t.id, "dropped");
  }
  store.ignoreAllPendingCandidates(projectKey ? { sessionId, projectKey } : { sessionId });
}

let raw;
try {
  raw = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}
let hookEvent;
try {
  hookEvent = JSON.parse(raw);
} catch {
  process.exit(0);
}

const event = parseHookEvent(hookEvent);
if (!event) {
  process.exit(0);
}

if (event.kind === "assistant_message" && event.meta?.assistant_text_pending) {
  const transcriptPath =
    typeof event.meta.transcript_path === "string" ? event.meta.transcript_path : undefined;
  const turn = extractLastAssistantTurn(transcriptPath);
  if (!turn) {
    process.exit(0);
  }
  event.body = turn.text;
  event.meta = { ...event.meta, assistant_uuid: turn.uuid, assistant_text_pending: false };
}

// 幂等键 origin：底座前缀 + 事件 uuid（assistant 用 transcript uuid，工具用 tool_use_id，
// 用户消息/压缩摘要用 body+ts 哈希兜底——compact_checkpoint 无 uuid，必须兜底否则重放会重复落库）。
// tool_call 必须用独立前缀（qoder://toolcall#）而不是 transcript#：append 按 origin 全局去重，
// 若与 tool_result 共用 tool_use_id 前缀，两次写入会互相去重覆盖，tool_result 会丢。
let origin;
const uuid = event.meta?.assistant_uuid;
const toolUseId = event.meta?.tool_use_id;
if (typeof uuid === "string" && uuid.length > 0) {
  origin = `qoder://transcript#${uuid}`;
} else if (event.kind === "tool_call") {
  if (typeof toolUseId === "string" && toolUseId.length > 0) {
    origin = `qoder://toolcall#${toolUseId}`;
  } else {
    const h = createHash("sha256").update(`${event.body}\n${event.ts}`).digest("hex").slice(0, 16);
    origin = `qoder://toolcall#sha256-${h}`;
  }
} else if (typeof toolUseId === "string" && toolUseId.length > 0) {
  origin = `qoder://transcript#${toolUseId}`;
} else if (event.kind === "user_message" || event.kind === "compact_checkpoint") {
  const h = createHash("sha256").update(`${event.body}\n${event.ts}`).digest("hex").slice(0, 16);
  origin = `qoder://transcript#sha256-${h}`;
}

const hookCwd = typeof hookEvent?.cwd === "string" ? hookEvent.cwd : process.cwd();
const projectKey = deriveProjectKey(hookCwd);
const paths = defaultPaths(hookCwd);

mkdirSync(dirname(paths.eventsDbPath), { recursive: true });
mkdirSync(dirname(paths.structuredDbPath), { recursive: true });
const store = new ThreadStore({ eventsPath: paths.eventsDbPath, structuredPath: paths.structuredDbPath, projectKey });
try {
  const existingUuid = event.meta?.assistant_uuid;
  if (event.kind === "assistant_message" && typeof existingUuid === "string" && store.hasAssistantTurn(event.session_id, existingUuid)) {
    process.exit(0);
  }
  // 会话临时隔离：指令识别（显式命令 + 自然语言）→ 状态切换；写路径带隔离标记（tool 类 core 强制共享）
  if (event.kind === "user_message") {
    const isoCmd = parseIsoCommand(event.body);
    if (isoCmd?.action === "isolate") {
      store.setSessionIsolation(event.session_id, true);
    } else if (isoCmd?.action === "unisolate") {
      store.setSessionIsolation(event.session_id, false);
    }
  }
  const isolated = store.getSessionIsolation(event.session_id);
  // 多写者重试（spike ⑤ 实证）：SQLITE_BUSY 立即重试，100ms 间隔、上限 20 次
  const appended = appendWithRetry(store, event, { projectKey, origin, isolation: isolated });
  try {
    if (event.kind === "user_message") {
      // 命令消息跳过 applyAnalysis（2026-08-21）：命令只走命令处理，防双创建/副作用
      if (!isThreadCommandLine(event.body)) {
        applyAnalysis(store, event.session_id, { user_msg: event.body }, { sourceEvent: appended.id, ts: event.ts, projectKey, origin, isolation: isolated });
      }
      // 命令执行（2026-08-21 命令重构；Qoder 无显示通道，list no-op、写动作全执行）
      const regCmd = parseRegCommand(event.body);
      if (regCmd) {
        handleRegCommand(store, event.session_id, regCmd, { sourceEvent: appended.id, projectKey, isolation: isolated, cwd: hookCwd });
      }
      const revCmd = parseRevCommand(event.body);
      if (revCmd) {
        handleRevCommand(store, event.session_id, revCmd);
      }
      const pubCmd = parsePubCommand(event.body);
      if (pubCmd) {
        handlePubCommand(store, event.session_id, pubCmd);
      } else if (PUBLISH_NL_RE.test(event.body.trim())) {
        publishLatestIsolated(store, event.session_id);
      }
      const cfmCmd = parseCfmCommand(event.body);
      if (cfmCmd) {
        handleCfmCommand(store, event.session_id, cfmCmd, projectKey);
      }
      // 收尾自动沉淀（1.2）：收尾词消息即触发（Qoder 无 turn 事件）；basis 去重幂等
      if (CLOSING_WORD_RE.test(event.body.trim())) {
        sedimentClosingTodos(store, event.session_id, { projectKey, isolation: isolated });
      }
    } else if (event.kind === "assistant_message") {
      // 结构通道化（2026-08-21）：assistant 文本不再做 NL 判定（模型通道 = record_decision 工具）
      // 关闭即沉淀（2026-08-20）：Qoder 的 Stop hook = 每轮结束信号，无条件沉淀（幂等 +
      // 目标完成时 todo 自愈）——直接关闭代理不丢进行中目标
      sedimentClosingTodos(store, event.session_id, { projectKey, isolation: isolated });
    } else if (event.kind === "tool_call") {
      // 产出识别（0.2）：文档/报告产出 → knowledge_assets + produces/references 写时建边
      const toolName = typeof event.meta?.tool_name === "string" ? event.meta.tool_name : "";
      const classification = classifyWriteEvent(toolName, event.meta?.tool_input) ?? classifyReportEvent(toolName, event.meta?.tool_input);
      if (classification) {
        withBusyRetry(() => store.registerAsset({
          sessionId: event.session_id,
          path: classification.path,
          title: classification.title,
          sourceEvent: appended.id,
          projectKey,
          isolation: isolated,
        }));
      }
    }
  } catch (err) {
    console.error(`thread capture: analysis failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} finally {
  store.close();
}

function appendWithRetry(store, ev, opts, tries = 0) {
  try {
    return store.append(ev, opts);
  } catch (err) {
    if ((err?.code === "SQLITE_BUSY" || String(err).includes("database is locked")) && tries < 20) {
      sleepSync(100);
      return appendWithRetry(store, ev, opts, tries + 1);
    }
    throw err;
  }
}

function withBusyRetry(fn, tries = 0) {
  try {
    return fn();
  } catch (err) {
    if ((err?.code === "SQLITE_BUSY" || String(err).includes("database is locked")) && tries < 20) {
      sleepSync(100);
      return withBusyRetry(fn, tries + 1);
    }
    throw err;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
