import { describe, it, expect } from "bun:test";
import {
  classifyTurn,
  analyzeCacheEconomics,
  computeGapHistogram,
  MAIN_TTL_MS,
  SUBAGENT_TTL_MS,
  type CacheTurnRecord,
} from "@/cache-economics";
import { createReader } from "@/reader";
import { renderCacheReport } from "@/reports/cache";

function capture(fn: () => void): string {
  const oldLog = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.log = oldLog;
  }
  return out;
}

describe("Cache Economics — Acceptance Criteria", () => {
  it("classifies >1h gap followed by large write as expiry, with hand-computed extra cost", () => {
    // Hand computation:
    // Model: claude-sonnet-4-6
    // Rates: input $3.00/M, cacheWrite $3.75/M, cacheRead $0.30/M
    // Difference between write and read = $3.75 - $0.30 = $3.45 / M tokens.
    // Turn 1 at T0: input 100, read 0, write 10,000 -> prevContext = 10,100
    // Turn 2 at T0 + 75 minutes (4,500,000 ms > 3,600,000 ms TTL):
    // Turn 2: input 200, read 0, write 12,000
    // Rebuilt prefix = min(prevContext=10,100, write=12,000) = 10,100 tokens.
    // Hand-computed extra cost = 10,100 * (3.75 - 0.30) / 1,000,000 = 10,100 * 3.45 / 1,000,000 = 0.034845 USD.
    const t0 = 1_700_000_000_000;
    const turn1: CacheTurnRecord = {
      uuid: "u1",
      sessionId: "s1",
      timestampMs: t0,
      model: "claude-sonnet-4-6",
      outputTokens: 50,
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 10_000,
      costUsd: null,
    };

    const turn2: CacheTurnRecord = {
      uuid: "u2",
      sessionId: "s1",
      timestampMs: t0 + 75 * 60 * 1000, // 75 minute gap > 1h TTL
      model: "claude-sonnet-4-6",
      outputTokens: 80,
      inputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 12_000,
      costUsd: null,
    };

    const classification = classifyTurn(turn1, turn2, false, 2);

    expect(classification.type).toBe("expiry");
    expect(classification.gapMs).toBe(75 * 60 * 1000);
    expect(classification.rebuildPrefixTokens).toBe(10_100);

    // Hand-computed expected extra cost:
    const expectedHandCost = (10_100 * (3.75 - 0.30)) / 1_000_000;
    expect(expectedHandCost).toBe(0.034845);
    expect(classification.extraCostUsd).toBeCloseTo(expectedHandCost, 6);
  });

  it("corrected hit rate is strictly lower than old formula on a fixture containing writes", () => {
    const turns: CacheTurnRecord[] = [
      {
        uuid: "u1",
        sessionId: "s1",
        timestampMs: 1_000,
        model: "claude-sonnet-4-6",
        outputTokens: 50,
        inputTokens: 1_000,
        cacheReadTokens: 9_000,
        cacheWriteTokens: 2_000,
        costUsd: null,
      },
    ];

    const analysis = analyzeCacheEconomics({
      mainTurns: turns,
      sinceSec: 0,
    });

    // Old formula: 9,000 / (9,000 + 1,000) = 90.0%
    // Corrected formula: 9,000 / (9,000 + 2,000 + 1,000) = 9,000 / 12,000 = 75.0%
    expect(analysis.legacyHitPct).toBeCloseTo(90.0, 1);
    expect(analysis.correctedHitPct).toBeCloseTo(75.0, 1);
    expect(analysis.correctedHitPct!).toBeLessThan(analysis.legacyHitPct!);
  });

  it("simulation totals reconcile with actual totals when simulated policy equals actual policy", () => {
    const t0 = 1_700_000_000_000;
    const mainTurns: CacheTurnRecord[] = [
      {
        uuid: "u1",
        sessionId: "s1",
        timestampMs: t0,
        model: "claude-sonnet-4-6",
        outputTokens: 100,
        inputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 5_000,
        costUsd: 0.05,
      },
      {
        uuid: "u2",
        sessionId: "s1",
        timestampMs: t0 + 60_000,
        model: "claude-sonnet-4-6",
        outputTokens: 150,
        inputTokens: 200,
        cacheReadTokens: 5_000,
        cacheWriteTokens: 400,
        costUsd: 0.02,
      },
    ];

    const subTurns: CacheTurnRecord[] = [
      {
        uuid: "sub1",
        sessionId: "s1",
        timestampMs: t0 + 120_000,
        model: "claude-haiku-4-5",
        outputTokens: 80,
        inputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 2_000,
        costUsd: 0.01,
      },
    ];

    const analysis = analyzeCacheEconomics({
      mainTurns,
      subagentTurns: subTurns,
      sinceSec: 0,
      nowMs: t0 + 86_400_000,
    });

    const baseline = analysis.simulations.find((s) => s.policyId === "actual_baseline");
    expect(baseline).toBeDefined();

    const expectedTotalActual = 0.05 + 0.02 + 0.01;
    expect(baseline!.simulatedTotalCostUsd).toBeCloseTo(expectedTotalActual, 4);
    expect(baseline!.totalSavingsUsd).toBe(0);
    expect(baseline!.weeklySavingsUsd).toBe(0);
  });
});

