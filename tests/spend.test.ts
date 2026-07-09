import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { openDb, resolveDbPath, createSqliteReader } from "@/db";
import { renderSpendReport } from "@/reports/spend";

const SPEND_DIR = new URL("./fixtures/spend-projects", import.meta.url).pathname;

let reader: Reader;
beforeAll(() => { reader = createReader({ source: "jsonl", projectsDirs: [SPEND_DIR] }); });
afterAll(() => { reader.close(); });

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { fn(); } finally { console.log = orig; }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

const base = { since: 0, sinceStr: "all", json: true };

describe("querySubagentSpend (jsonl)", () => {
  it("rolls up a multi-turn subagent transcript for the session", () => {
    const s = reader.querySubagentSpend("sess-spend");
    expect(s.supported).toBe(true);
    expect(s.agentCount).toBe(1);          // one transcript file
    expect(s.outputTokens).toBe(450);      // 300 + 150 across both agent turns
    expect(s.inputTokens).toBe(45);        // 30 + 15
    expect(s.cacheReadTokens).toBe(5000);  // 2000 + 3000
    expect(s.cacheWriteTokens).toBe(500);  // 500 + 0
    expect(s.costPartial).toBe(false);
    expect(s.costUsd).toBeCloseTo(0.01026, 5);
  });

  it("returns zeros for a session with no subagents", () => {
    const s = reader.querySubagentSpend("sess-partial");
    expect(s.supported).toBe(true);
    expect(s.agentCount).toBe(0);
    expect(s.outputTokens).toBe(0);
    expect(s.costUsd).toBeNull();
  });
});

describe("renderSpendReport — whole session", () => {
  it("emits per-turn rows + direct/subagent/combined totals", () => {
    const out = capture(() => renderSpendReport(reader, { ...base, sessionId: "sess-spend" }));
    const p = JSON.parse(out);
    expect(p.report).toBe("spend");
    expect(p.meta).toHaveProperty("generated_at");
    expect(p.session.session_id).toBe("sess-spend");
    expect(p.session.turn_count_total).toBe(3);
    expect(p.turns.map((t: { turn: number }) => t.turn)).toEqual([1, 2, 3]);

    expect(p.totals.direct.output).toBe(350);       // 100+200+50
    expect(p.totals.direct.input).toBe(35);
    expect(p.totals.direct.cache_read).toBe(11000);
    expect(p.totals.direct.cache_write).toBe(1100);
    expect(p.totals.direct.cost_usd).toBeCloseTo(0.01278, 5);

    expect(p.totals.subagent.supported).toBe(true);
    expect(p.totals.subagent.agent_count).toBe(1);
    expect(p.totals.subagent.output).toBe(450);

    expect(p.totals.combined.output).toBe(800);     // 350 + 450
    expect(p.totals.combined.cost_usd).toBeCloseTo(0.02304, 5);
  });

  it("conserves tokens: direct + subagent == combined", () => {
    const out = capture(() => renderSpendReport(reader, { ...base, sessionId: "sess-spend" }));
    const { direct, subagent, combined } = JSON.parse(out).totals;
    for (const k of ["output", "input", "cache_read", "cache_write"]) {
      expect(combined[k]).toBe(direct[k] + subagent[k]);
    }
  });
});

describe("renderSpendReport — turn slice", () => {
  it("scopes direct spend to the range but keeps subagent session-wide (v1)", () => {
    const out = capture(() => renderSpendReport(reader, { ...base, sessionId: "sess-spend", turnRange: { from: 2, to: 2 } }));
    const p = JSON.parse(out);
    expect(p.turns.map((t: { turn: number }) => t.turn)).toEqual([2]);
    expect(p.totals.direct.output).toBe(200);
    expect(p.totals.direct.cost_usd).toBeCloseTo(0.004935, 6);
    // subagent is session-wide, so combined still adds the full 450
    expect(p.totals.subagent.output).toBe(450);
    expect(p.totals.combined.output).toBe(650);
  });

  it("clamps an out-of-range upper bound", () => {
    const out = capture(() => renderSpendReport(reader, { ...base, sessionId: "sess-spend", turnRange: { from: 1, to: 99 } }));
    const p = JSON.parse(out);
    expect(p.turns.length).toBe(3);
  });
});

describe("renderSpendReport — partial pricing", () => {
  it("counts unknown-model tokens but flags cost_partial and excludes their cost", () => {
    const out = capture(() => renderSpendReport(reader, { ...base, sessionId: "sess-partial" }));
    const p = JSON.parse(out);
    expect(p.totals.direct.output).toBe(300);        // 100 (known) + 200 (unknown model)
    expect(p.totals.direct.cost_partial).toBe(true);
    expect(p.totals.direct.cost_usd).toBeCloseTo(0.00153, 5); // only the sonnet turn
  });
});

describe("renderSpendReport — sqlite subagent unsupported", () => {
  it("reports subagent attribution as unsupported on the sqlite source", () => {
    const sqlite = createSqliteReader(openDb(resolveDbPath().path));
    const s = sqlite.querySubagentSpend("anything");
    expect(s.supported).toBe(false);
    expect(s.agentCount).toBe(0);
    expect(s.costUsd).toBeNull();
    sqlite.close();
  });
});
