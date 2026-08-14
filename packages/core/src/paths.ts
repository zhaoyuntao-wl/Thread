import { homedir } from "node:os";
import { join } from "node:path";
import { deriveProjectKeyHash } from "./project-key.js";

// B④ 双库路径：结构化表 = 用户级库；事件流水 = 项目库（目录名 = 项目键 hash）。
// THREAD_ROOT 覆盖根目录（演练/测试指向临时根，严禁写生产 ~/.thread）。
export interface ThreadPaths {
  structuredDbPath: string;
  eventsDbPath: string;
  root: string;
}

export function threadRoot(): string {
  return process.env.THREAD_ROOT ?? join(homedir(), ".thread");
}

export function defaultPaths(cwd?: string): ThreadPaths {
  const root = threadRoot();
  const projectKeyHash = deriveProjectKeyHash(cwd ?? process.cwd());
  return {
    structuredDbPath: join(root, "structured.db"),
    eventsDbPath: join(root, "projects", projectKeyHash, "events.db"),
    root,
  };
}
