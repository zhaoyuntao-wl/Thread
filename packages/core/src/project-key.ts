import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { platform } from "node:os";

// 项目身份键 = 规范化 git 根（realpath + 分隔符/大小写归一；非 git 退化为规范化 cwd）。
// 避免同一项目因路径写法不同（D:\x vs d:/x vs /d/x）分裂命名空间。

export function deriveProjectKey(cwd: string): string {
  const normalized = normalizePath(resolveGitRoot(cwd) ?? cwd);
  return normalized;
}

export function hashProjectKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function deriveProjectKeyHash(cwd: string): string {
  return hashProjectKey(deriveProjectKey(cwd));
}

function resolveGitRoot(cwd: string): string | undefined {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

function normalizePath(p: string): string {
  let out = p;
  try {
    out = realpathSync(p);
  } catch {
    out = p;
  }
  if (platform() === "win32") {
    out = out.replace(/\\/g, "/");
    out = out.replace(/^([a-zA-Z]):/, (_, drive: string) => drive.toLowerCase() + ":");
  }
  return out.replace(/\/+$/, "");
}
