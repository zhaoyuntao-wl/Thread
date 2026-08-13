import { readFileSync } from "node:fs";

const FALLBACK_CHARS_PER_TOKEN = 4;

export function analyzeTranscript(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const anchors = [];
  const series = [];
  let windowChars = 0;
  let turn = null;
  let sessionId = null;
  let entryCount = 0;
  let region = 0;

  const finalizeTurn = () => {
    if (!turn) return;
    series.push({
      ts: turn.ts,
      inputChars: turn.inputChars,
      outputChars: turn.outputChars,
      region,
    });
    windowChars += turn.outputChars;
    turn = null;
  };

  for (const raw of lines) {
    if (!raw.trim()) continue;
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    entryCount++;
    if (typeof e.sessionId === "string" && !sessionId) sessionId = e.sessionId;
    if (e.isSidechain) continue;
    if (e.type === "active-leaf") continue;

    if (e.type === "system" && e.subtype === "compact_boundary") {
      const m = e.compactMetadata;
      finalizeTurn();
      if (m && typeof m.preTokens === "number") {
        anchors.push({ ts: e.timestamp, windowChars, ...m });
        region = anchors.length;
      }
      windowChars = 0;
      continue;
    }

    if (e.type === "assistant" && e.message) {
      if (!turn) turn = { ts: e.timestamp, inputChars: windowChars, outputChars: 0 };
      turn.outputChars += entryChars(e);
      continue;
    }

    finalizeTurn();
    windowChars += entryChars(e);
  }
  finalizeTurn();

  const fallback = 1 / FALLBACK_CHARS_PER_TOKEN;
  const calibrations = anchors.map((a) =>
    a.windowChars > 0 ? a.preTokens / a.windowChars : fallback,
  );
  const calFor = (r) =>
    r === 0
      ? (calibrations[0] ?? fallback)
      : (calibrations[r] ?? calibrations[calibrations.length - 1] ?? fallback);

  const points = series.map((p) => {
    const cal = calFor(p.region);
    return {
      ts: p.ts,
      region: p.region,
      inputChars: p.inputChars,
      outputChars: p.outputChars,
      estInputTokens: Math.round(p.inputChars * cal),
      estOutputTokens: Math.round(p.outputChars * cal),
    };
  });
  const totalEstTokens = points.reduce((s, p) => s + p.estInputTokens + p.estOutputTokens, 0);

  return {
    path,
    sessionId,
    entryCount,
    turnCount: points.length,
    calibrations,
    anchors,
    points,
    totalEstTokens,
  };
}

function entryChars(e) {
  if (typeof e.content === "string") return e.content.length;
  if (e.message && Array.isArray(e.message.content)) {
    return e.message.content.reduce((n, b) => n + blockChars(b), 0);
  }
  return JSON.stringify(e).length;
}

function blockChars(b) {
  if (typeof b === "string") return b.length;
  if (b && typeof b === "object") {
    if (typeof b.text === "string") return b.text.length;
    if (typeof b.thinking === "string") return b.thinking.length;
    if (b.type === "tool_use") return JSON.stringify(b).length;
    if (b.type === "tool_result") return JSON.stringify(b.content ?? b).length;
    return JSON.stringify(b).length;
  }
  return 0;
}
