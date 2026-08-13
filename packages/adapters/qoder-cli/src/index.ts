import { THREAD_VERSION } from "@thread/core";

export const adapterName = "qoder-cli";

export function adapterInfo(): string {
  return `${adapterName} adapter, thread core v${THREAD_VERSION}`;
}

export * from "./ingest.js";
