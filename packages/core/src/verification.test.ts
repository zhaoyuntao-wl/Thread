import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Criterion,
  checkCompletionGate,
  evidenceProgress,
  listEvidenceRows,
  renderEvidenceLine,
  verifyCriteria,
  verifyRegistered,
  criteriaFor,
  registerCriteria,
} from "./verification.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-verify-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "ev-proj" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const ok: Criterion = { key: "unit-tests", command: "exit 0" };
const bad: Criterion = { key: "lint", command: "exit 1" };

describe("verifyCriteria", () => {
  it("通过的命令落 passing 证据，含退出码与环境指纹", () => {
    const report = verifyCriteria(store, { projectKey: "ev-proj", sessionId: "s1", criteria: [ok] });
    expect(report.passed).toBe(1);
    const rows = listEvidenceRows(store, { projectKey: "ev-proj" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ criterion: "unit-tests", passed: 1, exit: 0 });
    expect(rows[0].env_fingerprint.length).toBeGreaterThan(0);
    expect(rows[0].command).toBe("exit 0");
  });

  it("失败的命令落 failed 证据（passed=0）", () => {
    const report = verifyCriteria(store, { projectKey: "ev-proj", sessionId: "s1", criteria: [bad] });
    expect(report.results[0].status).toBe("failed");
    expect(listEvidenceRows(store, { criterion: "lint" })[0].passed).toBe(0);
  });

  it("缺命令记为 missing-env 且不落证据", () => {
    const report = verifyCriteria(store, { projectKey: "ev-proj", sessionId: "s1", criteria: [{ key: "manual" }] });
    expect(report.results[0].status).toBe("missing-env");
    expect(listEvidenceRows(store, { criterion: "manual" })).toHaveLength(0);
  });
});

describe("门禁与进度", () => {
  it("无证据时拒绝完成并列出缺口", () => {
    const gate = checkCompletionGate(store, { projectKey: "ev-proj", criteria: [ok, bad] });
    expect(gate.allowed).toBe(false);
    expect(gate.missing).toEqual(["unit-tests", "lint"]);
  });

  it("全部条目有 passing 证据才允许完成", () => {
    verifyCriteria(store, { projectKey: "ev-proj", sessionId: "s1", criteria: [ok] });
    expect(checkCompletionGate(store, { projectKey: "ev-proj", criteria: [ok] }).allowed).toBe(true);
    expect(checkCompletionGate(store, { projectKey: "ev-proj", criteria: [ok, bad] }).allowed).toBe(false);
  });

  it("失败证据不能让条目变已证", () => {
    verifyCriteria(store, { projectKey: "ev-proj", sessionId: "s1", criteria: [bad] });
    expect(evidenceProgress(store, { projectKey: "ev-proj", criteria: [bad] }).proven).toBe(0);
  });

  it("未登记条目时门禁放行", () => {
    expect(checkCompletionGate(store, { projectKey: "ev-proj", criteria: [] }).allowed).toBe(true);
  });
});

describe("自动重跑已登记条目", () => {
  it("登记时保留命令，verifyRegistered 可自动重跑", () => {
    registerCriteria(store, "ev-proj", [{ key: "unit-tests", command: "exit 0" }]);
    const registered = criteriaFor(store, "ev-proj");
    expect(registered[0].command).toBe("exit 0");
    const report = verifyRegistered(store, { projectKey: "ev-proj", sessionId: "s1" });
    expect(report?.passed).toBe(1);
    expect(listEvidenceRows(store, { criterion: "unit-tests" })).toHaveLength(1);
  });

  it("没有登记命令时返回 undefined（不误报已证）", () => {
    registerCriteria(store, "ev-proj", [{ key: "manual" }]);
    expect(verifyRegistered(store, { projectKey: "ev-proj", sessionId: "s1" })).toBeUndefined();
  });

  it("重复登记同一键时命令被更新而非叠加", () => {
    registerCriteria(store, "ev-proj", [{ key: "lint", command: "exit 1" }]);
    registerCriteria(store, "ev-proj", [{ key: "lint", command: "exit 0" }]);
    const registered = criteriaFor(store, "ev-proj");
    expect(registered).toHaveLength(1);
    expect(registered[0].command).toBe("exit 0");
  });
});

describe("renderEvidenceLine", () => {
  it("输出进度与缺口", () => {
    expect(renderEvidenceLine({ proven: 3, total: 5, missing: ["a", "b"] })).toBe("验收 3/5 已证（缺：a、b）");
    expect(renderEvidenceLine({ proven: 5, total: 5, missing: [] })).toBe("验收 5/5 已证");
    expect(renderEvidenceLine({ proven: 0, total: 0, missing: [] })).toContain("未登记");
  });
});
