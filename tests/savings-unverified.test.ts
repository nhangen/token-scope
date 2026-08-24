import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { renderSavingsReport, DEFAULT_COUNTERFACTUAL_MODEL } from "@/reports/savings";

const SPEND_DIR = new URL("./fixtures/spend-projects", import.meta.url).pathname;
const LEDGER = new URL("./fixtures/ledger/runs-unverified.jsonl", import.meta.url).pathname;

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

// The fixture's five rows:
//   author:500        100000 /  40000  verified: true
//   author:501         30000 /   6000  verified: null    <- completed, no verify cmd
//   author:502          8000 /   1000  verified: false, completed: false  <- unverified
//   review:500:p1of2   50000 /   2000  verified: null    <- review, NOT unverified authoring
//   r-old               5000 /    500  verified absent   <- legacy, NOT unverified
const UNVERIFIED_IN = 8000;                          //  8000 (only author:502)
const UNVERIFIED_OUT = 1000;                         //  1000

describe("renderSavingsReport — unverified authoring runs", () => {
  it("counts an authoring row with verified:false as unverified", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.unverified_run_count).toBe(1);
    expect(s.unverified_input).toBe(UNVERIFIED_IN);
    expect(s.unverified_output).toBe(UNVERIFIED_OUT);
  });

  it("surfaces the same figures in totals", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    expect(p.totals.unverified_run_count).toBe(1);
    expect(p.totals.unverified_input).toBe(UNVERIFIED_IN);
    expect(p.totals.unverified_output).toBe(UNVERIFIED_OUT);
  });

  it("does NOT count a review row as an unverified authoring run", () => {
    // review:500:p1of2 carries verified:null, but review rows are already
    // excluded from the counterfactual — counting them here would double-report
    // the same volume under two different warnings.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.unverified_input).toBe(UNVERIFIED_IN);
    expect(s.unverified_run_count).toBe(1);
    expect(s.review_run_count).toBe(1);
  });

  it("does NOT count a legacy row whose verified field is absent", () => {
    // Absent is unknown, not failed. Treating it as failed would retroactively
    // flag every pre-ledger-schema row.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.unverified_run_count).toBe(1);
    expect(s.unverified_input).toBe(UNVERIFIED_IN);
  });

  it("leaves the counterfactual pricing unchanged — a failed attempt still cost money", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    // 56,000 uncached + 87,000 cached + 47,500 out = 1.511. The point of this arm
    // is that the unverified axis does not change pricing; the literal moved with
    // #465, the invariant did not.
    // Hand-computed, not built from valueAtClaudePrices — these assertions used to
    // call the production pricing helper, so when #465 changed how input is priced
    // every one of them moved with it and none reported the change. See the
    // per-fixture derivation in the comment above each literal.
    expect(s.counterfactual_usd).toBeCloseTo(1.511, 6);
  });

  it("breaks unverified volume down per label", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, byLabel: true })));
    const l501 = p.by_label.find((x: any) => x.label === "501");
    expect(l501.unverified_run_count).toBe(0);
    expect(l501.unverified_input).toBe(0);
    expect(l501.unverified_output).toBe(0);

    const l502 = p.by_label.find((x: any) => x.label === "502");
    expect(l502.unverified_run_count).toBe(1);
    expect(l502.unverified_input).toBe(8000);
    expect(l502.unverified_output).toBe(1000);

    const l500 = p.by_label.find((x: any) => x.label === "500");
    expect(l500.unverified_run_count).toBe(0);
    expect(l500.unverified_input).toBe(0);
  });

  it("shows the unverified run count per label in the text table", () => {
    // The point of --by-label plus this axis is answering "which ticket burned
    // failed attempts" — a figure only in JSON does not answer it.
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false, byLabel: true }));
    const row501 = text.split("\n").find((l) => l.startsWith("501"));
    expect(row501).toBeDefined();
    expect(row501!.trim().split(/\s*│\s*/).map((c) => c.trim())).toContain("1");
    expect(text).toContain("Unver.");
  });

  it("names the unverified volume in the text report", () => {
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false }));
    expect(text.toLowerCase()).toContain("unverified");
  });

  it("stays silent on a ledger where nothing failed", () => {
    const clean = new URL("./fixtures/ledger/runs-labelled.jsonl", import.meta.url).pathname;
    const text = capture(() => renderSavingsReport(reader, { ...base, ledgerPath: clean, json: false }));
    expect(text.toLowerCase()).not.toContain("unverified");
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, ledgerPath: clean })));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.unverified_run_count).toBeUndefined();
    expect(p.totals.unverified_run_count).toBeUndefined();
  });
});
