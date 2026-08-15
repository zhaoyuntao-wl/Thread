import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "@thread/core";
import { runAll } from "./harness.js";
import { SCENARIOS } from "./scenarios.js";
import { runScopeFilterScenario } from "./scope-scenario.js";
import { runMigrationLosslessScenario } from "./migration-scenario.js";
import { runRebuildRecoveryScenario } from "./rebuild-scenario.js";

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "thread-eval-cli-"));
  let store: ThreadStore | undefined;
  try {
    store = new ThreadStore({
      eventsPath: join(dir, "events.db"),
      structuredPath: join(dir, "structured.db"),
      projectKey: "eval-proj",
    });
    const { reports } = runAll(store, SCENARIOS);
    const specials = [runScopeFilterScenario(), runMigrationLosslessScenario(), runRebuildRecoveryScenario()];
    const all = [...reports, ...specials];
    let passed = 0;
    for (const r of all) {
      const failed = r.checks.filter((c) => !c.passed);
      if (failed.length === 0) {
        passed++;
      }
      console.log(`${failed.length === 0 ? "PASS" : "FAIL"} ${r.scenarioId} — ${r.title}`);
      for (const c of failed) {
        console.log(`    ✗ ${c.expectation}: ${c.detail}`);
      }
    }
    console.log(`\n${passed}/${all.length} scenarios passed`);
    if (passed !== all.length) {
      process.exit(1);
    }
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
