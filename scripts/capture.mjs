import { ThreadStore } from "@thread/core";
import { parseHookEvent } from "@thread/adapter-qoder-cli";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dbPath = process.env.THREAD_DB ?? join(root, ".thread", "sms.db");

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

mkdirSync(dirname(dbPath), { recursive: true });
const store = new ThreadStore({ path: dbPath });
try {
  store.append(event);
} finally {
  store.close();
}
