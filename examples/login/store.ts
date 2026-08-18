import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { User } from "./auth.js";

export interface UserStore {
  load(): User[];
  save(users: User[]): void;
}

export class FileUserStore implements UserStore {
  constructor(private readonly filePath: string) {}

  load(): User[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isUser);
    } catch {
      return [];
    }
  }

  save(users: User[]): void {
    writeJsonAtomic(this.filePath, users);
  }
}

export interface BlacklistEntry {
  jti: string;
  exp: number;
}

export interface FailureRecord {
  username: string;
  count: number;
  firstAt: number;
}

export interface SecurityState {
  blacklist: BlacklistEntry[];
  failures: FailureRecord[];
}

export interface SecurityStateStore {
  load(): SecurityState;
  save(state: SecurityState): void;
}

// 吊销黑名单与登录锁定计数单独落盘：重启后 logout 吊销与锁定窗口仍然生效
export class FileSecurityStateStore implements SecurityStateStore {
  constructor(private readonly filePath: string) {}

  load(): SecurityState {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return emptyState();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return emptyState();
      const state = parsed as Record<string, unknown>;
      return {
        blacklist: Array.isArray(state.blacklist) ? state.blacklist.filter(isBlacklistEntry) : [],
        failures: Array.isArray(state.failures) ? state.failures.filter(isFailureRecord) : [],
      };
    } catch {
      return emptyState();
    }
  }

  save(state: SecurityState): void {
    writeJsonAtomic(this.filePath, state);
  }
}

function emptyState(): SecurityState {
  return { blacklist: [], failures: [] };
}

// 先写临时文件再原子改名：崩溃/中断不会留下半截损坏的文件
function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, filePath);
}

function isUser(value: unknown): value is User {
  if (typeof value !== "object" || value === null) return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === "string" &&
    typeof user.username === "string" &&
    typeof user.passwordHash === "string" &&
    typeof user.createdAt === "string"
  );
}

function isBlacklistEntry(value: unknown): value is BlacklistEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.jti === "string" && typeof entry.exp === "number";
}

function isFailureRecord(value: unknown): value is FailureRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.username === "string" &&
    typeof record.count === "number" &&
    typeof record.firstAt === "number"
  );
}
