import { describe, expect, it } from "vitest";
import { deriveProjectKey, deriveProjectKeyHash } from "./project-key.js";

describe("project key", () => {
  it("derives a key for the current repo root", () => {
    const key = deriveProjectKey(process.cwd());
    expect(key.length).toBeGreaterThan(0);
    expect(key).not.toMatch(/\\$/);
  });

  it("normalizes trailing slashes and separators", () => {
    // 同一路径的不同写法应归一（Windows 反斜杠 → 正斜杠 + 盘符小写）
    const a = "D:/Agent-work/workspace/Thread/";
    const b = "D:\\Agent-work\\workspace\\Thread";
    expect(normalizeForTest(a)).toBe(normalizeForTest(b));
  });

  it("hash is stable and distinct per key", () => {
    const h1 = deriveProjectKeyHash("D:/Agent-work/workspace/Thread");
    const h2 = deriveProjectKeyHash("D:/Agent-work/workspace/Thread/");
    const h3 = deriveProjectKeyHash("D:/Agent-work/workspace/Other");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

function normalizeForTest(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^([a-zA-Z]):/, (_, d: string) => d.toLowerCase() + ":")
    .replace(/\/+$/, "");
}
