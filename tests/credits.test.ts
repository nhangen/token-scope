import { describe, expect, it } from "bun:test";
import { computeWeeks, computeWindows, computeWindowsChecked, WINDOW_MS, CREDIT_WEIGHTS, DEFAULT_WEEKLY_CAP, MIN_ELAPSED_TO_PROJECT } from "@/reports/credits";
import type { CreditTurn } from "@/reports/credits";
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

  it("defaults to the measured Max 5x weekly allowance", () => {
    expect(DEFAULT_WEEKLY_CAP).toBe(1_200_000_000);
  });

  it("puts a heavy real week under cap rather than several times over it", () => {
    // Regression on the 30x-low constant: 722.4M credits was a real week, and
    // /usage never showed it near the ceiling. A cap that reports it as 4.33x
    // over is measuring in units nothing else uses.
    expect(722_400_000 / DEFAULT_WEEKLY_CAP).toBeLessThan(1);
  });
});

describe("credits — partial weeks and projection", () => {
  it("marks a finished week complete and does not project it", () => {
    const [w] = computeWeeks([row({ outputTokens: 100 })], MON_MS + 7 * 86_400_000);
    expect(w!.open).toBe(false);
    expect(w!.projected).toBeNull();
    expect(w!.elapsed).toBe(1);
  });

  it("projects a half-elapsed week to double its spend so far", () => {
    const [w] = computeWeeks([row({ outputTokens: 100 })], MON_MS + 3.5 * 86_400_000);
    expect(w!.open).toBe(true);
    expect(w!.elapsed).toBeCloseTo(0.5, 6);
    expect(w!.projected).toBeCloseTo(1_000, 6); // 100*5 spent at half-time
  });

  it("refuses to project a week that has barely started", () => {
    // Monday morning is the common case, not an edge one. Extrapolating from the
    // first hours multiplies whatever landed there by 20x or more, so the report
    // must print no forecast rather than a confident wrong one.
    const [w] = computeWeeks([row({ outputTokens: 100 })], MON_MS + 3 * 3_600_000);
    expect(w!.open).toBe(true);
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
      const { weeks, subagentsIncluded } = createSqliteReader(db).queryCreditWeeks(0);
      expect(subagentsIncluded).toBe(false);
      // Structurally zero, but still SELECTed: an omitted column comes back
      // undefined and every derived figure downstream is NaN, which the table's
      // "n/a" for this source would have hidden.
      expect(weeks.length).toBeGreaterThan(0);
      for (const w of weeks) {
        for (const v of [w.subagentTurns, w.subagentInputTokens, w.subagentCacheReadTokens, w.subagentCacheWriteTokens, w.subagentOutputTokens]) {
          expect(typeof v).toBe("number");
        }
      }
      const computed = computeWeeks(weeks, Date.parse("2030-01-01T00:00:00.000Z"));
      for (const c of computed) expect(Number.isFinite(c.subagentCredits)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps queryByProject free of the credit report's subagent columns", () => {
    // They were added to this query by mistake — a stray SELECT alias that
    // ProjectRow ignores, so nothing failed and the credits query went without.
    const db = openDb(resolveDbPath().path);
    try {
      const rows = createSqliteReader(db).queryByProject(0, 5);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).not.toHaveProperty("subagentTurns");
      expect(rows[0]).not.toHaveProperty("subagentCacheReadTokens");
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
    expect(w!.open).toBe(false);
  });

  it("does not flag a week fully inside the window", () => {
    const [w] = computeWeeks([row({ outputTokens: 100 })], afterWeek, MON_MS);
    expect(w!.truncated).toBe(false);
  });

  it("treats sinceMs exactly at the week start as complete coverage", () => {
    // Boundary: `>` not `>=`. A window opening precisely on Monday 00:00 UTC sees
    // the whole week, so flagging it would exclude a week that is in fact whole.
    const [w] = computeWeeks([row({ outputTokens: 100 })], afterWeek, MON_MS - 1);
    expect(w!.truncated).toBe(false);
    const [exact] = computeWeeks([row({ outputTokens: 100 })], afterWeek, MON_MS);
    expect(exact!.truncated).toBe(false);
    const [after] = computeWeeks([row({ outputTokens: 100 })], afterWeek, MON_MS + 1);
    expect(after!.truncated).toBe(true);
  });

  it("never projects a truncated week", () => {
    // The first fix's own regression: a truncated week holds part of a week's
    // spend, so dividing it by the WEEK's elapsed fraction understates the
    // forecast by exactly the unobserved slice — and prints it as fact.
    const midWeek = MON_MS + 3 * 86_400_000;
    const now = MON_MS + 5 * 86_400_000;   // in-progress AND truncated
    const [w] = computeWeeks([row({ outputTokens: 100 })], now, midWeek);
    expect(w!.open).toBe(true);
    expect(w!.truncated).toBe(true);
    expect(w!.elapsed).toBeGreaterThan(MIN_ELAPSED_TO_PROJECT);  // would have projected
    expect(w!.projected).toBeNull();
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

describe("credits — rolling 5h windows", () => {
  const H = 3_600_000;
  const T0 = Date.parse("2026-08-17T12:40:00.000Z");

  function turn(atMs: number, over: Partial<CreditTurn> = {}): CreditTurn {
    return {
      timestampMs: atMs, isSubagent: false,
      inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
      ...over,
    };
  }

  it("opens a window at the first turn and closes it five hours later", () => {
    const [w] = computeWindows([turn(T0, { outputTokens: 100 })], T0 + 60_000);
    expect(w!.startMs).toBe(T0);
    expect(w!.endMs).toBe(T0 + 5 * H);
    expect(w!.credits).toBe(500);
    expect(w!.turns).toBe(1);
  });

  it("keeps turns inside the window in the same window", () => {
    // The window is anchored to its OWN start, not to the previous turn: four
    // hours of steady chatter is one window, however the turns are spaced.
    const ws = computeWindows(
      [turn(T0), turn(T0 + 2 * H), turn(T0 + 4 * H)].map((t) => ({ ...t, outputTokens: 100 })),
      T0 + 4 * H,
    );
    expect(ws.length).toBe(1);
    expect(ws[0]!.turns).toBe(3);
    expect(ws[0]!.credits).toBe(1_500);
  });

  it("opens a fresh window on the first turn past the previous window's end", () => {
    // Not on a five-hour GAP between turns. A turn at +4h then one at +6h is two
    // windows, because the first window expired at +5h — measuring the gap
    // instead (2h) would wrongly fold them together.
    const ws = computeWindows(
      [turn(T0, { outputTokens: 100 }), turn(T0 + 4 * H, { outputTokens: 100 }), turn(T0 + 6 * H, { outputTokens: 100 })],
      T0 + 6 * H,
    );
    expect(ws.length).toBe(2);
    expect(ws[0]!.turns).toBe(2);
    expect(ws[1]!.startMs).toBe(T0 + 6 * H);
    expect(ws[1]!.turns).toBe(1);
  });

  it("leaves a gap with no turns as no window at all", () => {
    // Idle time does not consume an allowance, so a quiet stretch must not
    // appear as an empty window between two busy ones.
    const ws = computeWindows(
      [turn(T0, { outputTokens: 100 }), turn(T0 + 40 * H, { outputTokens: 100 })],
      T0 + 40 * H,
    );
    expect(ws.length).toBe(2);
    expect(ws[1]!.startMs).toBe(T0 + 40 * H);
  });

  it("weights each component the same way the weekly view does", () => {
    // All four, not just the total and one column. Asserting `credits` and
    // `cacheRead` alone let a breakdown that filed output under `input` pass the
    // whole suite — the total is right however the components are shuffled.
    const tokens = { inputTokens: 1_000, cacheWriteTokens: 2_000, cacheReadTokens: 3_000, outputTokens: 4_000 };
    const [w] = computeWindows([turn(T0, tokens)], T0);
    const [week] = computeWeeks([row(tokens)], MON_MS + 8 * 86_400_000);
    expect(w!.credits).toBeCloseTo(week!.credits, 6);
    expect(w!.components.input).toBeCloseTo(week!.components.input, 6);
    expect(w!.components.cacheWrite).toBeCloseTo(week!.components.cacheWrite, 6);
    expect(w!.components.cacheRead).toBeCloseTo(week!.components.cacheRead, 6);
    expect(w!.components.output).toBeCloseTo(week!.components.output, 6);
  });

  it("keeps the total equal to the sum of its components", () => {
    const [w] = computeWindows([turn(T0, {
      inputTokens: 7, cacheWriteTokens: 11, cacheReadTokens: 13, outputTokens: 17,
    })], T0);
    const c = w!.components;
    expect(c.input + c.cacheWrite + c.cacheRead + c.output).toBeCloseTo(w!.credits, 6);
  });

  it("puts a turn exactly at the window end into the next window", () => {
    // The interval is half-open: [start, start + WINDOW_MS). Without a turn at
    // exactly the boundary, `>=` and `>` are indistinguishable — and one of them
    // makes consecutive windows overlap.
    const ws = computeWindows([
      turn(T0, { outputTokens: 100 }),
      turn(T0 + WINDOW_MS, { outputTokens: 100 }),
    ], T0 + WINDOW_MS);
    expect(ws.length).toBe(2);
    expect(ws[1]!.startMs).toBe(T0 + WINDOW_MS);
  });

  it("closes a window at the instant now reaches its end", () => {
    const [w] = computeWindows([turn(T0, { outputTokens: 100 })], T0 + WINDOW_MS);
    expect(w!.open).toBe(false);
  });

  it("drops a turn whose timestamp cannot be read, and says how many", () => {
    // `src/jsonl.ts` yields NaN from a malformed timestamp, and NaN >= x is
    // false — so an unguarded NaN anchor makes the new-window test permanently
    // false and swallows every later turn into one window. The weekly path
    // guards this at jsonl.ts:349; this one has to as well.
    const { windows, droppedTurns } = computeWindowsChecked([
      turn(NaN, { outputTokens: 100 }),
      turn(T0, { outputTokens: 100 }),
      turn(T0 + 6 * H, { outputTokens: 100 }),
    ], T0 + 6 * H);
    expect(droppedTurns).toBe(1);
    expect(windows.length).toBe(2);
    expect(windows[0]!.startMs).toBe(T0);
    expect(Number.isFinite(windows[0]!.startMs)).toBe(true);
  });

  it("refuses a non-finite now rather than reporting every window closed", () => {
    expect(() => computeWindows([turn(T0, { outputTokens: 100 })], NaN)).toThrow(TypeError);
  });

  it("breaks out the subagent share without double-counting it", () => {
    const ws = computeWindows([
      turn(T0, { outputTokens: 100 }),
      turn(T0 + H, { outputTokens: 100, isSubagent: true }),
    ], T0 + H);
    expect(ws[0]!.credits).toBe(1_000);
    expect(ws[0]!.subagentCredits).toBe(500);
    expect(ws[0]!.subagentTurns).toBe(1);
  });

  it("marks only the window containing now as open", () => {
    const ws = computeWindows(
      [turn(T0, { outputTokens: 100 }), turn(T0 + 6 * H, { outputTokens: 100 })],
      T0 + 7 * H,
    );
    expect(ws[0]!.open).toBe(false);
    expect(ws[1]!.open).toBe(true);
  });

  it("closes the last window once now is past its end", () => {
    const [w] = computeWindows([turn(T0, { outputTokens: 100 })], T0 + 6 * H);
    expect(w!.open).toBe(false);
  });

  it("sorts unordered input rather than trusting the caller", () => {
    // The JSONL reader walks files per project, so turns arrive interleaved
    // across sessions and are not globally ordered. Bucketing them as-given
    // opens a new window every time the file order jumps backwards.
    const ws = computeWindows([
      turn(T0 + 2 * H, { outputTokens: 100 }),
      turn(T0, { outputTokens: 100 }),
      turn(T0 + H, { outputTokens: 100 }),
    ], T0 + 2 * H);
    expect(ws.length).toBe(1);
    expect(ws[0]!.startMs).toBe(T0);
    expect(ws[0]!.turns).toBe(3);
  });

  it("does not call a future-dated window open", () => {
    // Clock skew on a synced host puts a turn ahead of now, anchoring a window
    // that has not started. Testing only `now < endMs` marks it open as well,
    // so the report would show two live windows. The weekly view already
    // guards the same skew when it picks the current week.
    const ws = computeWindows([
      turn(T0, { outputTokens: 100 }),
      turn(T0 + 30 * H, { outputTokens: 100 }),
    ], T0 + H);
    expect(ws[0]!.open).toBe(true);
    expect(ws[1]!.open).toBe(false);
    expect(ws.filter((w) => w.open).length).toBe(1);
  });

  it("returns nothing for no turns", () => {
    expect(computeWindows([], T0)).toEqual([]);
  });
});
