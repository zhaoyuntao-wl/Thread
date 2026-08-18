import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { MAX_BODY_CHARS, truncateBody } from "./events.js";
import type { EventKind, SessionEvent } from "./events.js";
import { assertTransition } from "./state.js";
import type { DecisionStatus, GoalStatus } from "./state.js";
import { ensureSchema } from "./schema.js";
import { SpillPolicy, isIndexable } from "./governor.js";

export const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts TEXT NOT NULL,
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  meta TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  project_key TEXT,
  scope TEXT NOT NULL DEFAULT 'project',
  origin TEXT,
  spilled INTEGER NOT NULL DEFAULT 0,
  isolation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  body,
  content='events',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq_start INTEGER NOT NULL,
  seq_end INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, id);

CREATE TABLE IF NOT EXISTS spills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  ref TEXT NOT NULL,
  blob TEXT,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lineage_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  src_type TEXT NOT NULL,
  src_id INTEGER,
  dst_type TEXT NOT NULL,
  dst_id INTEGER,
  ref TEXT,
  edge_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineage_src ON lineage_edges(session_id, src_type, src_id);
CREATE INDEX IF NOT EXISTS idx_lineage_dst ON lineage_edges(session_id, dst_type, dst_id);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
`;

export const STRUCTURED_SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source_event INTEGER,
  created_at TEXT NOT NULL,
  project_key TEXT,
  scope TEXT NOT NULL DEFAULT 'project',
  origin TEXT,
  isolation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_id, id);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  superseded_by INTEGER,
  source_event INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  project_key TEXT,
  scope TEXT NOT NULL DEFAULT 'project',
  origin TEXT,
  isolation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id, status);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'preference',
  source_event INTEGER,
  created_at TEXT NOT NULL,
  project_key TEXT,
  scope TEXT NOT NULL DEFAULT 'project',
  origin TEXT,
  isolation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id, id);

CREATE TABLE IF NOT EXISTS session_isolation (
  session_id TEXT PRIMARY KEY,
  isolated INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lineage_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  src_type TEXT NOT NULL,
  src_id INTEGER,
  dst_type TEXT NOT NULL,
  dst_id INTEGER,
  ref TEXT,
  edge_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lineage_src ON lineage_edges(session_id, src_type, src_id);
CREATE INDEX IF NOT EXISTS idx_lineage_dst ON lineage_edges(session_id, dst_type, dst_id);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_entities (
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  edge TEXT NOT NULL DEFAULT 'references',
  ts TEXT NOT NULL,
  PRIMARY KEY (decision_id, entity_id)
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  ts TEXT NOT NULL
);
`;

export interface ThreadStoreOptions {
  eventsPath: string;
  structuredPath: string;
  projectKey?: string;
}

export interface AppendOptions {
  projectKey?: string;
  scope?: "global" | "project";
  origin?: string;
  spillRef?: string;
  isolation?: boolean;
}

export interface StructuredWriteOptions {
  sourceEvent?: number;
  ts?: string;
  scope?: "session" | "project" | "global";
  projectKey?: string;
  origin?: string;
  isolation?: boolean;
}

export interface Episode {
  id: number;
  session_id: string;
  seq_start: number;
  seq_end: number | null;
  status: string;
  summary: string | null;
  created_at: string;
}

export interface Goal {
  id: number;
  session_id: string;
  text: string;
  status: GoalStatus;
  source_event: number | null;
  created_at: string;
  project_key?: string | null;
  scope?: string;
  origin?: string | null;
  isolation?: number;
}

export interface Decision {
  id: number;
  session_id: string;
  text: string;
  status: DecisionStatus;
  superseded_by: number | null;
  source_event: number | null;
  created_at: string;
  updated_at: string;
  project_key?: string | null;
  scope?: string;
  origin?: string | null;
  isolation?: number;
}

export interface FeedbackRow {
  id: number;
  session_id: string;
  text: string;
  kind: "preference" | "correction";
  source_event: number | null;
  created_at: string;
  project_key?: string | null;
  scope?: string;
  origin?: string | null;
  isolation?: number;
}

export interface LineageNeighbor {
  id: number;
  session_id: string;
  src_type: string;
  src_id: number | null;
  dst_type: string;
  dst_id: number | null;
  ref: string | null;
  edge_type: string;
  confidence: number;
  ts: string;
}