describe("Cache Economics — Miss Classification Mechanics", () => {
  it("classifies first turn as cold initial", () => {
    const turn: CacheTurnRecord = {
      uuid: "u1",
      sessionId: "s1",
      timestampMs: 1_000,
      model: "claude-sonnet-4-6",
      outputTokens: 50,
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 5_000,
      costUsd: null,
    };
    const c = classifyTurn(null, turn, false, 1);
    expect(c.type).toBe("cold");
    expect(c.extraCostUsd).toBe(0);
  });

  it("classifies incremental turn with small gap as growth", () => {
    const t0 = 1_000;
    const prev: CacheTurnRecord = {
      uuid: "u1",
      sessionId: "s1",
      timestampMs: t0,
      model: "claude-sonnet-4-6",
      outputTokens: 50,
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 5_000,
      costUsd: null,
    };
    const curr: CacheTurnRecord = {
      uuid: "u2",
      sessionId: "s1",
      timestampMs: t0 + 30_000, // 30 sec gap
      model: "claude-sonnet-4-6",
      outputTokens: 50,
      inputTokens: 50,
      cacheReadTokens: 5_000, // previous context hit
      cacheWriteTokens: 300,  // incremental growth
      costUsd: null,
    };
    const c = classifyTurn(prev, curr, false, 2);
    expect(c.type).toBe("growth");
    expect(c.extraCostUsd).toBe(0);
  });

  it("classifies turn with small gap but dropped prefix as invalidation", () => {
    const t0 = 1_000;
    const prev: CacheTurnRecord = {
      uuid: "u1",
      sessionId: "s1",
      timestampMs: t0,
      model: "claude-sonnet-4-6",
      outputTokens: 50,
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 50_000,
      costUsd: null,
    };
    // Context compacted or tool altered: gap is 20s, but read is 0 and write is 40k
    const curr: CacheTurnRecord = {
      uuid: "u2",
      sessionId: "s1",
      timestampMs: t0 + 20_000,
      model: "claude-sonnet-4-6",
      outputTokens: 50,
      inputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 40_000,
      costUsd: null,
    };
    const c = classifyTurn(prev, curr, false, 2);
    expect(c.type).toBe("invalidation");
    expect(c.rebuildPrefixTokens).toBe(40_000);
    expect(c.extraCostUsd).toBeGreaterThan(0);
  });

  it("uses 5m TTL for subagents", () => {
    const t0 = 1_000;
    const prev: CacheTurnRecord = {
      uuid: "sub1",
      sessionId: "s1",
      timestampMs: t0,
      model: "claude-haiku-4-5",
      outputTokens: 50,
      inputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 3_000,
      costUsd: null,
    };
    // 6 minute gap > 5m TTL
    const curr: CacheTurnRecord = {
      uuid: "sub2",
      sessionId: "s1",
      timestampMs: t0 + 6 * 60 * 1000,
      model: "claude-haiku-4-5",
      outputTokens: 50,
      inputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 3_500,
      costUsd: null,
    };
    const c = classifyTurn(prev, curr, true, 2);
    expect(c.type).toBe("expiry");
    expect(c.isSubagent).toBe(true);
  });
});

describe("Cache Economics — Gap Histogram", () => {
  it("categorizes gaps into appropriate buckets with TTL boundaries", () => {
    const gapsSec = [
      30,          // < 1m
      45,          // < 1m
      120,         // 1m - 5m
      600,         // 5m - 15m
      1200,        // 15m - 30m
      2400,        // 30m - 60m
      5000,        // 1h - 2h
      10000,       // 2h - 4h
      20000,       // > 4h
    ];
    const { totalGaps, buckets } = computeGapHistogram(gapsSec);
    expect(totalGaps).toBe(9);

    const b0 = buckets.find((b) => b.label === "< 1m");
    expect(b0?.count).toBe(2);

    const b1 = buckets.find((b) => b.label === "1m – 5m");
    expect(b1?.count).toBe(1);

    const b2 = buckets.find((b) => b.label === "5m – 15m");
    expect(b2?.count).toBe(1);

    const bOver4h = buckets.find((b) => b.label === "> 4h");
    expect(bOver4h?.count).toBe(1);
  });
});

describe("Cache Economics Report — CLI & Formatting Integration", () => {
  it("renders text report with sections, gap histogram and simulations", () => {
    const reader = createReader({ source: "jsonl" });
    const output = capture(() => {
      renderCacheReport(reader, {
        since: 0,
        sinceStr: "30d",
        limit: 10,
        json: false,
      });
    });
    reader.close();

    expect(output).toContain("token-scope — Cache Economics & Efficiency");
    expect(output).toContain("Overall Cache Hit %");
    expect(output).toContain("Read Share (non-write)");
    expect(output).toContain("Input Token & Cost Mix");
    expect(output).toContain("Miss Classification & Extra Rebuild Costs");
    expect(output).toContain("Request Gap Distribution");
    expect(output).toContain("What Would Have Saved (Simulations)");
  });

  it("renders JSON report with full economics structure and backward compatible rows", () => {
    const reader = createReader({ source: "jsonl" });
    const output = capture(() => {
      renderCacheReport(reader, {
        since: 0,
        sinceStr: "30d",
        limit: 10,
        json: true,
      });
    });
    reader.close();

    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("cache");
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(parsed).toHaveProperty("token_mix");
    expect(parsed).toHaveProperty("cost_mix");
    expect(parsed).toHaveProperty("misses");
    expect(parsed).toHaveProperty("gap_histogram");
    expect(parsed).toHaveProperty("simulations");
  });

  it("supports focus mode for misses and simulations", () => {
    const reader = createReader({ source: "jsonl" });
    const missOutput = capture(() => {
      renderCacheReport(reader, {
        since: 0,
        sinceStr: "30d",
        limit: 10,
        json: false,
        focus: "misses",
      });
    });
    const simOutput = capture(() => {
      renderCacheReport(reader, {
        since: 0,
        sinceStr: "30d",
        limit: 10,
        json: false,
        focus: "sim",
      });
    });
    reader.close();

    expect(missOutput).toContain("Miss Classification");
    expect(simOutput).toContain("Cache Savings Simulations");
  });
});
