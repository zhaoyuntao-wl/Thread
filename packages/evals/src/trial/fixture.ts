// 行为验收 rig · 夹具核心（spec D4 / §3）：夹具持有 W 与 R 两条连接与其事务状态，
// agent 只能经命令面驱动 R；ledger 就是计分要用的"有序 tool-event 证据"。
// 两条 schedule 的语义由 test 固定（含 SQLITE_BUSY=5 / SQLITE_BUSY_SNAPSHOT=517 实测）。
import Database from "better-sqlite3";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Schedule = "active-writer" | "stale-snapshot";

export const RELEASE_DELAY_MS = 150;
export const ADMISSION_BUDGET_MS = 1000;

// better-sqlite3 报的是扩展结果码的**名字**，不是数字；数字在这里显式映射，产物里两个都记。
const EXTENDED_CODES: Record<string, number> = {
  SQLITE_BUSY: 5,
  SQLITE_BUSY_RECOVERY: 261,
  SQLITE_BUSY_SNAPSHOT: 517,
  SQLITE_BUSY_TIMEOUT: 773,
  SQLITE_LOCKED: 6,
};

export interface LedgerEntry {
  t: number;
  wall: number;
  actor: "fixture" | "agent";
  cmd: string;
  ok: boolean;
  code?: string;
  extendedCode?: number;
  n?: number | null;
  timeoutMs?: number;
  ms?: number;
  detail?: string;
}

export interface CommandRequest {
  cmd: "begin" | "read" | "write" | "rollback" | "commit" | "status" | "timeline";
  mode?: "immediate" | "deferred";
  timeoutMs?: number;
}

export interface CommandResponse {
  ok: boolean;
  code?: string;
  extendedCode?: number;
  n?: number | null;
  inTransaction?: boolean;
  ms: number;
  t: number;
  error?: string;
}

const errInfo = (e: unknown) => {
  const err = e as { code?: string; message?: string };
  const code = typeof err.code === "string" ? err.code : undefined;
  return { code, extendedCode: code ? EXTENDED_CODES[code] : undefined, error: String(err.message ?? e).slice(0, 200) };
};

export class TrialFixture {
  readonly schedule: Schedule;
  readonly dir: string;
  readonly dbPath: string;
  readonly ledgerPath: string;
  ledger: LedgerEntry[] = [];

  private readonly w: Database.Database;
  private readonly r: Database.Database;
  private readonly t0 = Date.now();
  private rTimeoutMs = 0;
  private wHoldsLock = false;
  private released = false;
  private releaseScheduledFor: number | null = null;
  private observedAdmissionAt: number | null = null;
  private releaseTimer: NodeJS.Timeout | null = null;

  constructor(opts: { schedule: Schedule; dir: string }) {
    this.schedule = opts.schedule;
    this.dir = opts.dir;
    mkdirSync(opts.dir, { recursive: true });
    this.dbPath = join(opts.dir, "trial.db");
    this.ledgerPath = join(opts.dir, "ledger.jsonl");
    this.w = new Database(this.dbPath);
    this.w.pragma("journal_mode = WAL");
    this.r = new Database(this.dbPath);
    this.r.pragma("journal_mode = WAL");
    this.r.pragma("busy_timeout = 0");
    this.w.exec("CREATE TABLE counter(n INTEGER NOT NULL)");
    this.w.exec("INSERT INTO counter(n) VALUES (0)");
  }

  private now() {
    return Date.now() - this.t0;
  }

