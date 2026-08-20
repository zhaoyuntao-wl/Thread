import { readFileSync } from "node:fs";
import type { ThreadStore } from "./store.js";

// 查询原语（max 设计 2.5）：ls/cd/cat/grep 在关联结构（会话→产出→文档 + 边）上导航。
// 统一信封 NavResult；隔离过滤全链路沿用（isolation=1 仅建立会话可见）。

export interface NavResult {
  kind: "list" | "node" | "content" | "hits";
  title: string;
  items: NavItem[];
  context?: { session_id?: string; asset_id?: number; evidence?: string[] };
}

export interface NavItem {
  id: string;
  type: "session" | "asset" | "event" | "decision" | "todo";
  label: string;
  ref?: string;
}

export interface NavigateOptions {
  nav: "ls" | "cd" | "cat" | "grep";
  target?: string;
  query?: string;
  sessionId?: string;
  viewerSessionId?: string;
  limit?: number;
}

const CONTENT_MAX = 4000;

export function navigate(store: ThreadStore, opts: NavigateOptions): NavResult {
  const viewer = opts.viewerSessionId;
  switch (opts.nav) {
    case "ls":
      return navigateLs(store, opts.target, viewer, opts.limit ?? 20);
    case "cd":
      return navigateCd(store, opts.target, viewer);
    case "cat":
      return navigateCat(store, opts.target, viewer);
    case "grep":
      return navigateGrep(store, opts.query ?? "", opts.sessionId, viewer, opts.limit ?? 10);
  }
}

function visibleAssets(store: ThreadStore, opts: { sessionId?: string; viewer?: string; limit?: number }) {
  if (opts.sessionId) {
    // 会话资产：查看方可见 = 非隔离 + 本会话隔离可见
    return store
      .listAssets(opts.sessionId && opts.viewer === opts.sessionId
        ? { sessionId: opts.sessionId, limit: opts.limit }
        : { sessionId: opts.sessionId, visibleToSession: opts.viewer, limit: opts.limit });
  }
  return store.listAssets({ visibleToSession: opts.viewer, limit: opts.limit });
}

function navigateLs(store: ThreadStore, target: string | undefined, viewer: string | undefined, limit: number): NavResult {
  const assetId = target ? Number(target) : NaN;
  if (Number.isInteger(assetId)) {
    // ls <asset>：边关联子项
    const asset = store.getAsset(assetId);
    if (!asset) {
      return { kind: "list", title: `asset ${assetId} 不存在`, items: [] };
    }
    const edges = store.getRelatedEdges(asset.session_id, "asset", assetId);
    const items: NavItem[] = edges.map((e) => ({
      id: `edge-${e.id}`,
      type: (e.dst_type === "asset" ? "asset" : "event"),
      label: `${e.edge_type}: ${e.dst_type}#${e.dst_id ?? e.ref ?? ""}`,
      ref: e.ref ?? undefined,
    }));
    return { kind: "list", title: `asset ${assetId}（${asset.title}）关联`, items, context: { session_id: asset.session_id, asset_id: assetId } };
  }
  // ls <会话>：产出列表 + 待办
  const sessionId = target ?? viewer ?? store.getRecentSessionId() ?? "";
  const assets = visibleAssets(store, { sessionId, viewer, limit });
  const todos = store.listTodos({ visibleToSession: viewer, sessionId, status: "pending", limit });
  const items: NavItem[] = [
    ...assets.map((a) => ({ id: `asset-${a.id}`, type: "asset" as const, label: `${a.title}（${a.path}）`, ref: a.path })),
    ...todos.map((t) => ({ id: `todo-${t.id}`, type: "todo" as const, label: `${t.text}${t.basis ? `（依据 ${t.basis}）` : ""}` })),
  ];
  return { kind: "list", title: `会话 ${shortSession(sessionId)}：产出 ${assets.length} / 待办 ${todos.length}`, items, context: { session_id: sessionId } };
}

