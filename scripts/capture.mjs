import { ThreadStore, applyAnalysis, classifyReportEvent, classifyWriteEvent, deriveProjectKey, extractTitleFromContent, sedimentClosingTodos } from "@thread-memory/core";
import { defaultPaths, extractLastAssistantTurn, parseHookEvent } from "@thread/adapter-qoder-cli";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// 会话临时隔离指令识别：整条消息精确匹配白名单（开放项⑦定案，防讨论性语句误触发）
const ISOLATE_RE = /^(?:\/isolate|[/／]isolate|隔离|开始隔离|进入隔离|临时隔离|静默|免打扰|别打扰)$/;
const UNISOLATE_RE = /^(?:\/unisolate|[/／]unisolate|解除隔离|退出隔离|恢复共享)$/;
const PUBLISH_CMD_RE = /^\/thread-publish\s+(goal|decision|feedback)\s+(\d+)$/;
const PUBLISH_NL_RE = /^把(?:刚才|刚才的)?(?:这个)?(?:决策|决定|目标|偏好)(?:共享|公开|同步)(?:出去|给项目)?$/;
const FEEDBACK_DEL_RE = /^\/feedback-del\s+(\d+)$/;
const ASSET_CMD_RE = /^\/thread-asset\s+(\S+)(?:\s+--topic\s+(\S+))?$/;
// 收尾词白名单（1.2 收尾自动沉淀，Qoder 无 turn/end 事件，收尾词消息即触发；幂等靠 basis 去重）
const CLOSING_WORD_RE = /^(?:先收了|先收|收工了|收工|今天到这|明天继续|歇了|歇|先记|暂时这样)$/;

function parseAssetCommand(body) {
  const m = body.trim().match(ASSET_CMD_RE);
  if (!m) {
    return undefined;
  }
  return m[2] ? { path: m[1], topic: m[2] } : { path: m[1] };
}

function readAssetTitle(path, cwd) {
  const resolved = isAbsolute(path) ? path : join(cwd, path);
  try {
    return extractTitleFromContent(readFileSync(resolved, "utf8").slice(0, 800), path);
  } catch {
    return extractTitleFromContent(undefined, path);
  }
}

function tableForKind(kind) {
  return kind === "goal" ? "goals" : kind === "decision" ? "decisions" : "feedback";
}

function parseIsolationCommand(body) {
  const delMatch = body.trim().match(FEEDBACK_DEL_RE);
  if (delMatch) {
    return { action: "feedback-del", id: Number(delMatch[1]) };
  }
  const m = body.trim().match(PUBLISH_CMD_RE);
  if (m) {
    return { action: "publish", kind: m[1], id: Number(m[2]) };
  }
  if (PUBLISH_NL_RE.test(body)) {
    return { action: "publish" };
  }
  if (ISOLATE_RE.test(body)) {
    return { action: "isolate" };
  }
  if (UNISOLATE_RE.test(body)) {
    return { action: "unisolate" };
  }
  return undefined;
}

function publishLatestIsolated(store, sessionId) {
  for (const table of ["decisions", "feedback", "goals"]) {
    const row = store.structuredDb
      .prepare(`SELECT id FROM ${table} WHERE session_id = ? AND isolation = 1 ORDER BY id DESC LIMIT 1`)
      .get(sessionId);
    if (row) {
      store.unisolateRow(sessionId, table, row.id);
      return;
    }
  }
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
  // 会话临时隔离：指令识别（显式命令 + 自然语言）→ 状态切换/沉淀；写路径带隔离标记（tool 类 core 强制共享）
  if (event.kind === "user_message") {
    const cmd = parseIsolationCommand(event.body);
    if (cmd?.action === "isolate") {
      store.setSessionIsolation(event.session_id, true);
    } else if (cmd?.action === "unisolate") {
      store.setSessionIsolation(event.session_id, false);
    } else if (cmd?.action === "publish") {
      if (cmd.kind && cmd.id) {
        store.unisolateRow(event.session_id, tableForKind(cmd.kind), cmd.id);
      } else {
        publishLatestIsolated(store, event.session_id);
      }
    } else if (cmd?.action === "feedback-del" && cmd.id) {
      // 反馈治理恢复通道：删除教训行（教训可删即恢复，B⑥-②）
      store.deleteFeedback(cmd.id);
    }
  }
  const isolated = store.getSessionIsolation(event.session_id);
  // 多写者重试（spike ⑤ 实证）：SQLITE_BUSY 立即重试，100ms 间隔、上限 20 次
  const appended = appendWithRetry(store, event, { projectKey, origin, isolation: isolated });
  try {
    if (event.kind === "user_message") {
      applyAnalysis(store, event.session_id, { user_msg: event.body }, { sourceEvent: appended.id, ts: event.ts, projectKey, origin, isolation: isolated });
      // /thread-asset <path> [--topic <t>] 显式登记（0.2 显式登记入口）：source_event = 命令消息
      const assetCmd = parseAssetCommand(event.body);
      if (assetCmd) {
        withBusyRetry(() => store.registerAsset({
          sessionId: event.session_id,
          path: assetCmd.path,
          title: readAssetTitle(assetCmd.path, hookCwd),
          topic: assetCmd.topic,
          sourceEvent: appended.id,
          projectKey,
          isolation: isolated,
        }));
      }
      // 收尾自动沉淀（1.2）：收尾词消息即触发（Qoder 无 turn 事件）；basis 去重幂等
      if (CLOSING_WORD_RE.test(event.body.trim())) {
        sedimentClosingTodos(store, event.session_id, { projectKey, isolation: isolated });
      }
    } else if (event.kind === "assistant_message") {
      applyAnalysis(store, event.session_id, { assistant_msg: event.body }, { sourceEvent: appended.id, ts: event.ts, projectKey, origin, isolation: isolated });
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
