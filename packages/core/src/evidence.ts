// 检索结果组织（2026-09-02 迭代 A，原则一第 15/16 项，北极星强化）：
// 模型查询记忆拿到的证据——去重、多样、最新态清晰、不超预算——直接影响基于记忆的工作质量。
// 全部确定性零 LLM；判定锚定在已确认数据上（token 重叠阈值/结构化行状态机），失败不污染主路径
// （置顶不删改、标注不裁决、兜底不拦截）。默认关闭（queryMemory 库语义），产品通道（runQueryTool）显式开启。
import type { QueryHit } from "./query.js";
import type { ThreadStore } from "./store.js";
import { applyScopePriority } from "./store.js";
import { segment, segmentQuery } from "./segment.js";

const MAX_BODY_CHARS = 240;
const DEDUP_JACCARD = 0.8;
const LATEST_JACCARD = 0.6;
const MMR_LAMBDA = 0.7;
const CHRONO_WEIGHT_PER_DAY = 0.15;
const CHRONO_MAX_PENALTY = 1.0;
const STRUCTURED_MIN_OVERLAP = 0.5;
const STRUCTURED_LIMIT = 5;

function tokenSet(text: string): Set<string> {
  return new Set(segment(text).split(" ").filter((t) => t.length > 0));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) {
      inter++;
    }
  }
  return inter / (a.size + b.size - inter);
}

function relevance(hit: QueryHit): number {
  // bm25 负值越小越相关 → 映射到 (0,1] 正相关；非 bm25 行（结构化/兜底）给中位 0.5
  return hit.score < 0 ? 1 / (1 - hit.score) : 0.5;
}

// chrono 时序加权：同相关度近期优先（温和 nudge，上限 1.0——不淹没真实相关度，只打破近分平局）
export function chronoRank(hits: QueryHit[], nowMs: number = Date.now()): QueryHit[] {
  const now = new Date(nowMs).getTime();
  return hits
    .map((h) => {
      if (h.score >= 0) {
        return h;
      }
      const ageDays = Math.max(0, (now - new Date(h.ts).getTime()) / 86_400_000);
      return { ...h, score: h.score + Math.min(CHRONO_MAX_PENALTY, CHRONO_WEIGHT_PER_DAY * ageDays) };
    })
    .sort((a, b) => (a.score === b.score ? (a.ts < b.ts ? 1 : -1) : a.score - b.score));
}

function dedupNearDuplicates(hits: QueryHit[]): QueryHit[] {
  const kept: QueryHit[] = [];
  for (const hit of hits) {
    const dup = kept.findIndex((k) => jaccard(tokenSet(k.body), tokenSet(hit.body)) >= DEDUP_JACCARD);
    if (dup < 0) {
      kept.push(hit);
      continue;
    }
    const existing = kept[dup];
    const better = hit.score < existing.score || (hit.score === existing.score && hit.ts > existing.ts);
    if (better) {
      kept[dup] = hit;
    }
  }
  return kept;
}

function mmrSelect(hits: QueryHit[], limit: number): QueryHit[] {
  if (hits.length <= limit) {
    return hits;
  }
  const picked: QueryHit[] = [];
  const pickedTokens: Set<string>[] = [];
  const pool = [...hits];
  while (picked.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const rel = relevance(pool[i]);
      let maxSim = 0;
      for (const pt of pickedTokens) {
        const s = jaccard(pt, tokenSet(pool[i].body));
        if (s > maxSim) {
          maxSim = s;
        }
      }
      const mmr = MMR_LAMBDA * rel - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    const chosen = pool.splice(bestIdx, 1)[0];
    picked.push(chosen);
    pickedTokens.push(tokenSet(chosen.body));
  }
  return picked;
}

function markLatest(hits: QueryHit[]): QueryHit[] {
  return hits.map((hit) => {
    const marked = hits.some(
      (other) =>
        other !== hit &&
        other.ts < hit.ts &&
        jaccard(tokenSet(other.body), tokenSet(hit.body)) >= LATEST_JACCARD,
    );
    return marked ? { ...hit, latest: true } : hit;
  });
}

