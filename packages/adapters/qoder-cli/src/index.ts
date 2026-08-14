import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THREAD_VERSION } from "@thread/core";

export { defaultPaths, threadRoot, ThreadPaths } from "@thread/core";

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

export function defaultDbPath(fromUrl: string): string {
  return process.env.THREAD_DB ?? join(resolveRepoRoot(fromUrl), ".thread", "sms.db");
}

export * from "./ingest.js";
