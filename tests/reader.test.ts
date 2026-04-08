import { describe, expect, it } from "bun:test";

describe("reader module", () => {
  it("exports createReader function", async () => {
    const mod = await import("@/reader");
    expect(typeof mod.createReader).toBe("function");
  });
});
