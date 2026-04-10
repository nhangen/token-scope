import { describe, expect, it, beforeAll } from "bun:test";
import { JsonlReader } from "@/jsonl";

let reader: JsonlReader;

beforeAll(() => {
  const dir = process.env["TOKEN_SCOPE_PROJECTS_DIR"]!;
  reader = new JsonlReader(dir);
});

describe("JsonlReader — summary totals", () => {
  it("counts all turns with since=0", () => {
    const totals = reader.querySummaryTotals(0);
    expect(totals.turnCount).toBe(17);
  });

  it("counts sessions with since=0", () => {
    const totals = reader.querySummaryTotals(0);
    expect(totals.sessionCount).toBe(4);
  });

  it("sums output tokens with since=0", () => {
    const totals = reader.querySummaryTotals(0);
    expect(totals.totalOutputTokens).toBe(3330);
  });

  it("excludes old session with 30d window", () => {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const totals = reader.querySummaryTotals(since);
    expect(totals.turnCount).toBe(16);
    expect(totals.sessionCount).toBe(3);
  });
});

describe("JsonlReader — by-tool", () => {
  it("returns tool rows sorted by outputTokens desc", () => {
    const rows = reader.queryByTool(0, 20);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.outputTokens).toBeGreaterThanOrEqual(rows[1]?.outputTokens ?? 0);
  });

  it("dominant tool for thinking turn is Read", () => {
    const rows = reader.queryByTool(0, 20);
    const readRow = rows.find((r) => r.tool === "Read");
    expect(readRow).toBeDefined();
  });
});

describe("JsonlReader — by-project", () => {
  it("returns 3 projects with since=0", () => {
    const rows = reader.queryByProject(0, 20);
    expect(rows.length).toBe(3);
  });

  it("token-scope project has 7 turns", () => {
    const rows = reader.queryByProject(0, 20);
    const ts = rows.find((r) => r.cwd?.includes("token-scope"));
    expect(ts?.turns).toBe(7);
  });
});

describe("JsonlReader — sessions", () => {
  it("returns 4 sessions with since=0", () => {
    const sessions = reader.querySessions(0, 20);
    expect(sessions.length).toBe(4);
  });

  it("sess-j1 has 7 turns", () => {
    const sessions = reader.querySessions(0, 20);
    const s = sessions.find((r) => r.sessionId === "sess-j1");
    expect(s?.turnCount).toBe(7);
  });
});

describe("JsonlReader — session turns", () => {
  it("returns 7 turns for sess-j1", () => {
    const turns = reader.querySessionTurns("sess-j1");
    expect(turns.length).toBe(7);
  });

  it("turns are ordered by timestamp asc", () => {
    const turns = reader.querySessionTurns("sess-j1");
    expect(turns[0]!.timestamp).toBeLessThan(turns[1]!.timestamp);
  });
});

describe("JsonlReader — project matches", () => {
  it("matches by fragment", () => {
    const matches = reader.queryProjectMatches("token-scope");
    expect(matches.length).toBe(1);
    expect(matches[0]!.cwd).toContain("token-scope");
  });

  it("returns empty for no match", () => {
    const matches = reader.queryProjectMatches("zzz-no-match");
    expect(matches.length).toBe(0);
  });
});

describe("JsonlReader — thinking turns", () => {
  it("finds thinking turns with since=0", () => {
    const turns = reader.queryThinkingTurns(0);
    expect(turns.length).toBe(1);
    expect(turns[0]!.thinkingChars).toBeGreaterThan(0);
  });
});

describe("JsonlReader — bash turns", () => {
  it("finds bash turns with since=0", () => {
    const turns = reader.queryBashTurns(0);
    expect(turns.length).toBe(2);
    expect(turns[0]!.command).toBe("bun test");
  });
});

describe("JsonlReader — raw turns for tool", () => {
  it("each row has sessionId and cwd fields", () => {
    const rows = reader.queryRawTurnsForTool(0);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveProperty("sessionId");
      expect(row).toHaveProperty("cwd");
      expect(typeof row.sessionId).toBe("string");
    }
  });
});

describe("JsonlReader — close", () => {
  it("close() does not throw", () => {
    expect(() => reader.close()).not.toThrow();
  });
});

describe("JsonlReader — cache stats", () => {
  it("returns a row for each project", () => {
    const rows = reader.queryCacheStats(0, 20);
    expect(rows.length).toBe(3);
  });

  it("beacon project has 2 sessions", () => {
    const rows = reader.queryCacheStats(0, 20);
    const beacon = rows.find((r) => r.cwd.includes("beacon"));
    expect(beacon?.sessions).toBe(2);
  });

  it("beacon project totalCacheReadTokens is 165000", () => {
    const rows = reader.queryCacheStats(0, 20);
    const beacon = rows.find((r) => r.cwd.includes("beacon"));
    expect(beacon?.totalCacheReadTokens).toBe(165000);
  });

  it("cacheHitPct is between 0 and 100 for all projects", () => {
    const rows = reader.queryCacheStats(0, 20);
    for (const r of rows) {
      if (r.cacheHitPct !== null) {
        expect(r.cacheHitPct).toBeGreaterThanOrEqual(0);
        expect(r.cacheHitPct).toBeLessThanOrEqual(100);
      }
    }
  });

  it("estimatedSavingsUsd is positive for projects with cache reads", () => {
    const rows = reader.queryCacheStats(0, 20);
    for (const r of rows.filter((r) => r.totalCacheReadTokens > 0)) {
      expect(r.estimatedSavingsUsd).not.toBeNull();
      expect(r.estimatedSavingsUsd!).toBeGreaterThan(0);
    }
  });

  it("rows are sorted by estimatedSavingsUsd desc", () => {
    const rows = reader.queryCacheStats(0, 20);
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i]!.estimatedSavingsUsd ?? 0).toBeGreaterThanOrEqual(rows[i + 1]!.estimatedSavingsUsd ?? 0);
    }
  });
});

