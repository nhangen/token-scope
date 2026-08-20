import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { renderSavingsReport, valueAtClaudePrices, DEFAULT_COUNTERFACTUAL_MODEL } from "@/reports/savings";

const SPEND_DIR = new URL("./fixtures/spend-projects", import.meta.url).pathname;
const LEDGER = new URL("./fixtures/ledger/runs-labelled.jsonl", import.meta.url).pathname;

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

// The fixture's six rows, by run_id:
//   author:412        100000 in /  40000 out
//   review:412:p1of3   50000 in /   2000 out
//   review:412:p2of3   50000 in /   2000 out
//   author:433         20000 in /   5000 out
//   r-legacy           10000 in /   1000 out   (no colon — an authoring row)
//   (null run_id)       4000 in /    400 out   (pre-label authoring row)
const AUTHORING_IN = 100000 + 20000 + 10000 + 4000;   // 134000
const AUTHORING_OUT = 40000 + 5000 + 1000 + 400;      //  46400
const REVIEW_IN = 50000 + 50000;                      // 100000
const REVIEW_OUT = 2000 + 2000;                       //   4000

describe("renderSavingsReport — review passes are not priced as authoring", () => {
  it("prices the counterfactual on authoring volume only, excluding review: rows", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s).toBeDefined();
    // 67,333 uncached + 66,667 cached + 46,400 out = 1.5299985 exactly.
    // Hand-computed, not built from valueAtClaudePrices — these assertions used to
    // call the production pricing helper, so when #465 changed how input is priced
    // every one of them moved with it and none reported the change. See the
    // per-fixture derivation in the comment above each literal.
    expect(s.counterfactual_usd).toBeCloseTo(1.5299985, 6);
  });

  it("keeps ollama_input/ollama_output as total volume so no spend is hidden", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.ollama_input).toBe(AUTHORING_IN + REVIEW_IN);
    expect(s.ollama_output).toBe(AUTHORING_OUT + REVIEW_OUT);
    expect(s.run_count).toBe(6);
  });

  it("reports review volume separately, per session and in totals", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.review_run_count).toBe(2);
    expect(s.review_input).toBe(REVIEW_IN);
    expect(s.review_output).toBe(REVIEW_OUT);
    expect(p.totals.review_run_count).toBe(2);
    expect(p.totals.review_input).toBe(REVIEW_IN);
    expect(p.totals.review_output).toBe(REVIEW_OUT);
  });

  it("a run_id with no colon is an authoring row, not a review row", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    // r-legacy and the null-run_id row must stay inside the priced counterfactual;
    // if either were treated as non-authoring the figure would drop by their value.
// r-legacy (10,000 in) and the null run_id (4,000 in) are both turns=1, so both
    // are fully uncached and drop out at the full input rate: 14,000 @ $5/M +
    // 1,400 out @ $25/M = 0.105 of the 1.5299985.
    const withLegacy = 1.5299985;
    const withoutLegacy = 1.4249985;
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.counterfactual_usd).toBeCloseTo(withLegacy, 6);
    expect(s.counterfactual_usd).not.toBeCloseTo(withoutLegacy, 6);
  });

  it("says in the text report that review volume is excluded from the counterfactual", () => {
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false }));
    expect(text.toLowerCase()).toContain("review");
  });
});

describe("renderSavingsReport — --by-label breakdown", () => {
  it("omits by_label unless asked", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    expect(p.by_label).toBeUndefined();
  });

  it("splits run_id into phase and label and groups by label", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, byLabel: true })));
    expect(Array.isArray(p.by_label)).toBe(true);
    const l412 = p.by_label.find((x: any) => x.label === "412");
    expect(l412).toBeDefined();
    expect(l412.run_count).toBe(3);
    expect(l412.author_input).toBe(100000);
    expect(l412.author_output).toBe(40000);
    expect(l412.review_input).toBe(REVIEW_IN);
    expect(l412.review_output).toBe(REVIEW_OUT);
    expect(l412.review_run_count).toBe(2);
    // author:412 is 100,000 in over 4 turns -> 40,000 uncached, 60,000 cached,
    // plus 40,000 out. The two review:412 rows contribute nothing.
    expect(l412.counterfactual_usd).toBeCloseTo(1.23, 6);

    const l433 = p.by_label.find((x: any) => x.label === "433");
    expect(l433.run_count).toBe(1);
    expect(l433.author_input).toBe(20000);
    expect(l433.review_run_count).toBe(0);
  });

  it("buckets rows carrying no label under a null label rather than dropping them", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, byLabel: true })));
    const unlabelled = p.by_label.find((x: any) => x.label === null);
    expect(unlabelled).toBeDefined();
    // r-legacy (no colon) and the null-run_id row.
    expect(unlabelled.run_count).toBe(2);
    expect(unlabelled.author_input).toBe(14000);
  });

  it("accounts for every ledger row exactly once across the label buckets", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, byLabel: true })));
    const runs = p.by_label.reduce((s: number, x: any) => s + x.run_count, 0);
    const inTok = p.by_label.reduce((s: number, x: any) => s + x.author_input + x.review_input, 0);
    expect(runs).toBe(6);
    expect(inTok).toBe(AUTHORING_IN + REVIEW_IN);
  });

  it("sorts labels numerically with the unlabelled bucket last", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, byLabel: true })));
    expect(p.by_label.map((x: any) => x.label)).toEqual(["412", "433", null]);
  });

  it("warns when the label table's scope is wider than the Totals counterfactual", () => {
    // by_label spans every filtered run; Totals counts attributed sessions only.
    // The shared fixture is the one with unattributed rows (a null session_id
    // and a session absent from the transcripts), so it is what exercises this.
    const mixed = new URL("./fixtures/ledger/runs.jsonl", import.meta.url).pathname;
    const text = capture(() => renderSavingsReport(reader, { ...base, ledgerPath: mixed, json: false, byLabel: true }));
    expect(text).toContain("will not add up");
  });

  it("stays silent about the scope gap when every run is attributed", () => {
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false, byLabel: true }));
    expect(text).not.toContain("will not add up");
  });

  it("prints a per-label table in the text report", () => {
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false, byLabel: true }));
    expect(text).toContain("412");
    expect(text).toContain("433");
  });
});