  private record(entry: Omit<LedgerEntry, "t" | "wall">) {
    const full: LedgerEntry = { t: this.now(), wall: Date.now(), ...entry };
    this.ledger.push(full);
    appendFileSync(this.ledgerPath, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  private n(): number | null {
    try {
      return (this.w.prepare("SELECT n FROM counter").get() as { n: number }).n;
    } catch {
      return null;
    }
  }

  /** 交接前的夹具摆放：schedule 1 = W 持写锁；schedule 2 = R 停在陈旧快照里（含一次 517）。 */
  setup(): void {
    if (this.schedule === "active-writer") {
      this.w.exec("BEGIN IMMEDIATE");
      this.wHoldsLock = true;
      this.record({ actor: "fixture", cmd: "setup:W.BEGIN IMMEDIATE", ok: true, n: this.n(), detail: "hold lock, n unchanged" });
      return;
    }
    this.r.exec("BEGIN");
    const seen = (this.r.prepare("SELECT n FROM counter").get() as { n: number }).n;
    this.record({ actor: "fixture", cmd: "setup:R.BEGIN+read", ok: true, n: seen });
    this.w.exec("BEGIN IMMEDIATE");
    this.w.prepare("UPDATE counter SET n = n + 1").run();
    this.w.exec("COMMIT");
    this.record({ actor: "fixture", cmd: "setup:W.increment+commit", ok: true, n: this.n() });
    try {
      this.r.prepare("UPDATE counter SET n = n + 1").run();
      this.record({ actor: "fixture", cmd: "setup:R.write(stale snapshot)", ok: true, n: this.n(), detail: "UNEXPECTED: no error" });
    } catch (e) {
      const info = errInfo(e);
      this.record({ actor: "fixture", cmd: "setup:R.write(stale snapshot)", ok: false, ...info, n: this.n() });
    }
  }

  /** schedule 1：观测到 R 首次受限准入尝试（primary BUSY）后 RELEASE_DELAY_MS 释放 W。 */
  private onAdmissionFailure(): void {
    if (this.schedule !== "active-writer" || this.released || this.releaseScheduledFor !== null) return;
    this.observedAdmissionAt = this.now();
    this.releaseScheduledFor = this.observedAdmissionAt + RELEASE_DELAY_MS;
    this.releaseTimer = setTimeout(() => {
      this.released = true;
      this.w.exec("COMMIT");
      this.wHoldsLock = false;
      this.record({ actor: "fixture", cmd: "release:W.COMMIT", ok: true, n: this.n(), detail: `observed admission at t=${this.observedAdmissionAt}` });
    }, RELEASE_DELAY_MS);
  }

  /** agent 侧命令；默认全部作用于 R。 */
  handle(req: CommandRequest): CommandResponse {
    const started = Date.now();
    const t = this.now();
    const fail = (info: { code?: string; extendedCode?: number; error?: string }, cmd: string): CommandResponse => {
      const ms = Date.now() - started;
      this.record({ actor: "agent", cmd, ok: false, code: info.code, extendedCode: info.extendedCode, n: this.n(), timeoutMs: this.rTimeoutMs, ms, detail: info.error });
      if (info.code === "SQLITE_BUSY") this.onAdmissionFailure();
      return { ok: false, code: info.code, extendedCode: info.extendedCode, error: info.error, n: this.n(), inTransaction: this.r.inTransaction, ms, t };
    };
    const ok = (cmd: string, extra: Partial<CommandResponse> = {}): CommandResponse => {
      const ms = Date.now() - started;
      const n = this.n();
      this.record({ actor: "agent", cmd, ok: true, n, timeoutMs: this.rTimeoutMs, ms, detail: extra.error });
      return { ok: true, n, inTransaction: this.r.inTransaction, ms, t, ...extra };
    };

    if (req.timeoutMs !== undefined) {
      this.rTimeoutMs = req.timeoutMs;
      this.r.pragma(`busy_timeout = ${req.timeoutMs}`);
    }

    try {
      switch (req.cmd) {
        case "begin":
          this.r.exec(req.mode === "deferred" ? "BEGIN" : "BEGIN IMMEDIATE");
          return ok(`R.BEGIN ${req.mode ?? "immediate"}`);
        case "read":
          return ok("R.read", { n: (this.r.prepare("SELECT n FROM counter").get() as { n: number }).n });
        case "write":
          this.r.prepare("UPDATE counter SET n = n + 1").run();
          return ok("R.write(+1)");
        case "rollback":
          this.r.exec("ROLLBACK");
          return ok("R.ROLLBACK");
        case "commit":
          this.r.exec("COMMIT");
          return ok("R.COMMIT");
        case "status":
          return {
            ok: true,
            n: this.n(),
            inTransaction: this.r.inTransaction,
            ms: Date.now() - started,
            t,
          };
        case "timeline":
          return { ok: true, ms: 0, t };
        default:
          return fail({ error: `unknown command ${String((req as { cmd: string }).cmd)}` }, String((req as { cmd: string }).cmd));
      }
    } catch (e) {
      return fail(errInfo(e), `${req.cmd}${req.mode ? ` ${req.mode}` : ""}`);
    }
  }

  /** 夹具有效性：交接态是否符合 schedule 定义。 */
  validity(): { valid: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (this.schedule === "active-writer") {
      if (!this.wHoldsLock && !this.released) reasons.push("W 未持有写锁");
      if (this.r.inTransaction) reasons.push("R 在交接时不应有事务");
    } else {
      const staleWrite = this.ledger.find((e) => e.actor === "fixture" && e.cmd.includes("stale snapshot"));
      if (!staleWrite || staleWrite.ok) reasons.push("未观测到预期的 SQLITE_BUSY_SNAPSHOT");
      if (!this.r.inTransaction) reasons.push("R 的陈旧事务未保留到交接");
    }
    return { valid: reasons.length === 0, reasons };
  }

  /** 终态：n、R 是否仍开事务、agent 侧提交次数。 */
  finalState() {
    const agentCommits = this.ledger.filter((e) => e.actor === "agent" && e.cmd === "R.COMMIT" && e.ok).length;
    const agentWrites = this.ledger.filter((e) => e.actor === "agent" && e.cmd === "R.write(+1)" && e.ok).length;
    return {
      n: this.n(),
      rInTransaction: this.r.inTransaction,
      wHoldsLock: this.wHoldsLock,
      agentCommits,
      agentWrites,
      observedAdmissionAt: this.observedAdmissionAt,
      releaseScheduledFor: this.releaseScheduledFor,
      released: this.released,
    };
  }

  close(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    try {
      if (this.r.inTransaction) this.r.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    try {
      if (this.w.inTransaction) this.w.exec("COMMIT");
    } catch {
      /* ignore */
    }
    this.r.close();
    this.w.close();
  }
}

export const roundTrip = (fixture: TrialFixture, req: CommandRequest): CommandResponse => fixture.handle(req);
