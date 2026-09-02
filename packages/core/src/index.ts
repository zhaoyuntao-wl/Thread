// 真实版本（2026-09-02 修复 0.0.0 硬编码）：构建/发布物读包内 package.json——MCP 握手版本可信
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

export const THREAD_VERSION = pkg.version ?? "0.0.0";
export * from "./events.js";
export * from "./state.js";
export * from "./store.js";
export * from "./assets.js";
export * from "./closing.js";
export * from "./behavior-contract.js";
export * from "./delta.js";
export * from "./nav.js";
export * from "./query-tool.js";
export * from "./light-confirm.js";
export * from "./query.js";
export * from "./evidence.js";
export * from "./metaknowledge.js";
export * from "./governor.js";
export * from "./project-key.js";
export * from "./migrate.js";
export * from "./paths.js";
export * from "./status-card.js";
export * from "./progress.js";
export * from "./feedback-guard.js";
