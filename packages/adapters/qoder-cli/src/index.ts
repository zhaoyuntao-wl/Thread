import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveProjectKeyHash, THREAD_VERSION } from "@thread/core";

export const adapterName = "qoder-cli";

export function adapterInfo(): string {
  return `${adapterName} adapter, thread core v${THREAD_VERSION}`;
}

export function resolveRepoRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return process.cwd();
}

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

export function defaultPaths(fromUrl: string, cwd?: string): ThreadPaths {
  const root = threadRoot();
  const projectKeyHash = deriveProjectKeyHash(cwd ?? process.cwd());
  return {
    structuredDbPath: join(root, "structured.db"),
    eventsDbPath: join(root, "projects", projectKeyHash, "events.db"),
    root,
  };
}

export function defaultDbPath(fromUrl: string): string {
  return process.env.THREAD_DB ?? join(resolveRepoRoot(fromUrl), ".thread", "sms.db");
}

export * from "./ingest.js";
