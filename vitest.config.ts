import { defineConfig } from "vitest/config";

// 根级测试入口：只收集 packages 下各包的 *.test.ts（各包源码旁测试）。
// docs/local/**（含 vendored 研究源码 cordis-src 的 .spec.ts）不参与验证链。
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "docs/local/**"],
  },
});
