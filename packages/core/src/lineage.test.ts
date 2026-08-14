import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTurn } from "./light-confirm.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-lineage-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "test-proj" });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("lineage edges", () => {
  it("records touches_file and uses_tool edges on event append", () => {
    const ev = store.append({
      session_id: "l1",
      kind: "tool_call",
      ts: "2026-08-13T00:00:00.000Z",
      body: "edit src/auth.ts",
      meta: { tool_name: "Edit", file_path: "src/auth.ts" },
    });
    const related = store.getRelatedEvents("l1", ev.id);
    const types = related.map((r) => `${r.dst_type}:${r.edge_type}:${r.ref ?? ""}`).sort();
    expect(types).toEqual(["file:touches_file:src/auth.ts", "tool:uses_tool:Edit"]);
  });

  it("finds events touching a file", () => {
    const events = store.getEventsForFile("l1", "src/auth.ts");
    expect(events.length).toBeGreaterThan(0);
  });

  it("links decisions to their source event (edge in structured db)", () => {
    const ev = store.append({
      session_id: "l1",
      kind: "assistant_message",
      ts: "2026-08-13T00:00:01.000Z",
      body: "我记下了用 JWT 做认证",
    });
    const applied = applyTurn(store, "l1", { assistant_msg: "我记下了用 JWT 做认证" }, { sourceEvent: ev.id });
    expect(applied.decisions).toHaveLength(1);
    const decision = applied.decisions[0];
    const related = store.getRelatedEdges("l1", "decision", decision.id);
    expect(related.some((r) => r.edge_type === "derived_from" && r.dst_id === ev.id)).toBe(true);
  });

  it("records supersedes edges between decisions", () => {
    const applied = applyTurn(store, "l1", { user_msg: "改用 Session" });
    expect(applied.decisions.map((d) => d.status)).toEqual(["superseded", "active"]);
    const superseded = applied.decisions[0];
    const replacement = applied.decisions[1];
    const edges = store.getRelatedEdges("l1", "decision", superseded.id);
    const supersedes = edges.filter((e) => e.edge_type === "supersedes");
    expect(supersedes).toHaveLength(1);
    expect(supersedes[0].dst_id).toBe(replacement.id);
  });
});
