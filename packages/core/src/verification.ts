import { execSync } from "node:child_process";
import { platform, release } from "node:os";
import type { ThreadStore } from "./store.js";

export interface Criterion {
  key: string;
  command?: string;
  cwd?: string;
}

export interface EvidenceRow {
  id: number;
  project_key: string;
  session_id: string;
  criterion: string;
  command: string | null;
  exit: number | null;
  passed: number;
  env_fingerprint: string;
  commit_ref: string | null;
  created_at: string;
}

export interface VerifyResult {
  key: string;
  status: "passed" | "failed" | "missing-env";
  exit: number | null;
  output: string;
  evidenceId?: number;
}

export interface VerifyReport {
  results: VerifyResult[];
  passed: number;
  total: number;
}

function gitCommit(cwd: string | undefined): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// 证据门（P0-2）：一条验收条目必须留有真实执行证据（命令 + 退出码 + 环境指纹 + commit），
// 不接受"模型说通过了"；缺命令的条目记为缺环境，不算通过。
const criteriaKey = (projectKey: string): string => `criteria:${projectKey}`;

// 验收条目登记：verify 时自动登记条目键（去重保序），卡片/面板据此计算进度。
export function registerCriteria(store: ThreadStore, projectKey: string, criteria: Criterion[]): Criterion[] {
  const existing = criteriaFor(store, projectKey);
  const keys = new Set(existing.map((c) => c.key));
  const merged = [...existing];
  for (const criterion of criteria) {
    if (!keys.has(criterion.key)) {
      merged.push({ key: criterion.key });
      keys.add(criterion.key);
    }
  }
  store.setMeta(criteriaKey(projectKey), JSON.stringify(merged));
  return merged;
}

export function criteriaFor(store: ThreadStore, projectKey: string): Criterion[] {
  const raw = store.getMeta(criteriaKey(projectKey));
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ key?: unknown }>;
    return parsed.filter((c) => typeof c.key === "string").map((c) => ({ key: String(c.key) }));
  } catch {
    return [];
  }
}

export function progressFor(store: ThreadStore, projectKey: string): { proven: number; total: number; missing: string[] } {
  return evidenceProgress(store, { projectKey, criteria: criteriaFor(store, projectKey) });
}

export function verifyCriteria(
  store: ThreadStore,
  opts: { projectKey: string; sessionId: string; criteria: Criterion[]; cwd?: string },
): VerifyReport {
  const env = `${platform()} ${release()}`;
  const results: VerifyResult[] = [];
  registerCriteria(store, opts.projectKey, opts.criteria);
  for (const criterion of opts.criteria) {
    const cwd = criterion.cwd ?? opts.cwd;
    if (criterion.command === undefined) {
      results.push({ key: criterion.key, status: "missing-env", exit: null, output: "no command" });
      continue;
    }
    let exitCode = 0;
    let output = "";
    try {
      output = execSync(criterion.command, { cwd, encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = typeof e.status === "number" ? e.status : 1;
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    const passed = exitCode === 0;
    const id = store.addEvidence({
      projectKey: opts.projectKey,
      sessionId: opts.sessionId,
      criterion: criterion.key,
      command: criterion.command,
      exit: exitCode,
      passed,
      envFingerprint: env,
      commit: gitCommit(cwd),
    });
    results.push({
      key: criterion.key,
      status: passed ? "passed" : "failed",
      exit: exitCode,
      output: output.trim().split("\n").slice(-5).join("\n"),
      evidenceId: id,
    });
  }
  const passed = results.filter((r) => r.status === "passed").length;
  return { results, passed, total: results.length };
}

export function listEvidenceRows(store: ThreadStore, opts: { projectKey?: string; criterion?: string } = {}): EvidenceRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.projectKey !== undefined) {
    where.push("project_key = ?");
    params.push(opts.projectKey);
  }
  if (opts.criterion !== undefined) {
    where.push("criterion = ?");
    params.push(opts.criterion);
  }
  const sql = `SELECT * FROM evidence${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
  return store.structuredDb.prepare(sql).all(...params) as EvidenceRow[];
}

export function evidenceProgress(store: ThreadStore, opts: { projectKey?: string; criteria: Criterion[] }): { proven: number; total: number; missing: string[] } {
  const proven = new Set<string>();
  for (const row of listEvidenceRows(store, { projectKey: opts.projectKey })) {
    if (row.passed === 1) proven.add(row.criterion);
  }
  const missing = opts.criteria.filter((c) => !proven.has(c.key)).map((c) => c.key);
  return { proven: opts.criteria.filter((c) => proven.has(c.key)).length, total: opts.criteria.length, missing };
}

// 完成门禁：验收条目缺 passing 证据时拒绝标完成，并指出差哪几条。
export function checkCompletionGate(
  store: ThreadStore,
  opts: { projectKey?: string; criteria: Criterion[] },
): { allowed: boolean; missing: string[] } {
  if (opts.criteria.length === 0) return { allowed: true, missing: [] };
  const progress = evidenceProgress(store, opts);
  return { allowed: progress.missing.length === 0, missing: progress.missing };
}

export function renderEvidenceLine(progress: { proven: number; total: number; missing: string[] }): string {
  if (progress.total === 0) return "验收：未登记条目";
  const tail = progress.missing.length === 0 ? "" : `（缺：${progress.missing.join("、")}）`;
  return `验收 ${progress.proven}/${progress.total} 已证${tail}`;
}
