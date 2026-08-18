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
    mkdirSync(dirname(this.filePath), { recursive: true });
    // 先写临时文件再原子改名：崩溃/中断不会留下半截损坏的用户文件
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(users, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }
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
