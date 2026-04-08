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
    expect(totals.turnCount).toBe(6);
  });

  it("counts sessions with since=0", () => {
    const totals = reader.querySummaryTotals(0);
    expect(totals.sessionCount).toBe(3);
  });

  it("sums output tokens with since=0", () => {
    const totals = reader.querySummaryTotals(0);
    expect(totals.totalOutputTokens).toBe(2050);
  });

  it("excludes old session with 30d window", () => {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const totals = reader.querySummaryTotals(since);
    expect(totals.turnCount).toBe(5);
    expect(totals.sessionCount).toBe(2);
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

  it("token-scope project has 3 turns", () => {
    const rows = reader.queryByProject(0, 20);
    const ts = rows.find((r) => r.cwd?.includes("token-scope"));
    expect(ts?.turns).toBe(3);
  });
});

describe("JsonlReader — sessions", () => {
  it("returns 3 sessions with since=0", () => {
    const sessions = reader.querySessions(0, 20);
    expect(sessions.length).toBe(3);
  });

  it("sess-j1 has 3 turns", () => {
    const sessions = reader.querySessions(0, 20);
    const s = sessions.find((r) => r.sessionId === "sess-j1");
    expect(s?.turnCount).toBe(3);
  });
});

describe("JsonlReader — session turns", () => {
  it("returns 3 turns for sess-j1", () => {
    const turns = reader.querySessionTurns("sess-j1");
    expect(turns.length).toBe(3);
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
    expect(turns.length).toBe(1);
    expect(turns[0]!.command).toBe("bun test");
  });
});

describe("JsonlReader — close", () => {
  it("close() does not throw", () => {
    expect(() => reader.close()).not.toThrow();
  });
});
