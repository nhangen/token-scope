import { describe, expect, it } from "bun:test";
import { computeWeeks, CREDIT_WEIGHTS, DEFAULT_WEEKLY_CAP, MIN_ELAPSED_TO_PROJECT } from "@/reports/credits";
import { parseCap } from "@/parse";
import { JsonlReader } from "@/jsonl";
import { openDb, createSqliteReader, resolveDbPath } from "@/db";
import type { CreditWeekRow } from "@/reader";

const MON = "2026-08-03";
const MON_MS = Date.parse(`${MON}T00:00:00.000Z`);

function row(over: Partial<CreditWeekRow> = {}): CreditWeekRow {
  return {
    weekStart: MON, turns: 1, subagentTurns: 0,
    inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    subagentInputTokens: 0, subagentCacheReadTokens: 0,
    subagentCacheWriteTokens: 0, subagentOutputTokens: 0,
    ...over,
  };
}

describe("credits — weighting", () => {
  it("weights each component independently", () => {
    const [w] = computeWeeks([row({
      inputTokens: 1_000, cacheWriteTokens: 1_000, cacheReadTokens: 1_000, outputTokens: 1_000,
    })], MON_MS + 8 * 86_400_000);
    // 1000*1 + 1000*1.25 + 1000*0.1 + 1000*5
    expect(w!.credits).toBeCloseTo(7_350, 6);
    expect(w!.components.cacheRead).toBeCloseTo(100, 6);
    expect(w!.components.output).toBeCloseTo(5_000, 6);
  });

  it("prices a cache read at a fiftieth of an output token", () => {
    // The whole point of the report: cache reads dominate volume but not cost,
    // so the two must not be summed as if interchangeable.
    expect(CREDIT_WEIGHTS.output / CREDIT_WEIGHTS.cacheRead).toBe(50);
  });

  it("defaults to the Max 20x weekly allowance", () => {
    expect(DEFAULT_WEEKLY_CAP).toBe(166_700_000);
  });
});

describe("credits — partial weeks and projection", () => {
  it("marks a finished week complete and does not project it", () => {
    const [w] = computeWeeks([row({ outputTokens: 100 })], MON_MS + 7 * 86_400_000);
    expect(w!.partial).toBe(false);
    expect(w!.projected).toBeNull();
    expect(w!.elapsed).toBe(1);
  });

  it("projects a half-elapsed week to double its spend so far", () => {
    const [w] = computeWeeks([row({ outputTokens: 100 })], MON_MS + 3.5 * 86_400_000);
    expect(w!.partial).toBe(true);
    expect(w!.elapsed).toBeCloseTo(0.5, 6);
    expect(w!.projected).toBeCloseTo(1_000, 6); // 100*5 spent at half-time
  });

  it("refuses to project a week that has barely started", () => {
    // Monday morning is the common case, not an edge one. Extrapolating from the
    // first hours multiplies whatever landed there by 20x or more, so the report
    // must print no forecast rather than a confident wrong one.
    const [w] = computeWeeks([row({ outputTokens: 100 })], MON_MS + 3 * 3_600_000);
    expect(w!.partial).toBe(true);
    expect(w!.elapsed).toBeLessThan(MIN_ELAPSED_TO_PROJECT);
    expect(w!.projected).toBeNull();
  });

  it("starts projecting once a fifth of the week has elapsed", () => {
    const at = MON_MS + MIN_ELAPSED_TO_PROJECT * 7 * 86_400_000;
    const [w] = computeWeeks([row({ outputTokens: 100 })], at);
    expect(w!.projected).toBeCloseTo(500 / MIN_ELAPSED_TO_PROJECT, 4);
  });

  it("never divides by zero elapsed", () => {
    const [w] = computeWeeks([row({ outputTokens: 100 })], MON_MS);
    expect(w!.elapsed).toBe(0);
    expect(w!.projected).toBeNull();
  });
});

