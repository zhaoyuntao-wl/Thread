import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { THREAD_VERSION } from "./index.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

describe("core", () => {
  it("exposes the real package version（2026-09-02 修复 0.0.0 硬编码）", () => {
    expect(THREAD_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(THREAD_VERSION).toBe(pkg.version);
  });
});