export interface SearchHit {
  id: number;
  session_id: string;
  kind: EventKind;
  ts: string;
  seq: number;
  body: string;
  truncated: boolean;
  score: number;
}

export class ThreadStore {
  readonly eventsDb: Database.Database;
  readonly structuredDb: Database.Database;
  readonly projectKey?: string;
  private spillPolicy: SpillPolicy;

  constructor(opts: ThreadStoreOptions, spillPolicy: SpillPolicy = new SpillPolicy()) {
    this.eventsDb = openDb(opts.eventsPath, EVENTS_SCHEMA, "events");
    this.structuredDb = openDb(opts.structuredPath, STRUCTURED_SCHEMA, "structured");
    this.projectKey = opts.projectKey;
    this.spillPolicy = spillPolicy;
  }

  getRecentSessionId(): string | undefined {
    const row = this.eventsDb
      .prepare(`SELECT session_id FROM events ORDER BY id DESC LIMIT 1`)
      .get() as { session_id: string } | undefined;
    return row?.session_id;
  }

  // 引用回拉：spill.blob → spills 表；无 spill 返回事件 body；不可回拉返回 body + 缺失标记
  // 隔离保护：隔离事件的原文仅其所属会话可回拉（sessionId 缺省时隔离内容不可见）
  expand(eventId: number, opts: { sessionId?: string } = {}): string {
    const meta = this.eventsDb
      .prepare(`SELECT session_id, isolation FROM events WHERE id = ?`)
      .get(eventId) as { session_id: string; isolation: number } | undefined;
    if (!meta) {
      return `[缺失: event ${eventId} 不存在]`;
    }
    if (meta.isolation === 1 && opts.sessionId !== meta.session_id) {
      return `[隔离内容不可见: event ${eventId} 属于隔离会话]`;
    }
    const spill = this.eventsDb
      .prepare(`SELECT blob, ref FROM spills WHERE event_id = ? LIMIT 1`)
      .get(eventId) as { blob: string | null; ref: string } | undefined;
    if (spill?.blob != null) {
      return spill.blob;
    }
    const event = this.eventsDb.prepare(`SELECT body FROM events WHERE id = ?`).get(eventId) as
      | { body: string }
      | undefined;
    if (event) {
      return spill
        ? `${event.body}\n[原文不可回拉: ref=${spill.ref}]`
        : event.body;
    }
    return `[缺失: event ${eventId} 不存在]`;
  }

  hasAssistantTurn(sessionId: string, uuid: string): boolean {
    return (
      this.eventsDb
        .prepare(
          `SELECT 1 FROM events WHERE session_id = ? AND kind = 'assistant_message' AND json_extract(meta, '$.assistant_uuid') = ? LIMIT 1`,
        )
        .get(sessionId, uuid) !== undefined
    );
  }

  close(): void {
    this.eventsDb.close();
    this.structuredDb.close();
  }

