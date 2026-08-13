import { describe, expect, it } from "vitest";
import { THREAD_VERSION } from "./index.js";

describe("core", () => {
  it("exposes a version", () => {
    expect(THREAD_VERSION).toBe("0.0.0");
  });
});