describe("parseCap", () => {
  it("accepts plain integers and K/M/B suffixes", () => {
    expect(parseCap("166700000")).toBe(166_700_000);
    expect(parseCap("166.7M")).toBe(166_700_000);
    expect(parseCap("166.7m")).toBe(166_700_000);
    expect(parseCap(" 500k ")).toBe(500_000);
    expect(parseCap("1B")).toBe(1_000_000_000);
  });

  it("rejects anything that would silently move the line", () => {
    // A cap is the threshold every ratio in the report is judged against, so a
    // misread value is worse than an error.
    for (const bad of ["", "abc", "-5M", "0", "5MB", "1e6", "5 M M", "1,000"]) {
      expect(parseCap(bad)).toBeNull();
    }
  });
});

describe("credits — reader", () => {
  const projectsDir = process.env["TOKEN_SCOPE_PROJECTS_DIR"]!;

  it("buckets turns into Monday-start UTC weeks", () => {
    const { weeks } = new JsonlReader(projectsDir).queryCreditWeeks(0);
    expect(weeks.length).toBeGreaterThan(0);
    for (const w of weeks) {
      expect(w.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${w.weekStart}T00:00:00.000Z`).getUTCDay()).toBe(1);
    }
    // ascending, so a report can read the last entry as "current"
    const labels = weeks.map((w) => w.weekStart);
    expect([...labels].sort()).toEqual(labels);
  });

  it("includes subagent turns — they spend the same allowance", () => {
    // Every other report prunes `subagents/`; this one must not, or a
    // subagent-heavy week reads ~30% cheaper than it was.
    const spendDir = new URL("./fixtures/spend-projects", import.meta.url).pathname;
    const { weeks, subagentsIncluded } = new JsonlReader(spendDir).queryCreditWeeks(0);
    expect(subagentsIncluded).toBe(true);
    const totalSub = weeks.reduce((s, w) => s + w.subagentTurns, 0);
    expect(totalSub).toBeGreaterThan(0);
    // and they are counted in the totals, not merely tallied
    const turns = weeks.reduce((s, w) => s + w.turns, 0);
    expect(turns).toBeGreaterThan(totalSub);
  });

  it("declares subagents unavailable on the sqlite source rather than implying zero", () => {
    const db = openDb(resolveDbPath().path);
    try {
      const { subagentsIncluded } = createSqliteReader(db).queryCreditWeeks(0);
      expect(subagentsIncluded).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("credits — window truncation", () => {
  // The bug this guards: a week whose start predates --since holds only part of
  // its spend, but is calendar-complete, so it read as a whole week and was
  // averaged in. Real data showed the same week as 592.0M at --since 30d and
  // 297.6M at 21d, with nothing in the output distinguishing them.
  const afterWeek = MON_MS + 8 * 86_400_000;

  it("flags a week whose start precedes the window", () => {
    const midWeek = MON_MS + 3 * 86_400_000;
    const [w] = computeWeeks([row({ outputTokens: 100 })], afterWeek, midWeek);
    expect(w!.truncated).toBe(true);
    expect(w!.partial).toBe(false);
  });

  it("does not flag a week fully inside the window", () => {
    const [w] = computeWeeks([row({ outputTokens: 100 })], afterWeek, MON_MS);
    expect(w!.truncated).toBe(false);
  });

  it("treats sinceMs exactly at the week start as complete coverage", () => {
    const [w] = computeWeeks([row({ outputTokens: 100 })], afterWeek, MON_MS);
    expect(w!.truncated).toBe(false);
  });
});

describe("credits — subagent share", () => {
  it("sizes subagent credits, not just their turn count", () => {
    // A turn count cannot answer "what would I save by dispatching fewer?" —
    // subagent turns carry different context sizes than main-session ones.
    const [w] = computeWeeks([row({
      outputTokens: 1_000, cacheReadTokens: 10_000,
      subagentOutputTokens: 400, subagentCacheReadTokens: 8_000,
      turns: 10, subagentTurns: 4,
    })], MON_MS + 8 * 86_400_000);
    expect(w!.credits).toBeCloseTo(6_000, 6);       // 1000*5 + 10000*0.1
    expect(w!.subagentCredits).toBeCloseTo(2_800, 6); // 400*5 + 8000*0.1
    // 40% of turns but 47% of credits — the point of measuring credits
    expect(w!.subagentCredits / w!.credits).toBeGreaterThan(w!.subagentTurns / w!.turns);
  });
});
