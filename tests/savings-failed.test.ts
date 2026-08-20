import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { renderSavingsReport, DEFAULT_COUNTERFACTUAL_MODEL } from "@/reports/savings";

const SPEND_DIR = new URL("./fixtures/spend-projects", import.meta.url).pathname;
const LEDGER = new URL("./fixtures/ledger/runs-failed.jsonl", import.meta.url).pathname;

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

// This fixture is built from the shapes the ledger writer ACTUALLY produces,
// counted across the live ledger: (completed, verified) is (true, true) 15x,
// (true, null) 15x, (false, null) 4x. `verified: false` never occurs — the
// bridge leaves verified null when there is no verify command, and a crashed
// run reports completed:false with verified null. The first version of this
// axis keyed on `verified === false` alone and therefore matched nothing at
// all in production while its own invented fixture passed.
//
//   author:700  100000 / 40000  (true, true)   -> succeeded
//   author:701  300000 /  9000  (false, null)  -> crashed at the turn cap
//   author:702   20000 /  3000  (true, false)  -> completed, verify failed
//   author:703   50000 /  5000  (true, null)   -> completed, no verify cmd
//   review:700  ...             (false, null)  -> review, its own axis
const FAILED_IN = 300000 + 20000;
const FAILED_OUT = 9000 + 3000;

describe("renderSavingsReport — runs that did not succeed", () => {
  it("counts a crashed run (completed:false, verified:null) as unverified", () => {
    // The shape that matters: 56% of the real ledger's priced volume is this,
    // and a rule keyed only on verified===false misses all of it.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.unverified_run_count).toBe(2);
    expect(s.unverified_input).toBe(FAILED_IN);
    expect(s.unverified_output).toBe(FAILED_OUT);
  });

  it("does not count a completed run with no verify command as failed", () => {
    // (true, null) is the commonest shape in the ledger — 15 of 34 rows. It
    // means "finished, nothing asserted", not "failed". Counting it would
    // flag nearly half of all real work as broken.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.unverified_input).not.toBe(FAILED_IN + 50000);
  });

  it("does not count a crashed review pass as a failed authoring run", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, base)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.review_run_count).toBe(1);
    expect(s.unverified_run_count).toBe(2);
  });

  it("surfaces failed volume in totals and per label", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, byLabel: true })));
    expect(p.totals.unverified_run_count).toBe(2);
    expect(p.totals.unverified_input).toBe(FAILED_IN);
    const l701 = p.by_label.find((x: any) => x.label === "701");
    expect(l701.unverified_run_count).toBe(1);
    expect(l701.unverified_input).toBe(300000);
  });

  it("says what share of the counterfactual never succeeded", () => {
    // The headline is unreadable without this: a reader needs to know the
    // priced figure includes work that produced nothing.
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false }));
    expect(text).toContain("did not succeed");
    // The share, not just the presence of a line: a reader who sees only a run
    // count cannot tell whether it is a rounding error or half the figure.
    expect(text).toContain("bought nothing");
    // The VALUE, not the shape. `/\d+%/` is why this shipped wrong: the footnote
    // priced failed rows at the pre-#465 full-input rate while dividing by a
    // cache-split counterfactual, and summed its numerator over all groups against an
    // attributed-only denominator. It printed 93% here where 27% is honest, and on a
    // ledger whose only row is an unattributed failure it printed 385%. A regex that
    // accepts any integer accepts all of those.
    expect(text).toMatch(/27% of the priced figure/);
    // A share of the priced figure cannot exceed it.
    const pct = Number(text.match(/(\d+)% of the priced figure/)![1]);
    expect(pct).toBeLessThanOrEqual(100);
  });
});

describe("renderSavingsReport — the failed share and its denominator cover the same rows", () => {
  const MIXED = new URL("./fixtures/ledger/runs-failed-mixed.jsonl", import.meta.url).pathname;

  it("excludes an unattributed failure from the numerator, as the denominator does", () => {
    // The second leg of the #465 blocker, and the one with no coverage until now:
    // pricing the numerator through the cache split fixed the fixtures while leaving
    // the numerator summed over ALL groups against an attributed-only denominator.
    // Every other failed-row fixture has only attributed groups, so the mutation was
    // invisible. Here author:801 (1M input) is unattributed; if it entered the
    // numerator the share would be several times its own whole.
    const text = capture(() => renderSavingsReport(reader, {
      ...base, json: false, ledgerPath: MIXED,
    }));
    // author:800 alone: round(100000*2/5)=40000 uncached, 60000 cached, 10000 out
    //   = (40000*5 + 60000*0.5 + 10000*25)/1e6 = $0.4800, and it is the entire
    //   attributed counterfactual, so the honest share is 100%.
    expect(text).toMatch(/\$0\.4800 of the \$0\.4800 counterfactual/);
    const pct = Number(text.match(/(\d+)% of the priced figure/)![1]);
    expect(pct).toBe(100);
    // Summing the numerator over all groups puts author:801's 1M input on top of a
    // denominator that never saw it — the shape that printed 385%.
    expect(pct).toBeLessThanOrEqual(100);
  });
});
