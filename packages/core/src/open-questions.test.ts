import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listOpenQuestions,
  markTimedOut,
  openQuestionCount,
  recordOpenQuestion,
  renderQuestionLine,
  settleOpenQuestion,
} from "./open-questions.js";
import { ThreadStore } from "./store.js";

let dir: string;
let store: ThreadStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thread-questions-"));
  store = new ThreadStore({ eventsPath: join(dir, "events.db"), structuredPath: join(dir, "structured.db"), projectKey: "q-proj" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const ask = (callId = "call-1") =>
  recordOpenQuestion(store, {
    projectKey: "q-proj",
    sessionId: "s1",
    callId,
    questions: [{ id: "q1", question: "选 A 还是 B？", options: ["A", "B"] }],
    timed: false,
  });

describe("阻塞性问题通道", () => {
  it("记录后进入 open 收件箱", () => {
    const id = ask();
    expect(id).toBeGreaterThan(0);
    expect(openQuestionCount(store, { projectKey: "q-proj" })).toBe(1);
    const rows = listOpenQuestions(store, { projectKey: "q-proj" });
    expect(rows[0]).toMatchObject({ call_id: "call-1", status: "open", timed: 0 });
    expect(JSON.parse(rows[0].questions_json)[0].question).toContain("选 A 还是 B");
  });

  it("settled 后不再计入待答", () => {
    const id = ask();
    expect(settleOpenQuestion(store, id, "settled", [{ answer: "A" }])).toBe(true);
    expect(openQuestionCount(store, { projectKey: "q-proj" })).toBe(0);
    expect(listOpenQuestions(store, { projectKey: "q-proj" })[0].status).toBe("settled");
  });

  it("cancelled 与 settled 同样出队", () => {
    const id = ask();
    settleOpenQuestion(store, id, "cancelled");
    expect(openQuestionCount(store, { projectKey: "q-proj" })).toBe(0);
  });

  it("超时把模型假设落成 proposed 决策，不静默替用户决定", () => {
    const id = ask();
    const result = markTimedOut(store, id, "按 A 继续");
    expect(result.settled).toBe(true);
    expect(result.candidateId).toBeGreaterThan(0);
    const row = listOpenQuestions(store, { projectKey: "q-proj" })[0];
    expect(row.status).toBe("timed_out");
    expect(row.answers_json).toContain("按 A 继续");
    expect(openQuestionCount(store, { projectKey: "q-proj" })).toBe(0);
    const candidates = store.listPendingCandidates({ sessionId: "s1" });
    expect(candidates.some((c) => c.text.includes("假设：按 A 继续"))).toBe(true);
  });

  it("对不存在的 id 超时不抛错", () => {
    expect(markTimedOut(store, 999, "x").settled).toBe(false);
  });

  it("卡片行文案", () => {
    expect(renderQuestionLine(0)).toBe("待答问题：无");
    expect(renderQuestionLine(2)).toContain("待答问题 2 条");
  });
});
