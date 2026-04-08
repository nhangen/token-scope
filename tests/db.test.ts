import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { openDb, resolveDbPath, querySummaryTotals, queryByTool, queryByProject, querySessions, querySessionTurns } from "@/db";
import type { Database } from "bun:sqlite";

let db: Database;

beforeAll(() => { db = openDb(resolveDbPath().path); });
afterAll(() => { db.close(); });

describe("resolveDbPath", () => {
  it("returns source 'env' when TOKEN_SCOPE_DB is set", () => {
    const result = resolveDbPath();
    expect(result.source).toBe("env");
    expect(result.path).toContain("__store.db");
  });
});

describe("querySummaryTotals", () => {
  it("returns correct shape with numeric fields", () => {
    const result = querySummaryTotals(db, 0);
    expect(result).toHaveProperty("totalOutputTokens");
    expect(result).toHaveProperty("totalCostUsd");
    expect(result).toHaveProperty("sessionCount");
    expect(result).toHaveProperty("turnCount");
    expect(typeof result.totalOutputTokens).toBe("number");
    expect(typeof result.sessionCount).toBe("number");
  });

  it("excludes the malformed-JSON row from token counts", () => {
    const all = querySummaryTotals(db, 0);
    // 9 valid rows: 210+850+1528+420+380+77+145+310+195 = 4115
    expect(all.totalOutputTokens).toBe(4115);
  });

  it("time filter excludes old sessions", () => {
    // 2026-03-01 00:00:00 UTC in ms = 1740787200000
    const result = querySummaryTotals(db, 1740787200000);
    // Old session (sess-c1) had 310+195=505 tokens - excluded
    // Recent: 210+850+1528+420+380+77+145 = 3610
    expect(result.totalOutputTokens).toBe(3610);
  });
});

describe("queryByTool", () => {
  it("returns rows sorted by output tokens desc", () => {
    const rows = queryByTool(db, 0, 20);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.outputTokens).toBeGreaterThanOrEqual(rows[i]!.outputTokens);
    }
  });

  it("each row has required fields", () => {
    const rows = queryByTool(db, 0, 20);
    for (const row of rows) {
      expect(row).toHaveProperty("tool");
      expect(row).toHaveProperty("turns");
      expect(row).toHaveProperty("outputTokens");
      expect(row).toHaveProperty("totalCostUsd");
      expect(typeof row.tool).toBe("string");
    }
  });
});

describe("queryByProject", () => {
  it("returns one row per distinct cwd", () => {
    const rows = queryByProject(db, 0, 20);
    const cwds = new Set(rows.map((r) => r.cwd));
    expect(cwds.size).toBe(rows.length);
  });

  it("includes session count and turn count", () => {
    const rows = queryByProject(db, 0, 20);
    for (const row of rows) {
      expect(row).toHaveProperty("sessions");
      expect(row).toHaveProperty("turns");
      expect(typeof row.sessions).toBe("number");
    }
  });
});

describe("querySessions", () => {
  it("returns sessions sorted by total cost desc", () => {
    const rows = querySessions(db, 0, 20);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i - 1]!.totalCostUsd ?? 0)).toBeGreaterThanOrEqual(rows[i]!.totalCostUsd ?? 0);
    }
  });

  it("each session row has required fields", () => {
    const rows = querySessions(db, 0, 20);
    for (const row of rows) {
      expect(row).toHaveProperty("sessionId");
      expect(row).toHaveProperty("cwd");
      expect(row).toHaveProperty("startedAt");
      expect(row).toHaveProperty("turnCount");
      expect(row).toHaveProperty("outputTokens");
    }
  });
});

describe("querySessionTurns", () => {
  it("returns turns in chronological order", () => {
    const turns = querySessionTurns(db, "sess-a1");
    expect(turns.length).toBe(3);
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i]!.timestamp).toBeGreaterThanOrEqual(turns[i - 1]!.timestamp);
    }
  });

  it("returns empty array for unknown session", () => {
    expect(querySessionTurns(db, "nonexistent-session-id")).toHaveLength(0);
  });

  it("each turn has message and outputTokens fields", () => {
    const turns = querySessionTurns(db, "sess-a1");
    for (const turn of turns) {
      expect(turn).toHaveProperty("message");
      expect(turn).toHaveProperty("outputTokens");
      expect(turn).toHaveProperty("costUsd");
    }
  });
});
