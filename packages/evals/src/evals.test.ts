import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "@thread-memory/core";
import { runAll } from "./harness.js";
import { SCENARIOS } from "./scenarios.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-evals-"));
  store = new ThreadStore({ eventsPath: join(dir, "eval-events.db"), structuredPath: join(dir, "eval-structured.db"), projectKey: "eval-proj" });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("regression scenarios", () => {
  it(`runs all ${SCENARIOS.length} scenarios and passes fact-retention checks`, () => {
    const { reports, passed } = runAll(store, SCENARIOS);
    for (const report of reports) {
      const failed = report.checks.filter((c) => !c.passed);
      expect(failed, `${report.title} 失败项`).toEqual([]);
    }
    expect(passed).toBe(true);
  });
});