  append(
    event: Omit<SessionEvent, "id" | "seq" | "truncated">,
    opts: AppendOptions = {},
  ): SessionEvent & { project_key?: string; scope?: string; origin?: string; spilled?: number; isolation?: number } {
    return this.eventsDb.transaction(() => {
      if (opts.origin) {
        const existing = this.eventsDb
          .prepare(`SELECT id FROM events WHERE origin = ? LIMIT 1`)
          .get(opts.origin) as { id: number } | undefined;
        if (existing) {
          return this.eventsDb
            .prepare(
              `SELECT * FROM events WHERE id = ?`,
            )
            .get(existing.id) as SessionEvent & { project_key?: string; scope?: string; origin?: string; spilled?: number };
        }
      }

      const { body, truncated } = truncateBody(event.body);
      const metaJson = event.meta ? JSON.stringify(event.meta) : null;
      const metaTruncated = metaJson ? metaJson.length > MAX_BODY_CHARS : false;
      const storedMetaJson =
        metaTruncated && metaJson ? metaJson.slice(0, MAX_BODY_CHARS) : metaJson;

      const spill = this.spillPolicy.evaluate(body, { ref: opts.spillRef });
      const storedBody = spill.spill ? spill.kept : body;

      const seq = this.nextSeq(event.session_id);
      // 项目事实（tool 类事件）强制共享：隔离只作用于对话上下文，事实血缘不断链
      const isolation = isToolKind(event.kind) ? 0 : opts.isolation ? 1 : 0;
      this.eventsDb
        .prepare(
          `INSERT INTO events (session_id, kind, ts, seq, body, meta, truncated, project_key, scope, origin, spilled, isolation)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.session_id,
          event.kind,
          event.ts,
          seq,
          storedBody,
          storedMetaJson,
          truncated || metaTruncated ? 1 : 0,
          opts.scope === "global" ? null : opts.projectKey ?? this.projectKey ?? null,
          opts.scope ?? "project",
          opts.origin ?? null,
          spill.spill ? 1 : 0,
          isolation,
        );
      const eventId = this.eventsDb.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };

      if (spill.spill) {
        const sha256 = sha256Hex(body);
        this.eventsDb
          .prepare(
            `INSERT INTO spills (event_id, ref, blob, sha256, created_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(eventId.id, spill.ref ?? `spill:${eventId.id}`, body, sha256, event.ts);
      }

      if (isIndexable(event.kind)) {
        this.eventsDb.prepare(`INSERT INTO events_fts(rowid, body) VALUES (?, ?)`).run(eventId.id, cjkSpace(storedBody));
      }

      const eventMeta = event.meta as Record<string, unknown> | undefined;
      if (typeof eventMeta?.file_path === "string") {
        this.addLineageEdge(event.session_id, "event", eventId.id, "file", null, "touches_file", {
          ref: eventMeta.file_path,
          ts: event.ts,
        });
      }
      if (typeof eventMeta?.tool_name === "string") {
        this.addLineageEdge(event.session_id, "event", eventId.id, "tool", null, "uses_tool", {
          ref: eventMeta.tool_name,
          ts: event.ts,
        });
      }

      this.updateEpisode(event.session_id, seq, event.kind, event.ts);
      return {
        ...event,
        id: eventId.id,
        seq,
        body: storedBody,
        meta: storedMetaJson ? (safeParse(storedMetaJson) as Record<string, unknown>) : undefined,
        truncated: truncated || metaTruncated,
        project_key: opts.projectKey ?? this.projectKey,
        scope: opts.scope ?? "project",
        origin: opts.origin,
        spilled: spill.spill ? 1 : 0,
        isolation,
      };
    })();
  }

  transact<T>(fn: () => T): T {
    return this.structuredDb.transaction(fn)();
  }

  search(query: string, opts: { limit?: number; sessionId?: string } = {}): SearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }
    let sql = `
      SELECT e.id, e.session_id, e.kind, e.ts, e.seq, e.body, e.truncated, bm25(events_fts) AS score
      FROM events_fts f JOIN events e ON e.id = f.rowid
      WHERE events_fts MATCH ?`;
    const params: unknown[] = [ftsQuery];
    if (opts.sessionId) {
      // 当前会话可见自己的全部内容（含隔离），其他会话只见未隔离行
      sql += ` AND (e.session_id = ? OR e.isolation = 0)`;
      params.push(opts.sessionId);
    } else {
      sql += ` AND e.isolation = 0`;
    }
    sql += ` ORDER BY score LIMIT ?`;
    params.push(opts.limit ?? 20);
    return this.eventsDb.prepare(sql).all(...params) as unknown as SearchHit[];
  }

  getActiveEpisode(sessionId: string): Episode | undefined {
    return this.eventsDb
      .prepare(
        `SELECT * FROM episodes WHERE session_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as Episode | undefined;
  }

  getLatestEpisodeWithSummary(sessionId: string): Episode | undefined {
    return this.eventsDb
      .prepare(
        `SELECT * FROM episodes WHERE session_id = ? AND summary IS NOT NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as Episode | undefined;
  }

  addGoal(
    sessionId: string,
    text: string,
    opts: StructuredWriteOptions = {},
  ): Goal {
    const existing = this.findByOrigin("goals", opts.origin);
    if (existing) {
      return existing as unknown as Goal;
    }
    const ts = opts.ts ?? new Date().toISOString();
    const goal = this.structuredDb
      .prepare(
        `INSERT INTO goals (session_id, text, status, source_event, created_at, project_key, scope, origin, isolation)
         VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        sessionId,
        text,
        opts.sourceEvent ?? null,
        ts,
        opts.scope === "global" ? null : opts.projectKey ?? this.projectKey ?? null,
        opts.scope ?? "project",
        opts.origin ?? null,
        opts.isolation ? 1 : 0,
      ) as Goal;
    if (opts.sourceEvent) {
      this.addLineageEdge(sessionId, "goal", goal.id, "event", opts.sourceEvent, "derived_from", {
        ts,
      });
    }
    return goal;
  }

  getActiveGoals(sessionId: string): Goal[] {
    return this.structuredDb
      .prepare(
        `SELECT * FROM goals WHERE session_id = ? AND status = 'active' ORDER BY id`,
      )
      .all(sessionId) as Goal[];
  }

  getFeedback(sessionId: string, limit = 5): FeedbackRow[] {
    return this.structuredDb
      .prepare(`SELECT * FROM feedback WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
      .all(sessionId, limit) as FeedbackRow[];
  }

  getRecentEvents(sessionId: string, limit = 5): SessionEvent[] {
    const rows = this.eventsDb
      .prepare(
        `SELECT id, session_id, kind, ts, seq, body, meta, truncated
         FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Omit<SessionEvent, "meta"> & { meta: string | null }>;
    return rows.map((r) => ({
      ...r,
      meta: r.meta ? (safeParse(r.meta) as Record<string, unknown>) : undefined,
    }));
  }

  updateGoalStatus(sessionId: string, goalId: number, status: GoalStatus): Goal | undefined {
    return this.structuredDb
      .prepare(
        `UPDATE goals SET status = ? WHERE id = ? AND session_id = ? RETURNING *`,
      )
      .get(status, goalId, sessionId) as Goal | undefined;
  }

  addFeedback(
    sessionId: string,
    text: string,
    kind: "preference" | "correction",
    opts: StructuredWriteOptions = {},
  ): FeedbackRow {
    const existing = this.findByOrigin("feedback", opts.origin);
    if (existing) {
      return existing as unknown as FeedbackRow;
    }
    const ts = opts.ts ?? new Date().toISOString();
    return this.structuredDb
      .prepare(
        `INSERT INTO feedback (session_id, text, kind, source_event, created_at, project_key, scope, origin, isolation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        sessionId,
        text,
        kind,
        opts.sourceEvent ?? null,
        ts,
        opts.scope === "global" ? null : opts.projectKey ?? this.projectKey ?? null,
        opts.scope ?? "project",
        opts.origin ?? null,
        opts.isolation ? 1 : 0,
      ) as FeedbackRow;
  }

  // 反馈治理（B⑥-② 恢复通道）：按 id 删除反馈行——教训可删即恢复；事件流水保留（真相源不变）。
  // 单用户语义：跨会话行亦可删（治理动作由用户/其代理发起）。
  deleteFeedback(id: number): boolean {
    const res = this.structuredDb.prepare(`DELETE FROM feedback WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  proposeDecision(
    sessionId: string,
    text: string,
    opts: StructuredWriteOptions = {},
  ): Decision {
    const existing = this.findByOrigin("decisions", opts.origin);
    if (existing) {
      return existing as unknown as Decision;
    }
    const dup = this.structuredDb
      .prepare(
        `SELECT * FROM decisions WHERE session_id = ? AND text = ? AND status NOT IN ('superseded', 'revoked') LIMIT 1`,
      )
      .get(sessionId, text) as Decision | undefined;
    if (dup) {
      return dup;
    }
    const ts = opts.ts ?? new Date().toISOString();
    const decision = this.structuredDb
      .prepare(
        `INSERT INTO decisions (session_id, text, status, source_event, created_at, updated_at, project_key, scope, origin, isolation)
         VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        sessionId,
        text,
        opts.sourceEvent ?? null,
        ts,
        ts,
        opts.scope === "global" ? null : opts.projectKey ?? this.projectKey ?? null,
        opts.scope ?? "project",
        opts.origin ?? null,
        opts.isolation ? 1 : 0,
      ) as Decision;
    if (opts.sourceEvent) {
      this.addLineageEdge(sessionId, "decision", decision.id, "event", opts.sourceEvent, "derived_from", {
        ts,
      });
    }
    return decision;
  }

  // 结构化表幂等：origin 已存在（含跨会话）则返回既有行，不重复写
  private findByOrigin(
    table: "goals" | "decisions" | "feedback",
    origin?: string,
  ): Record<string, unknown> | undefined {
    if (!origin) {
      return undefined;
    }
    return this.structuredDb
      .prepare(`SELECT * FROM ${table} WHERE origin = ? LIMIT 1`)
      .get(origin) as Record<string, unknown> | undefined;
  }

  confirmLatestProposed(
    sessionId: string,
    opts: { ts?: string } = {},
  ): Decision | undefined {
    const target = this.structuredDb
      .prepare(
        `SELECT * FROM decisions WHERE session_id = ? AND status = 'proposed' ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as Decision | undefined;
    if (!target) {
      return undefined;
    }
    return this.transitionDecision(target, "active", opts.ts);
  }

  revokeLatestActive(
    sessionId: string,
    opts: { ts?: string } = {},
  ): Decision | undefined {
    const target = this.structuredDb
      .prepare(
        `SELECT * FROM decisions WHERE session_id = ? AND status IN ('proposed', 'active') ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as Decision | undefined;
    if (!target) {
      return undefined;
    }
    return this.transitionDecision(target, "revoked", opts.ts);
  }

  supersedeLatestActive(
    sessionId: string,
    replacementText: string,
    opts: { sourceEvent?: number; ts?: string } = {},
  ): { superseded: Decision; replacement: Decision } | undefined {
    const target = this.structuredDb
      .prepare(
        `SELECT * FROM decisions WHERE session_id = ? AND status IN ('proposed', 'active') ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as Decision | undefined;
    const ts = opts.ts ?? new Date().toISOString();
    if (!target) {
      return undefined;
    }
    const replacement = this.structuredDb
      .prepare(
        `INSERT INTO decisions (session_id, text, status, superseded_by, source_event, created_at, updated_at, isolation)
         VALUES (?, ?, 'active', NULL, ?, ?, ?, ?) RETURNING *`,
      )
      .get(sessionId, replacementText, opts.sourceEvent ?? null, ts, ts, target.isolation ?? 0) as Decision;
    const superseded = this.transitionDecision(target, "superseded", ts, replacement.id);
    this.addLineageEdge(sessionId, "decision", target.id, "decision", replacement.id, "supersedes", {
      ts,
    });
    return { superseded, replacement };
  }

  getActiveDecisions(sessionId: string): Decision[] {
    return this.structuredDb
      .prepare(
        `SELECT * FROM decisions WHERE session_id = ? AND status = 'active' ORDER BY id`,
      )
      .all(sessionId) as Decision[];
  }

  // 作用域合并（B②）：当前会话全部 active + 同项目 project 级 active（其他会话建立）——非当前项目硬过滤
  // 隔离过滤：其他会话的隔离行（isolation=1）不可见
  getActiveDecisionsMerged(sessionId: string, projectKey?: string): Decision[] {
    if (!projectKey) {
      return this.getActiveDecisions(sessionId);
    }
    return this.structuredDb
      .prepare(
        `SELECT * FROM decisions
         WHERE status = 'active'
           AND (session_id = ? OR (project_key = ? AND scope = 'project'))
           AND (session_id = ? OR isolation = 0)
         ORDER BY id`,
      )
      .all(sessionId, projectKey, sessionId) as Decision[];
  }

  // 决策变更情境（§1.5.3c 机制 3）：项目级最近变更的决策（含 proposed/active，按 updated_at 倒序），
  // 供状态卡"最近决策"块——模型打开会话即见项目刚定的决策，不靠自觉查询。
  getRecentDecisionsMerged(sessionId: string, projectKey: string | undefined, limit = 3): Decision[] {
    if (!projectKey) {
      return this.structuredDb
        .prepare(
          `SELECT * FROM decisions
           WHERE session_id = ? OR isolation = 0
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
        )
        .all(sessionId, limit) as Decision[];
    }
    return this.structuredDb
      .prepare(
        `SELECT * FROM decisions
         WHERE (session_id = ? OR (project_key = ? AND scope = 'project'))
           AND (session_id = ? OR isolation = 0)
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(sessionId, projectKey, sessionId, limit) as Decision[];
  }

  getActiveGoalsMerged(sessionId: string, projectKey?: string): Goal[] {
    if (!projectKey) {
      return this.getActiveGoals(sessionId);
    }
    return this.structuredDb
      .prepare(
        `SELECT * FROM goals
         WHERE status = 'active'
           AND (session_id = ? OR (project_key = ? AND scope = 'project'))
           AND (session_id = ? OR isolation = 0)
         ORDER BY id`,
      )
      .all(sessionId, projectKey, sessionId) as Goal[];
  }

  // 反馈合并：当前会话 + 同项目 project 级 + global 级（跨项目共享），去重按 text
  // 隔离过滤：其他会话的隔离行不可见
  getFeedbackMerged(sessionId: string, projectKey: string | undefined, limit = 5): FeedbackRow[] {
    const rows = this.structuredDb
      .prepare(
        `SELECT * FROM feedback
         WHERE (session_id = ? OR scope = 'global' OR (project_key = ? AND scope = 'project'))
           AND (session_id = ? OR isolation = 0)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, projectKey ?? "", sessionId, limit) as FeedbackRow[];
    const seen = new Set<string>();
    const out: FeedbackRow[] = [];
    for (const row of rows) {
      if (seen.has(row.text)) {
        continue;
      }
      seen.add(row.text);
      out.push(row);
    }
    return out;
  }

  // 会话临时隔离（B⑧）：会话级可变开关——隔离期间对话上下文仅自己可见，项目事实（tool）仍共享
  setSessionIsolation(sessionId: string, isolated: boolean): void {
    this.structuredDb
      .prepare(
        `INSERT INTO session_isolation (session_id, isolated, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET isolated = excluded.isolated, updated_at = excluded.updated_at`,
      )
      .run(sessionId, isolated ? 1 : 0, new Date().toISOString());
  }

  getSessionIsolation(sessionId: string): boolean {
    const row = this.structuredDb
      .prepare(`SELECT isolated FROM session_isolation WHERE session_id = ?`)
      .get(sessionId) as { isolated: number } | undefined;
    return row?.isolated === 1;
  }

  // 沉淀：清除指定结构化行的隔离标记（隔离会话期间产生的决策按需转共享）
  unisolateRow(sessionId: string, table: "goals" | "decisions" | "feedback", id: number): boolean {
    const row = this.structuredDb
      .prepare(`UPDATE ${table} SET isolation = 0 WHERE id = ? AND session_id = ? RETURNING id`)
      .get(id, sessionId) as { id: number } | undefined;
    return row !== undefined;
  }

  getLatestProposed(sessionId: string): Decision | undefined {
    return this.structuredDb
      .prepare(
        `SELECT * FROM decisions WHERE session_id = ? AND status = 'proposed' ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as Decision | undefined;
  }

  getDecisions(sessionId: string, status?: DecisionStatus): Decision[] {
    if (status) {
      return this.structuredDb
        .prepare(`SELECT * FROM decisions WHERE session_id = ? AND status = ? ORDER BY id`)
        .all(sessionId, status) as Decision[];
    }
    return this.structuredDb.prepare(`SELECT * FROM decisions WHERE session_id = ? ORDER BY id`).all(sessionId) as Decision[];
  }

  // 血缘分库（B④）：任一端 ∈ {goal,decision,feedback} → 结构化库；两端均 ∈ {event,file,tool} → 事件库
  private lineageDb(srcType: string, dstType: string): Database.Database {
    const srcEvent = srcType === "event" || srcType === "file" || srcType === "tool";
    const dstEvent = dstType === "event" || dstType === "file" || dstType === "tool";
    return srcEvent && dstEvent ? this.eventsDb : this.structuredDb;
  }

  addLineageEdge(
    sessionId: string,
    srcType: string,
    srcId: number | null,
    dstType: string,
    dstId: number | null,
    edgeType: string,
    opts: { ref?: string; confidence?: number; ts?: string } = {},
  ): void {
    const db = this.lineageDb(srcType, dstType);
    db
      .prepare(
        `INSERT INTO lineage_edges (session_id, src_type, src_id, dst_type, dst_id, ref, edge_type, confidence, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        srcType,
        srcId,
        dstType,
        dstId,
        opts.ref ?? null,
        edgeType,
        opts.confidence ?? 1.0,
        opts.ts ?? new Date().toISOString(),
      );
  }

  getRelatedEvents(sessionId: string, eventId: number): LineageNeighbor[] {
    return this.getRelatedEdges(sessionId, "event", eventId);
  }

  getRelatedEdges(sessionId: string, type: string, id: number): LineageNeighbor[] {
    const db =
      type === "event" || type === "file" || type === "tool" ? this.eventsDb : this.structuredDb;
    return db
      .prepare(
        `SELECT * FROM lineage_edges
         WHERE session_id = ? AND (src_type = ? AND src_id = ? OR dst_type = ? AND dst_id = ?)
         ORDER BY id`,
      )
      .all(sessionId, type, id, type, id) as unknown as LineageNeighbor[];
  }

  getEventsForFile(sessionId: string, filePath: string): LineageNeighbor[] {
    return this.eventsDb
      .prepare(
        `SELECT * FROM lineage_edges
         WHERE session_id = ? AND dst_type = 'file' AND ref = ?
         ORDER BY id`,
      )
      .all(sessionId, filePath) as unknown as LineageNeighbor[];
  }

  private transitionDecision(
    decision: Decision,
    to: DecisionStatus,
    ts?: string,
    supersededBy?: number,
  ): Decision {
    assertTransition(decision.status, to);
    const updatedAt = ts ?? new Date().toISOString();
    return this.structuredDb
      .prepare(
        `UPDATE decisions SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ? RETURNING *`,
      )
      .get(to, supersededBy ?? decision.superseded_by, updatedAt, decision.id) as Decision;
  }

  private nextSeq(sessionId: string): number {
    const row = this.eventsDb
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?`)
      .get(sessionId) as { seq: number };
    return row.seq;
  }

  private updateEpisode(sessionId: string, seq: number, kind: EventKind, ts: string): void {
    if (kind === "user_message") {
      this.closeActiveEpisode(sessionId, seq - 1);
      this.eventsDb
        .prepare(
          `INSERT INTO episodes (session_id, seq_start, status, created_at) VALUES (?, ?, 'active', ?)`,
        )
        .run(sessionId, seq, ts);
    } else {
      this.eventsDb
        .prepare(`UPDATE episodes SET seq_end = ? WHERE session_id = ? AND status = 'active'`)
        .run(seq, sessionId);
    }
  }

  private closeActiveEpisode(sessionId: string, seqEnd: number): void {
    if (seqEnd <= 0) {
      return;
    }
    const episode = this.getActiveEpisode(sessionId);
    if (!episode) {
      return;
    }
    const rows = this.eventsDb
      .prepare(
        `SELECT body FROM events WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
      )
      .all(sessionId, episode.seq_start, seqEnd) as Array<{ body: string }>;
    const summary = rows
      .map((r) => r.body)
      .join("\n")
      .slice(0, EPISODE_SUMMARY_CHARS);
    this.eventsDb
      .prepare(
        `UPDATE episodes SET seq_end = ?, summary = COALESCE(summary, ?) WHERE id = ? AND session_id = ?`,
      )
      .run(seqEnd, summary, episode.id, sessionId);
  }
}

function openDb(path: string, schema: string, kind: "events" | "structured"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(schema);
  ensureSchema(db, kind);
  return db;
}

function isToolKind(kind: EventKind): boolean {
  return kind === "tool_call" || kind === "tool_result";
}

function toFtsQuery(query: string): string {
  const tokens = cjkSpace(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return "";
  }
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
}

const EPISODE_SUMMARY_CHARS = 4000;

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function cjkSpace(text: string): string {
  return text
    .replace(/([\u3400-\u9fff\uf900-\ufaff])/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

// 分层优先级裁决（B③）：同事实（归一化 text）跨层级出现时保留最高优先级 会话内>项目>用户>全局
const SCOPE_PRIORITY: Record<string, number> = { session: 3, project: 2, global: 1 };

export function applyScopePriority<T extends { text: string; scope?: string | null }>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const key = normalizeText(row.text);
    if (!key) {
      continue;
    }
    const existing = best.get(key);
    const prio = SCOPE_PRIORITY[row.scope ?? "project"] ?? 0;
    const existingPrio = existing ? (SCOPE_PRIORITY[existing.scope ?? "project"] ?? 0) : -1;
    if (!existing || prio > existingPrio) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/[，。！!？?、；;：:,.·'"“”‘’()（）[\]【】<>《》]/g, "")
    .toLowerCase();
}
