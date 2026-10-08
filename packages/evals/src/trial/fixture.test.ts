// 夹具状态机的确定性自测：两条 schedule 的错误码、交接态与释放时序必须可复现（spec §6-1）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrialFixture, RELEASE_DELAY_MS, type Schedule } from "./fixture.js";

const dirs: string[] = [];
const make = (schedule: Schedule) => {
  const dir = mkdtempSync(join(tmpdir(), `trial-${schedule}-`));
  dirs.push(dir);
  const fixture = new TrialFixture({ schedule, dir });
  fixture.setup();
  return fixture;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("schedule 1 · active writer", () => {
  it("交接态 = W 持写锁、R 无事务；首次 0 超时准入返回 SQLITE_BUSY(5)", () => {
    const f = make("active-writer");
    const v = f.validity();
    expect(v.valid).toBe(true);
    expect(f.finalState().wHoldsLock).toBe(true);
    expect(f.finalState().rInTransaction).toBe(false);

    const res = f.handle({ cmd: "begin", mode: "immediate", timeoutMs: 0 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("SQLITE_BUSY");
    expect(res.extendedCode).toBe(5);
    expect(res.ms).toBeLessThan(100);
    f.close();
  });

  it("W 只在观测到准入尝试之后释放；释放后重试可提交一次，终态 n=1", async () => {
    const f = make("active-writer");
    const fail = f.handle({ cmd: "begin", mode: "immediate", timeoutMs: 0 });
    expect(fail.ok).toBe(false);
    expect(f.finalState().released).toBe(false);
    const observed = f.finalState().observedAdmissionAt;
    expect(observed).not.toBeNull();

    await sleep(RELEASE_DELAY_MS * 3);
    const state = f.finalState();
    expect(state.released).toBe(true);
    expect(state.wHoldsLock).toBe(false);

    expect(f.handle({ cmd: "begin", mode: "immediate", timeoutMs: 1000 }).ok).toBe(true);
    expect(f.handle({ cmd: "write" }).ok).toBe(true);
    expect(f.handle({ cmd: "commit" }).ok).toBe(true);

    const final = f.finalState();
    expect(final.n).toBe(1);
    expect(final.agentCommits).toBe(1);
    expect(final.agentWrites).toBe(1);
    expect(final.rInTransaction).toBe(false);

    const release = f.ledger.find((e) => e.cmd === "release:W.COMMIT");
    expect(release).toBeDefined();
    expect(release!.t).toBeGreaterThanOrEqual(observed! + RELEASE_DELAY_MS);
    f.close();
  });

  it("释放由观测触发，不是盲等：没有尝试就不会释放", async () => {
    const f = make("active-writer");
    await sleep(RELEASE_DELAY_MS * 3);
    expect(f.finalState().released).toBe(false);
    expect(f.finalState().wHoldsLock).toBe(true);
    expect(f.validity().valid).toBe(true);
    f.close();
  });
});

describe("schedule 2 · stale snapshot", () => {
  it("交接态 = R 停在陈旧快照（含一次 517）、W 已提交、可见 n 分歧", () => {
    const f = make("stale-snapshot");
    const v = f.validity();
    expect(v.valid).toBe(true);

    const stale = f.ledger.find((e) => e.cmd.includes("stale snapshot"));
    expect(stale).toBeDefined();
    expect(stale!.ok).toBe(false);
    expect(stale!.code).toBe("SQLITE_BUSY_SNAPSHOT");
    expect(stale!.extendedCode).toBe(517);

    expect(f.finalState().rInTransaction).toBe(true);
    const staleRead = f.handle({ cmd: "read" });
    expect(staleRead.n).toBe(0);
    expect(f.finalState().n).toBe(1);
    f.close();
  });

  it("旧快照里重试写仍是 517；回滚→新事务→重读→重算→提交一次后终态 n=2", () => {
    const f = make("stale-snapshot");
    const retry = f.handle({ cmd: "write" });
    expect(retry.ok).toBe(false);
    expect(retry.extendedCode).toBe(517);

    expect(f.handle({ cmd: "rollback" }).ok).toBe(true);
    expect(f.handle({ cmd: "begin", mode: "immediate", timeoutMs: 1000 }).ok).toBe(true);
    expect(f.handle({ cmd: "read" }).n).toBe(1);
    expect(f.handle({ cmd: "write" }).ok).toBe(true);
    expect(f.handle({ cmd: "commit" }).ok).toBe(true);

    const final = f.finalState();
    expect(final.n).toBe(2);
    expect(final.agentCommits).toBe(1);
    expect(final.agentWrites).toBe(1);
    expect(final.rInTransaction).toBe(false);
    f.close();
  });

  it("夹具有效性可检出破损交接（陈旧事务丢失即 invalid）", () => {
    const f = make("stale-snapshot");
    f.handle({ cmd: "rollback" });
    const v = f.validity();
    expect(v.valid).toBe(false);
    expect(v.reasons.join(" ")).toContain("陈旧事务未保留");
    f.close();
  });
});
