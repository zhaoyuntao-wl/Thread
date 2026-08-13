import { ThreadStore, applyAnalysis } from "@thread/core";
import { defaultDbPath, extractLastAssistantTurn, parseHookEvent } from "@thread/adapter-qoder-cli";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const dbPath = defaultDbPath(import.meta.url);

let raw;
try {
  raw = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}
let hookEvent;
try {
  hookEvent = JSON.parse(raw);
} catch {
  process.exit(0);
}

const event = parseHookEvent(hookEvent);
if (!event) {
  process.exit(0);
}

if (event.kind === "assistant_message" && event.meta?.assistant_text_pending) {
  const transcriptPath =
    typeof event.meta.transcript_path === "string" ? event.meta.transcript_path : undefined;
  const turn = extractLastAssistantTurn(transcriptPath);
  if (!turn) {
    process.exit(0);
  }
  event.body = turn.text;
  event.meta = { ...event.meta, assistant_uuid: turn.uuid, assistant_text_pending: false };
}

mkdirSync(dirname(dbPath), { recursive: true });
const store = new ThreadStore({ path: dbPath });
try {
  const uuid = event.meta?.assistant_uuid;
  if (event.kind === "assistant_message" && uuid && store.hasAssistantTurn(event.session_id, uuid)) {
    process.exit(0);
  }
  const appended = store.append(event);
  try {
    if (event.kind === "user_message") {
      applyAnalysis(store, event.session_id, { user_msg: event.body }, { sourceEvent: appended.id, ts: event.ts });
    } else if (event.kind === "assistant_message") {
      applyAnalysis(store, event.session_id, { assistant_msg: event.body }, { sourceEvent: appended.id, ts: event.ts });
    }
  } catch (err) {
    console.error(`thread capture: analysis failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} finally {
  store.close();
}
