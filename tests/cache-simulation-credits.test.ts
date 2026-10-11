import { describe, it, expect } from "bun:test";
import { analyzeCacheEconomics, type CacheTurnRecord } from "@/cache-economics";

describe("Cache simulation credit deltas", () => {
  const t0 = 1_700_000_000_000;
  const weekMs = 7 * 86_400_000;
  const rec = (uuid: string, off: number, extra: Partial<CacheTurnRecord> = {}): CacheTurnRecord => ({
    uuid, sessionId: "s", timestampMs: t0 + off, model: "claude-sonnet-4-6",
    outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, ...extra,
  });
  const run = (mainTurns: CacheTurnRecord[], weeks = 1, subagentTurns: CacheTurnRecord[] = []) =>
    analyzeCacheEconomics({ mainTurns, subagentTurns, sinceSec: t0 / 1000, nowMs: t0 + weeks * weekMs });
  const credits = (a: ReturnType<typeof run>, id: string) =>
    a.simulations.find((s) => s.policyId === id)!.weeklySavingsCredits;

  for (const model of ["claude-sonnet-4-6", "mystery-model-x"]) {
    it(`computes 5m-tier write savings and expiry penalties from tokens (${model})`, () => {
      const a = run([
        rec("a", 0, { model, cacheWriteTokens: 100_000, cacheWrite1hTokens: 40_000 }),
        rec("b", 10 * 60_000, { model, cacheReadTokens: 10_000 }),
      ]);
      // 40,000 * (2 - 1.25) - 10,000 * (1.25 - 0.1).
      expect(credits(a, "main_5m_ttl")).toBeCloseTo(18_500, 6);
      if (model === "mystery-model-x") expect(a.costMix.totalInputCostUsd).toBe(0);
    });

    it(`subtracts compaction read/output overhead at mixed write tiers (${model})`, () => {
      const a = run([
        rec("a", 0, { model, cacheWriteTokens: 60_000 }),
        rec("b", 2 * 3_600_000, { model, cacheWriteTokens: 60_000, cacheWrite1hTokens: 30_000 }),
      ]);
      // 45,000 * ((1.25 + 2) / 2 - 0.1) - (60,000 * 0.1 + 1,000 * 5).
      expect(credits(a, "compact_before_breaks")).toBeCloseTo(57_625, 6);
    });

    it(`weights reduced auto-compact read volume directly (${model})`, () => {
      const a = run([rec("a", 0, { model, cacheReadTokens: 100_000 })]);
      // (100,000 - 70,000) * 0.4 * 0.1.
      expect(credits(a, "auto_compact_35pct")).toBeCloseTo(1_200, 6);
    });

    it(`weights a fresh session's avoided 1h rebuild directly (${model})`, () => {
      const a = run([
        rec("a", 0, { model, cacheWriteTokens: 50_000 }),
        rec("b", 25 * 3_600_000, { model, cacheWriteTokens: 50_000, cacheWrite1hTokens: 50_000 }),
      ]);
      // (50,000 - 15,000) * (2 - 0.1).
      expect(credits(a, "fresh_session_vs_stale")).toBeCloseTo(66_500, 6);
      if (model === "mystery-model-x") {
        expect(a.costMix.totalInputCostUsd).toBe(0);
        for (const s of a.simulations) expect(s.totalSavingsUsd).toBe(0);
      }
    });
  }

  it("keeps a negative 5m delta and extrapolates over the observed weeks", () => {
    const a = run([
      rec("a", 0, { cacheWriteTokens: 50_000 }),
      rec("b", 10 * 60_000, { cacheReadTokens: 50_000 }),
    ], 4);
    expect(a.windowWeeks).toBe(4);
    expect(credits(a, "main_5m_ttl")).toBeCloseTo(-57_500 / 4, 6);
  });

  it("does not convert unrelated model costs or subagent credits into policy savings", () => {
    const main = [rec("a", 0, { cacheWriteTokens: 40_000, cacheWrite1hTokens: 40_000 })];
    const subagents = [rec("sub", 0, { model: "mystery-model-x", cacheWriteTokens: 1_000_000, agentId: "agent" })];
    const mixed = [...main, rec("other", 0, { sessionId: "other", model: "claude-haiku-4-5", inputTokens: 1_000_000 })];
    expect(credits(run(main), "main_5m_ttl")).toBeCloseTo(30_000, 6);
    expect(credits(run(mixed, 1, subagents), "main_5m_ttl")).toBeCloseTo(30_000, 6);
  });

  it("does not credit compaction when its overhead exceeds the saved rebuild", () => {
    const a = run([
      rec("a", 0, { cacheWriteTokens: 21_000 }),
      rec("b", 2 * 3_600_000, { cacheWriteTokens: 21_000 }),
    ]);
    // 6,000 * 1.15 = 6,900 saved, versus 2,100 + 5,000 overhead.
    expect(credits(a, "compact_before_breaks")).toBe(0);
  });

  it("returns finite zero credit savings when there are no token deltas", () => {
    for (const mainTurns of [[], [rec("empty", 0, { model: "mystery-model-x" })]]) {
      for (const s of run(mainTurns).simulations) {
        expect(Number.isFinite(s.weeklySavingsCredits)).toBe(true);
        expect(s.weeklySavingsCredits).toBe(0);
      }
    }
  });
});
