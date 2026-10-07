import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// 会话 → 所属项目桶定位（2026-10-07 D2 修复）：查询通道要"按会话找到它所在的事件库"，
// 而桶目录命名（hash(projectKey)）与行上的 project_key 都属于 core 的存储布局，故定位逻辑放 core，
// 消费方（插件 / MCP server / 适配器）不重复实现布局知识。
export interface SessionLocation {
  /** 项目桶目录名 = hashProjectKey(projectKey) */
  bucket: string;
  /** 该桶的事件库绝对路径 */
  eventsPath: string;
  /** 桶内事件行的项目键（旧库可能没有，故可选） */
  projectKey?: string;
}

/**
 * 在 `<root>/projects/<bucket>/events.db` 中定位含该会话的事件库。
 * @param root - Thread 根目录（threadRoot()）
 * @param sessionId - 目标会话 id
 * @returns 命中的桶位置；任何桶都读不到时返回 undefined（调用方降级到默认桶）
 */
export function locateSession(root: string, sessionId: string): SessionLocation | undefined {
  const projectsDir = join(root, "projects");
  for (const bucket of existsSync(projectsDir) ? readdirSync(projectsDir) : []) {
    const eventsPath = join(projectsDir, bucket, "events.db");
    if (!existsSync(eventsPath)) {
      continue;
    }
    try {
      const db = new Database(eventsPath, { readonly: true });
      const hit = db
        .prepare("SELECT 1 AS ok FROM events WHERE session_id = ? LIMIT 1")
        .get(sessionId) as { ok?: number } | undefined;
      if (!hit) {
        db.close();
        continue;
      }
      const key = db
        .prepare("SELECT project_key FROM events WHERE project_key IS NOT NULL LIMIT 1")
        .get() as { project_key?: string } | undefined;
      db.close();
      return { bucket, eventsPath, projectKey: key?.project_key ?? undefined };
    } catch {
      // 读不了的桶跳过：定位失败降级，不阻塞查询通道
    }
  }
  return undefined;
}
