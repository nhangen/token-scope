import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { renderSavingsReport, valueAtClaudePrices, DEFAULT_COUNTERFACTUAL_MODEL } from "@/reports/savings";

const SPEND_DIR = new URL("./fixtures/spend-projects", import.meta.url).pathname;
const LEDGER = new URL("./fixtures/ledger/runs.jsonl", import.meta.url).pathname;

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

const base = {
  since: 0, sinceStr: "all", json: true,
  ledgerPath: LEDGER, counterfactualModel: DEFAULT_COUNTERFACTUAL_MODEL,
};

describe("valueAtClaudePrices", () => {
  it("values input+output token volume at the model's Claude prices", () => {
    // opus-4-8: $5/MTok in, $25/MTok out
    expect(valueAtClaudePrices(100000, 40000, "claude-opus-4-8")).toBeCloseTo(1.5, 6); // 0.5 + 1.0
  });
  it("returns null for a model with no known pricing", () => {
    expect(valueAtClaudePrices(1000, 1000, "qwen2.5-coder:32b")).toBeNull();
  });
});

describe("renderSavingsReport — aggregate", () => {
  it("groups runs by session and sums ollama token volume", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    expect(p.report).toBe("savings");
    expect(p.counterfactual_model).toBe("claude-opus-4-8");
    expect(p.totals.run_count).toBe(4);
    expect(p.totals.ollama_input).toBe(129000);  // 100k+20k+1k+8k
    expect(p.totals.ollama_output).toBe(47500);   // 40k+5k+0.5k+2k
    // three groups: sess-spend, (unattributed null), sess-unknown
    expect(p.sessions.length).toBe(3);
  });

  it("computes counterfactual = ollama volume valued at Claude prices", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: { session_id: string | null }) => x.session_id === "sess-spend");
    // in=120000 out=45000 @ opus-4-8 => (120000*5 + 45000*25)/1e6 = 1.725
    expect(s.counterfactual_usd).toBeCloseTo(1.725, 6);
  });

  it("subtracts the session's billed Claude spend as PM overhead", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: { session_id: string | null }) => x.session_id === "sess-spend");
    // sess-spend billed spend = direct 0.01278 + subagent 0.01026 = 0.02304
    expect(s.pm_overhead_usd).toBeCloseTo(0.02304, 5);
    expect(s.net_savings_usd).toBeCloseTo(1.70196, 5); // 1.725 - 0.02304
    expect(s.attributed).toBe(true);
  });

  it("marks runs with no resolvable session spend as unattributed (net excluded)", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const nullGroup = p.sessions.find((x: { session_id: string | null }) => x.session_id === null);
    const unknown = p.sessions.find((x: { session_id: string | null }) => x.session_id === "sess-unknown");
    expect(nullGroup.attributed).toBe(false);
    expect(nullGroup.pm_overhead_usd).toBeNull();
    expect(nullGroup.net_savings_usd).toBeNull();
    expect(unknown.attributed).toBe(false);      // session not in transcripts
    expect(unknown.net_savings_usd).toBeNull();
  });

  it("headline net sums ONLY attributed sessions", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    // only sess-spend is attributed => net headline = its net
    expect(p.totals.net_savings_usd).toBeCloseTo(1.70196, 5);
    expect(p.totals.attributed_session_count).toBe(1);
    expect(p.totals.unattributed_run_count).toBe(2); // r3 (null) + r4 (unknown)
  });
});

describe("renderSavingsReport — multiple attributed sessions", () => {
  const MULTI = new URL("./fixtures/ledger/multi.jsonl", import.meta.url).pathname;

  it("sums the net headline across ALL attributed sessions (reducer coverage)", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, ledgerPath: MULTI })));
    expect(p.totals.attributed_session_count).toBe(2);
    // Relational: totals must equal the sum of per-session values, not any one
    // of them (guards against a last-wins / overwrite reducer bug).
    const attributed = p.sessions.filter((s: { attributed: boolean }) => s.attributed);
    expect(attributed.length).toBe(2);
    const sumNet = attributed.reduce((a: number, s: { net_savings_usd: number }) => a + s.net_savings_usd, 0);
    const sumCf = attributed.reduce((a: number, s: { counterfactual_usd: number }) => a + s.counterfactual_usd, 0);
    const sumPm = attributed.reduce((a: number, s: { pm_overhead_usd: number }) => a + s.pm_overhead_usd, 0);
    expect(p.totals.net_savings_usd).toBeCloseTo(sumNet, 6);
    expect(p.totals.counterfactual_usd).toBeCloseTo(sumCf, 6);
    expect(p.totals.pm_overhead_usd).toBeCloseTo(sumPm, 6);
    // And the net headline is genuinely larger than either single session's net.
    expect(p.totals.net_savings_usd).toBeGreaterThan(Math.max(...attributed.map((s: { net_savings_usd: number }) => s.net_savings_usd)));
  });
});

describe("renderSavingsReport — turn-scoped PM overhead (--pm-turns)", () => {
  it("scopes PM overhead to the delegation turns, excluding session-wide subagents", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, sessionId: "sess-spend", pmTurnRange: { from: 1, to: 3 } })));
    expect(p.pm_scope.mode).toBe("turns");
    expect(p.pm_scope.from).toBe(1);
    expect(p.pm_scope.to).toBe(3);
    const s = p.sessions[0];
    // direct turns 1..3 = 0.01278; whole-session (0.02304) would add the 0.01026 subagent
    expect(s.pm_overhead_usd).toBeCloseTo(0.01278, 5);
    // counterfactual (120k/45k @ opus-4-8 = 1.725) − scoped PM
    expect(s.net_savings_usd).toBeCloseTo(1.71222, 5);
  });

  it("a single-turn slice yields smaller PM overhead → larger net than whole-session", () => {
    const scoped = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, sessionId: "sess-spend", pmTurnRange: { from: 2, to: 2 } })));
    const whole = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, sessionId: "sess-spend" })));
    expect(scoped.sessions[0].pm_overhead_usd).toBeCloseTo(0.004935, 6); // turn 2 direct cost only
    expect(scoped.sessions[0].net_savings_usd).toBeGreaterThan(whole.sessions[0].net_savings_usd);
  });

  it("defaults to whole-session PM scope when --pm-turns is absent", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, sessionId: "sess-spend" })));
    expect(p.pm_scope.mode).toBe("whole-session");
  });
});

describe("renderSavingsReport — session scope", () => {
  it("filters the ledger to one session by prefix", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, sessionId: "sess-spend" })));
    expect(p.sessions.length).toBe(1);
    expect(p.sessions[0].session_id).toBe("sess-spend");
    expect(p.totals.run_count).toBe(2);
  });
});

describe("renderSavingsReport — unknown counterfactual model", () => {
  it("leaves counterfactual + net null and flags it", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, counterfactualModel: "not-a-model" })));
    expect(p.counterfactual_priced).toBe(false);
    expect(p.totals.net_savings_usd).toBeNull();
    const s = p.sessions.find((x: { session_id: string | null }) => x.session_id === "sess-spend");
    expect(s.counterfactual_usd).toBeNull();
  });
});

describe("renderSavingsReport — empty ledger", () => {
  it("reports no runs without crashing", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, ledgerPath: "/no/such/runs.jsonl" })));
    expect(p.totals.run_count).toBe(0);
    expect(p.sessions).toEqual([]);
    expect(p.totals.net_savings_usd).toBeNull();
  });
});