function navigateCd(store: ThreadStore, target: string | undefined, viewer: string | undefined): NavResult {
  if (!target) {
    return { kind: "node", title: "cd 需要目标（asset id / event id / 文档路径）", items: [] };
  }
  const id = Number(target);
  if (Number.isInteger(id)) {
    const asset = store.getAsset(id);
    if (asset) {
      const source = asset.source_event != null ? `event ${asset.source_event}` : undefined;
      const items: NavItem[] = [];
      if (source) {
        items.push({ id: `event-${asset.source_event}`, type: "event", label: `产出事件 #${asset.source_event}`, ref: String(asset.source_event) });
      }
      const edges = store.getRelatedEdges(asset.session_id, "asset", id);
      for (const e of edges) {
        items.push({ id: `edge-${e.id}`, type: "asset", label: `${e.edge_type} → ${e.dst_type}#${e.dst_id ?? e.ref ?? ""}`, ref: e.ref ?? undefined });
      }
      return { kind: "node", title: `产出 ${asset.title}`, items, context: { session_id: asset.session_id, asset_id: id } };
    }
    const ev = store.expand(id, { sessionId: viewer ?? "" });
    if (!ev.startsWith("[缺失")) {
      return { kind: "node", title: `event ${id}`, items: [{ id: `event-${id}`, type: "event", label: ev.slice(0, 500) }] };
    }
    return { kind: "node", title: `目标 ${target} 不是 asset 也不是 event`, items: [] };
  }
  // 文档路径 → 资产
  const assets = store.listAssets({ visibleToSession: viewer, limit: 50 }).filter((a) => a.path === target || a.path.endsWith(target));
  if (assets.length === 0) {
    return { kind: "node", title: `路径 ${target} 未登记为产出`, items: [] };
  }
  return navigateCd(store, String(assets[0].id), viewer);
}

function navigateCat(store: ThreadStore, target: string | undefined, viewer: string | undefined): NavResult {
  if (!target) {
    return { kind: "content", title: "cat 需要目标（asset id / event id / 文档路径）", items: [] };
  }
  const id = Number(target);
  if (Number.isInteger(id)) {
    const asset = store.getAsset(id);
    if (asset) {
      const content = readAssetContent(asset.path);
      return { kind: "content", title: asset.title, items: [{ id: `asset-${id}`, type: "asset", label: content, ref: asset.path }], context: { asset_id: id, session_id: asset.session_id } };
    }
    const ev = store.expand(id, { sessionId: viewer ?? "" });
    return { kind: "content", title: `event ${id}`, items: [{ id: `event-${id}`, type: "event", label: ev.slice(0, CONTENT_MAX) }] };
  }
  // 文档路径直读（未登记也读——文档索引是加速器，不阻塞直接读文件）
  const content = readAssetContent(target);
  return { kind: "content", title: target, items: [{ id: `path-${target}`, type: "asset", label: content, ref: target }] };
}

function navigateGrep(store: ThreadStore, query: string, sessionId: string | undefined, viewer: string | undefined, limit: number): NavResult {
  if (!query) {
    return { kind: "hits", title: "grep 需要关键词", items: [] };
  }
  const hits = store.search(query, { limit });
  const items: NavItem[] = hits.map((h) => ({
    id: `event-${h.id}`,
    type: "event",
    label: `[${h.kind}] ${h.body.slice(0, 200)}`,
    ref: String(h.id),
  }));
  // 资产标题/路径命中（产出索引）
  const assets = store.listAssets({ visibleToSession: viewer, limit: 100 }).filter((a) => a.title.includes(query) || a.path.includes(query));
  for (const a of assets.slice(0, limit)) {
    items.push({ id: `asset-${a.id}`, type: "asset", label: `${a.title}（${a.path}）`, ref: a.path });
  }
  return {
    kind: "hits",
    title: `grep "${query}"：${hits.length} 命中 + ${Math.min(assets.length, limit)} 产出索引`,
    items,
    context: sessionId ? { session_id: sessionId } : undefined,
  };
}

function readAssetContent(path: string): string {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.length > CONTENT_MAX ? `${raw.slice(0, CONTENT_MAX)}\n...[截断]` : raw;
  } catch {
    return `[文件不可读: ${path}]`;
  }
}

function shortSession(sessionId: string): string {
  const cleaned = sessionId.replace(/^session-/, "");
  return cleaned.slice(0, 7);
}
