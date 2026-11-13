import type { ThreadStore } from "./store.js";

export interface InjectionReceipt {
  kind: "status-card" | "handoff" | "anchor";
  summary: string;
  ts: string;
}

const key = (sessionId: string): string => `injection:${sessionId}`;

// 「本轮注入了什么」回执（P0-0）：只记摘要与时间，不存注入正文——
// 回执用于让人/编排器确认"这一刻喂给模型的是什么"，正文仍在事件流水与渲染器里。
export function recordInjection(store: ThreadStore, sessionId: string, entry: Omit<InjectionReceipt, "ts"> & { ts?: string }): void {
  const receipt: InjectionReceipt = { ...entry, ts: entry.ts ?? new Date().toISOString() };
  store.setMeta(key(sessionId), JSON.stringify(receipt));
}

export function lastInjection(store: ThreadStore, sessionId: string): InjectionReceipt | undefined {
  const raw = store.getMeta(key(sessionId));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<InjectionReceipt>;
    if (typeof parsed.kind !== "string" || typeof parsed.summary !== "string") return undefined;
    return { kind: parsed.kind as InjectionReceipt["kind"], summary: parsed.summary, ts: parsed.ts ?? "" };
  } catch {
    return undefined;
  }
}
