import { describe, expect, it } from "vitest";
import { runIsolationScenario } from "./isolation-scenario.js";
import { runMigrationLosslessScenario } from "./migration-scenario.js";
import { runRebuildRecoveryScenario } from "./rebuild-scenario.js";
import { runScopeFilterScenario } from "./scope-scenario.js";

describe("B⑦ 专项场景（eval-cli 同源断言）", () => {
  it("scope-filter：跨项目零泄漏 + 全局反馈共享", () => {
    const report = runScopeFilterScenario();
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("migration-lossless：单库 → 双库复制+回填+完整性", () => {
    const report = runMigrationLosslessScenario();
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("rebuild-recovery：删结构化库后事件流水重放恢复（幂等）", () => {
    const report = runRebuildRecoveryScenario();
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("isolation：对话上下文仅自己可见、项目事实共享、解除/沉淀可恢复", () => {
    const report = runIsolationScenario();
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
