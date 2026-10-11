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
import type { Reader } from "@/reader";
import { renderSummary } from "@/reports/summary";

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

  it("baseline is token-priced at tier-aware rates and reconciles against the reader's costUsd", () => {
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

    // u1 sonnet: 100*15 + 500*3 + 5,000*3.75 = 21,750 -> $0.02175
    // u2 sonnet: 150*15 + 200*3 + 5,000*0.30 + 400*3.75 = 5,850 -> $0.00585
    // sub1 haiku: 80*5 + 100*1 + 2,000*1.25 = 3,000 -> $0.003
    const expectedTokenPriced = 0.02175 + 0.00585 + 0.003;
    expect(baseline!.simulatedTotalCostUsd).toBeCloseTo(expectedTokenPriced, 8);
    expect(analysis.reconciliation.readerCostUsd).toBeCloseTo(0.08, 8);
    expect(analysis.reconciliation.tokenPricedCostUsd).toBeCloseTo(expectedTokenPriced, 8);
    expect(analysis.reconciliation.deltaUsd).toBeCloseTo(0.08 - expectedTokenPriced, 8);
  });

  it("reconciliation surfaces the gap when the reader priced 1h writes at the 5m rate", () => {
    const a = analyzeCacheEconomics({
      mainTurns: [{
        uuid: "u1", sessionId: "s1", timestampMs: 1_000, model: "claude-sonnet-4-6", outputTokens: 0,
        inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000, costUsd: 3.75,
      }],
      sinceSec: 0,
      nowMs: 86_400_000,
    });
    expect(a.reconciliation.tokenPricedCostUsd).toBeCloseTo(6.0, 8);
    expect(a.reconciliation.deltaUsd).toBeCloseTo(3.75 - 6.0, 8);
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

describe("Cache Economics — TTL tier pricing", () => {
  // claude-sonnet-4-6: input $3.00/M, 5m write $3.75/M (1.25x), 1h write $6.00/M (2.0x), read $0.30/M.
  const t0 = 1_700_000_000_000;
  const base = { sessionId: "s1", model: "claude-sonnet-4-6", outputTokens: 10, inputTokens: 0, cacheReadTokens: 0, costUsd: null };

  it("prices 1h-tier writes at 2.0x input in the cost mix", () => {
    const a = analyzeCacheEconomics({
      mainTurns: [
        { ...base, uuid: "a", timestampMs: t0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 },
        { ...base, uuid: "b", timestampMs: t0 + 1000, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 0 },
      ],
      sinceSec: 0,
      nowMs: t0 + 7 * 86_400_000,
    });
    expect(a.costMix.cacheWriteCostUsd).toBeCloseTo(6.0 + 3.75, 6);
  });

  it("5m-TTL sim credits write savings only on writes actually billed at the 1h tier", () => {
    const a = analyzeCacheEconomics({
      mainTurns: [
        { ...base, uuid: "a", timestampMs: t0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 0 },
        { ...base, uuid: "b", timestampMs: t0 + 1000, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 0 },
      ],
      sinceSec: 0,
      nowMs: t0 + 7 * 86_400_000,
    });
    const sim = a.simulations.find((s) => s.policyId === "main_5m_ttl")!;
    expect(sim.totalSavingsUsd).toBe(0);

    const b = analyzeCacheEconomics({
      mainTurns: [
        { ...base, uuid: "a", timestampMs: t0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 },
      ],
      sinceSec: 0,
      nowMs: t0 + 7 * 86_400_000,
    });
    // (6.00 - 3.75) per M on 1M tokens
    expect(b.simulations.find((s) => s.policyId === "main_5m_ttl")!.totalSavingsUsd).toBeCloseTo(2.25, 6);
  });

  it("prices a 1h-tier expiry rebuild at the 1h write rate", () => {
    const prev: CacheTurnRecord = { ...base, uuid: "a", timestampMs: t0, cacheWriteTokens: 10_000, cacheWrite1hTokens: 10_000 };
    const curr: CacheTurnRecord = { ...base, uuid: "b", timestampMs: t0 + 2 * MAIN_TTL_MS, cacheWriteTokens: 10_000, cacheWrite1hTokens: 10_000 };
    const c = classifyTurn(prev, curr, false, 2);
    expect(c.type).toBe("expiry");
    // 10,000 * (6.00 - 0.30) / 1M
    expect(c.extraCostUsd).toBeCloseTo(0.057, 6);
  });

  it("JSONL reader carries the 1h write split from usage.cache_creation", () => {
    const reader = createReader({ source: "jsonl", projectsDirs: [new URL("./fixtures/cache-tier-projects", import.meta.url).pathname] });
    const { mainTurns } = reader.queryCacheTurns(0);
    reader.close();
    expect(mainTurns.map((t) => t.cacheWrite1hTokens).sort()).toEqual([0, 4000]);
  });
});

describe("Cache Economics — subagent streams", () => {
  const t0 = 1_700_000_000_000;
  const sub = (uuid: string, agentId: string, offsetMs: number): CacheTurnRecord => ({
    uuid, sessionId: "parent", agentId, timestampMs: t0 + offsetMs, model: "claude-haiku-4-5",
    outputTokens: 50, inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 3_000, costUsd: null, isSubagent: true,
  });

  it("treats each subagent's first turn as a cold start, not an expiry of a sibling", () => {
    const a = analyzeCacheEconomics({
      mainTurns: [],
      subagentTurns: [sub("a1", "alpha", 0), sub("b1", "beta", 10 * 60 * 1000)],
      sinceSec: 0,
      nowMs: t0 + 86_400_000,
    });
    expect(a.subagentMisses.coldStarts).toBe(2);
    expect(a.subagentMisses.expiries).toBe(0);
  });

  it("JSONL reader tags subagent turns with their agentId", () => {
    const reader = createReader({ source: "jsonl", projectsDirs: [new URL("./fixtures/cache-tier-projects", import.meta.url).pathname] });
    const { subagentTurns } = reader.queryCacheTurns(0);
    reader.close();
    expect(subagentTurns.map((t) => t.agentId).sort()).toEqual(["alpha", "beta"]);
  });
});

function stubReader(mainTurns: CacheTurnRecord[], subagentTurns: CacheTurnRecord[] = [], extra: Record<string, unknown> = {}): Reader {
  return {
    queryCacheStats: () => [],
    queryCacheTurns: () => ({ mainTurns, subagentTurns, subagentsSupported: true, ...extra }),
  } as unknown as Reader;
}

describe("Cache Economics — invalidation cost", () => {
  // claude-sonnet-4-6 5m write $3.75/M, read $0.30/M. Rebuild 40,000 tokens -> 40,000 * 3.45 / 1M = $0.138.
  const t0 = 1_700_000_000_000;
  const turn = (uuid: string, off: number, read: number, write: number, sessionId = "s1", isSubagent = false, agentId?: string): CacheTurnRecord => ({
    uuid, sessionId, agentId, timestampMs: t0 + off, model: "claude-sonnet-4-6", outputTokens: 10,
    inputTokens: 0, cacheReadTokens: read, cacheWriteTokens: write, costUsd: null, isSubagent,
  });

  it("totals invalidation rebuild cost for main and subagent loops", () => {
    const a = analyzeCacheEconomics({
      mainTurns: [turn("m1", 0, 0, 50_000), turn("m2", 20_000, 0, 40_000)],
      subagentTurns: [turn("s1", 0, 0, 50_000, "p", true, "x"), turn("s2", 20_000, 0, 40_000, "p", true, "x")],
      sinceSec: 0,
      nowMs: t0 + 86_400_000,
    });
    expect(a.misses.totalInvalidationExtraCostUsd).toBeCloseTo(0.138, 6);
    expect(a.subagentMisses.totalInvalidationExtraCostUsd).toBeCloseTo(0.138, 6);
  });

  it("renders the invalidation cost and a subagent invalidation row instead of a literal zero", () => {
    const out = capture(() =>
      renderCacheReport(stubReader([turn("m1", 0, 0, 50_000), turn("m2", 20_000, 0, 40_000)], [turn("s1", 0, 0, 50_000, "p", true, "x"), turn("s2", 20_000, 0, 40_000, "p", true, "x")]), {
        since: 0, sinceStr: "30d", limit: 10, json: false, focus: "misses",
      })
    );
    const mainInval = out.split("\n").find((l) => l.includes("Main session") && l.includes("Invalidation"))!;
    const subInval = out.split("\n").find((l) => l.includes("Subagents") && l.includes("Invalidation"));
    expect(mainInval).toContain("$0.1380");
    expect(subInval).toBeDefined();
    expect(subInval!).toContain("$0.1380");
  });
});

describe("Corrected hit rate at user-visible sites", () => {
  // Totals hand-summed from the raw fixture usage blocks.
  it("JSONL queryCacheStats: beacon = 165,000 / (165,000 + 1,100 + 30,602)", () => {
    const reader = createReader({ source: "jsonl" });
    const row = reader.queryCacheStats(0, 50).find((r) => r.cwd === "/Users/alice/projects/beacon")!;
    reader.close();
    expect(row.cacheHitPct!).toBeCloseTo((165_000 / 196_702) * 100, 6);
    expect(row.readSharePct!).toBeCloseTo((165_000 / 195_602) * 100, 6);
  });

  it("SQLite queryCacheStats: widget-app = 242,500 / (242,500 + 33,300 + 46)", () => {
    const reader = createReader({ source: "sqlite" });
    const row = reader.queryCacheStats(0, 50).find((r) => r.cwd === "/Users/alice/projects/widget-app")!;
    reader.close();
    expect(row.cacheHitPct!).toBeCloseTo((242_500 / 275_846) * 100, 6);
    expect(row.readSharePct!).toBeCloseTo((242_500 / 242_546) * 100, 6);
  });

  it("summary renders the corrected Cache Hit Rate and the legacy Read Share", () => {
    const reader = createReader({ source: "jsonl" });
    const out = capture(() => renderSummary(reader, { since: 0, limit: 10, json: false }));
    reader.close();
    // read 604,000; write 4,900; input 30,641 across the JSONL fixture.
    const hit = out.split("\n").find((l) => l.includes("Cache Hit Rate"))!;
    const share = out.split("\n").find((l) => l.includes("Read Share (non-write)"))!;
    expect(hit).toContain(`${((604_000 / 639_541) * 100).toFixed(1)}%`);
    expect(share).toContain(`${((604_000 / 634_641) * 100).toFixed(1)}%`);
  });
});

describe("Cache Economics — subagent visibility by source", () => {
  it("SQLite declares subagents unsupported and the JSONL reader declares them supported", () => {
    const sqlite = createReader({ source: "sqlite" });
    const jsonl = createReader({ source: "jsonl" });
    expect(sqlite.queryCacheTurns(0).subagentsSupported).toBe(false);
    expect(jsonl.queryCacheTurns(0).subagentsSupported).toBe(true);
    sqlite.close();
    jsonl.close();
  });

  it("renders subagent rows as n/a, and flags JSON, when the source cannot see subagents", () => {
    const reader = createReader({ source: "sqlite" });
    const text = capture(() => renderCacheReport(reader, { since: 0, sinceStr: "30d", limit: 10, json: false, focus: "misses" }));
    const json = JSON.parse(capture(() => renderCacheReport(reader, { since: 0, sinceStr: "30d", limit: 10, json: true })));
    reader.close();
    const subRows = text.split("\n").filter((l) => l.includes("Subagents"));
    expect(subRows.length).toBeGreaterThan(0);
    for (const row of subRows) expect(row).toContain("n/a");
    expect(json.summary.subagents_supported).toBe(false);
  });
});

describe("Cache Economics — 5m TTL sim sign", () => {
  const t0 = 1_700_000_000_000;
  const turns: CacheTurnRecord[] = [
    { uuid: "a", sessionId: "s1", timestampMs: t0, model: "claude-sonnet-4-6", outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
    // Read survived a 10-minute gap, so under a 5m TTL it would have been a rebuild: 1M * (3.75 - 0.30) = $3.45.
    { uuid: "b", sessionId: "s1", timestampMs: t0 + 10 * 60 * 1000, model: "claude-sonnet-4-6", outputTokens: 0, inputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, costUsd: null },
  ];

  it("reports a cost increase as negative savings under a fixed counterfactual title, ranked last", () => {
    const a = analyzeCacheEconomics({ mainTurns: turns, sinceSec: 0, nowMs: t0 + 7 * 86_400_000 });
    const sim = a.simulations.find((s) => s.policyId === "main_5m_ttl")!;
    const baseline = a.simulations.find((s) => s.policyId === "actual_baseline")!;
    expect(sim.title).toBe("Switch main session to 5m TTL");
    expect(sim.totalSavingsUsd).toBeCloseTo(-3.45, 6);
    expect(sim.simulatedTotalCostUsd).toBeCloseTo(baseline.simulatedTotalCostUsd + 3.45, 6);
    expect(a.simulations.at(-1)!.policyId).toBe("main_5m_ttl");
  });

  it("renders a negative saving as an added weekly cost", () => {
    const out = capture(() => renderCacheReport(stubReader(turns), { since: 0, sinceStr: "7d", limit: 10, json: false, focus: "sim" }));
    const row = out.split("\n").find((l) => l.includes("Switch main session to 5m TTL") && l.includes("/wk"))!;
    expect(row).toContain("+$");
    expect(row).toContain("cost");
  });
});