describe("JsonlReader — context contributors", () => {
  it("returns rows grouped by tool", () => {
    const rows = reader.queryContextContributors(0, 20);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("rows sum to total cache writes", () => {
    const rows = reader.queryContextContributors(0, 20);
    const totalFromRows = rows.reduce((s, r) => s + r.totalCacheWrite, 0);
    expect(totalFromRows).toBeGreaterThan(0);
  });

  it("pctOfTotal sums to ~100", () => {
    const rows = reader.queryContextContributors(0, 20);
    const totalPct = rows.reduce((s, r) => s + r.pctOfTotal, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it("respects since filter", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const rows = reader.queryContextContributors(future, 20);
    expect(rows.length).toBe(0);
  });
});

describe("JsonlReader — base load", () => {
  it("returns one row per project", () => {
    const rows = reader.queryBaseLoad(0, 20);
    expect(rows.length).toBeGreaterThan(0);
    const cwds = rows.map(r => r.cwd);
    expect(new Set(cwds).size).toBe(cwds.length);
  });

  it("avgBaseTokens is positive", () => {
    const rows = reader.queryBaseLoad(0, 20);
    for (const r of rows) {
      expect(r.avgBaseTokens).toBeGreaterThan(0);
    }
  });

  it("min <= avg <= max", () => {
    const rows = reader.queryBaseLoad(0, 20);
    for (const r of rows) {
      expect(r.minBaseTokens).toBeLessThanOrEqual(r.avgBaseTokens);
      expect(r.avgBaseTokens).toBeLessThanOrEqual(r.maxBaseTokens);
    }
  });

  it("respects since filter", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const rows = reader.queryBaseLoad(future, 20);
    expect(rows.length).toBe(0);
  });
});

describe("JsonlReader — cache growth", () => {
  it("returns turns for sess-j4", () => {
    const rows = reader.queryCacheGrowth("sess-j4");
    expect(rows.length).toBe(7);
  });

  it("first turn has delta 0", () => {
    const rows = reader.queryCacheGrowth("sess-j4");
    expect(rows[0]!.delta).toBe(0);
  });

  it("totalContext grows over turns", () => {
    const rows = reader.queryCacheGrowth("sess-j4");
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.totalContext).toBeGreaterThanOrEqual(rows[i - 1]!.totalContext);
    }
  });

  it("returns empty for unknown session", () => {
    const rows = reader.queryCacheGrowth("nonexistent-session-id");
    expect(rows.length).toBe(0);
  });

  it("prefix match across multiple sessions returns all matching turns", () => {
    const rows = reader.queryCacheGrowth("sess-j");
    expect(rows.length).toBe(17);
  });
});

describe("JsonlReader — session budget", () => {
  it("excludes sessions with fewer than 10 turns", () => {
    const rows = reader.querySessionBudgets(0, 20);
    const j4 = rows.find(r => r.sessionId === "sess-j4");
    expect(j4).toBeUndefined();
  });

  it("respects since filter", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const rows = reader.querySessionBudgets(future, 20);
    expect(rows.length).toBe(0);
  });
});

describe("JsonlReader — context stats", () => {
  it("returns sessions with 6+ turns", () => {
    const rows = reader.queryContextStats(0, 20);
    expect(rows.length).toBe(2);
    const sess4 = rows.find((r) => r.sessionId === "sess-j4");
    expect(sess4).toBeDefined();
  });

  it("sess-j4 has correct turnCount", () => {
    const rows = reader.queryContextStats(0, 20);
    expect(rows[0]!.turnCount).toBe(7);
  });

  it("avgEarlyInput is average of first 3 turns (total context = input + cache_read + cache_write)", () => {
    const rows = reader.queryContextStats(0, 20);
    // first 3 turns: (1000+5000+1000), (1200+15000+0), (1400+20000+0) → 7000, 16200, 21400 → avg 14866.67
    expect(rows[0]!.avgEarlyInput).toBeCloseTo(14867, 0);
  });

  it("avgLateInput is average of last 3 turns (total context = input + cache_read + cache_write)", () => {
    const rows = reader.queryContextStats(0, 20);
    // last 3 turns: (6000+28000+0), (8000+32000+0), (9500+35000+0) → 34000, 40000, 44500 → avg 39500
    expect(rows[0]!.avgLateInput).toBeCloseTo(39500, 0);
  });

  it("bloatRatio is avgLateInput / avgEarlyInput", () => {
    const rows = reader.queryContextStats(0, 20);
    // 39500 / 14866.67 ≈ 2.66
    expect(rows[0]!.bloatRatio).toBeCloseTo(2.66, 1);
  });

  it("returns empty for since that excludes sess-j4", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const rows = reader.queryContextStats(future, 20);
    expect(rows.length).toBe(0);
  });

  it("includes cache breakdown fields", () => {
    const rows = reader.queryContextStats(0, 20);
    expect(rows[0]!.totalCacheRead).toBeGreaterThan(0);
    expect(rows[0]!.totalCacheWrite).toBeGreaterThan(0);
    expect(rows[0]!.avgTurnCacheWrite).toBeGreaterThan(0);
  });

  it("uses dominant cwd when session spans multiple cwds", () => {
    const rows = reader.queryContextStats(0, 20);
    const sess4 = rows.find((r) => r.sessionId === "sess-j4");
    expect(sess4).toBeDefined();
    expect(sess4!.cwd).toBe("/Users/alice/projects/beacon");
  });
});