// 近重复去重 → MMR 多样性 top-K → 最新态标注 → 行级截断。不改变命中集合之外的主路径语义。
export function organizeHits(hits: QueryHit[], opts: { limit?: number; maxBodyChars?: number } = {}): QueryHit[] {
  const limit = opts.limit ?? 20;
  const maxBodyChars = opts.maxBodyChars ?? MAX_BODY_CHARS;
  const deduped = dedupNearDuplicates(hits);
  const selected = mmrSelect(deduped, limit);
  const marked = markLatest(selected);
  return marked.map((h) => ({
    ...h,
    body: h.body.length > maxBodyChars ? `${h.body.slice(0, maxBodyChars)}…` : h.body,
  }));
}

// 结构化行优先（迭代 A 第 16 项）：查询 token 与结构化行高重叠时，把带状态语义的行置顶——
// 状态机搬进检索结果（生效/被取代→#n/已废弃），历史原文随后；置顶不删改、失败无污染。
export function findStructuredPriority(
  store: ThreadStore,
  query: string,
  sessionId: string | undefined,
  projectKey: string | undefined,
): QueryHit[] {
  if (!sessionId) {
    return [];
  }
  const qTokens = new Set(segmentQuery(query));
  if (qTokens.size === 0) {
    return [];
  }
  const hits: QueryHit[] = [];
  try {
    const decisions = applyScopePriority(store.getRecentDecisionsMerged(sessionId, projectKey, 30));
    for (const d of decisions) {
      const overlap = overlapRatio(qTokens, tokenSet(d.text));
      if (overlap < STRUCTURED_MIN_OVERLAP) {
        continue;
      }
      const tag =
        d.status === "active"
          ? "生效决策"
          : d.status === "superseded"
            ? `决策·已被取代→#${d.superseded_by ?? "?"}`
            : "决策·已废弃";
      hits.push({
        segment_id: d.id,
        kind: "decision",
        ts: d.updated_at ?? d.created_at,
        seq: d.id,
        body: `【${tag} #${d.id}】${d.text}`,
        score: -(2 + overlap),
        structured: "decisions",
      });
    }
    for (const g of applyScopePriority(store.getActiveGoalsMerged(sessionId, projectKey))) {
      const overlap = overlapRatio(qTokens, tokenSet(g.text));
      if (overlap < STRUCTURED_MIN_OVERLAP) {
        continue;
      }
      hits.push({
        segment_id: g.id,
        kind: "goal",
        ts: g.updated_at ?? g.created_at,
        seq: g.id,
        body: `【目标 #${g.id}】${g.text}`,
        score: -(2 + overlap),
        structured: "goals",
      });
    }
    for (const f of applyScopePriority(store.getFeedbackMerged(sessionId, projectKey, 20))) {
      const overlap = overlapRatio(qTokens, tokenSet(f.text));
      if (overlap < STRUCTURED_MIN_OVERLAP) {
        continue;
      }
      hits.push({
        segment_id: f.id,
        kind: f.kind === "correction" ? "教训" : "偏好",
        ts: f.updated_at ?? f.created_at,
        seq: f.id,
        body: `【${f.kind === "correction" ? "教训" : "偏好"} #${f.id}】${f.text}`,
        score: -(2 + overlap),
        structured: "feedback",
      });
    }
  } catch {
    // 结构化优先是增强层，失败降级为空
  }
  hits.sort((a, b) => a.score - b.score);
  return hits.slice(0, STRUCTURED_LIMIT);
}

function overlapRatio(queryTokens: Set<string>, textTokens: Set<string>): number {
  if (queryTokens.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const t of queryTokens) {
    if (textTokens.has(t)) {
      inter++;
    }
  }
  return inter / queryTokens.size;
}
