import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { renderSavingsReport, DEFAULT_COUNTERFACTUAL_MODEL } from "@/reports/savings";

const SPEND_DIR = new URL("./fixtures/spend-projects", import.meta.url).pathname;
const LEDGER = new URL("./fixtures/ledger/runs-reason.jsonl", import.meta.url).pathname;
const LEDGER_WITH_CONFLICT = new URL("./fixtures/ledger-conflict/runs-reason-with-conflict.jsonl", import.meta.url).pathname;

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

const baseWithConflict = {
  since: 0, sinceStr: "all", json: true,
  ledgerPath: LEDGER_WITH_CONFLICT, counterfactualModel: DEFAULT_COUNTERFACTUAL_MODEL,
};

// Every row here is a shape the bridge can actually emit; the reachable set and
// its derivation live in `tests/fixtures-emittable.test.ts`, which gates it.
//
// Production still contains rows written before the bridge recorded `reason`,
// so the FALLBACK is not legacy dead weight — it is the path a real failure
// takes. A fixture covering only the new field would pass while matching
// nothing, which is the mistake this axis already made once. Both halves are
// covered below, and the turn-cap and verify-failed counts are deliberately
// ASYMMETRIC (3 vs 2) so that swapping the two mappings cannot go unnoticed.
//
// Fixture rows:
//   author:600  10000/1000  reason ok             -> succeeded
//   author:601  20000/2000  reason turn-cap       -> unverified, turn-cap
//   author:602  30000/3000  reason verify-failed  -> unverified, verify-failed
//   author:603  40000/4000  no reason, c:f v:f    -> unverified, verify-failed (inferred)
//   author:604  50000/5000  no reason, c:f v:null -> unverified, turn-cap (inferred)
//   author:605  60000/6000  no reason, c:t v:t    -> succeeded
//   review:600  70000/7000  reason ok             -> review, excluded
//   author:606  80000/8000  reason "killed"       -> unverified, unrecognized
//   review:601  90000/9000  reason turn-cap       -> review, excluded ANYWAY
//   author:607  11000/1100  reason turn-cap       -> unverified, turn-cap
//   bench:600   15000/1500  reason ok             -> bench, excluded
//   author:608  12000/1200  reason ok, c:f v:null -> unverified, conflict (#64, #73)
//   author:609  13000/1300  reason ok, c:t v:null -> SUCCESS (no verify configured, #73)
const UNVERIFIED_IN = 20000 + 30000 + 40000 + 50000 + 80000 + 11000;  // 231000
const UNVERIFIED_OUT = 2000 + 3000 + 4000 + 5000 + 8000 + 1100;      //  23100

function sess(opts: Record<string, unknown> = {}): any {
  const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...base, ...opts })));
  return p.sessions.find((x: any) => x.session_id === "sess-spend");
}
function totals(opts: Record<string, unknown> = {}): any {
  return JSON.parse(capture(() => renderSavingsReport(reader, { ...base, ...opts }))).totals;
}

describe("renderSavingsReport — reads the ledger's reason field", () => {
  it("counts every run that did not succeed, from reason and from the fallback alike", () => {
    const s = sess();
    expect(s.unverified_run_count).toBe(6);
    expect(s.unverified_input).toBe(UNVERIFIED_IN);
    expect(s.unverified_output).toBe(UNVERIFIED_OUT);
  });

  it("splits turn-cap from verify-failed instead of reporting one number", () => {
    // The whole point of the field: a gate rejecting the work and a cap set too
    // low are different problems, and the old predicate collapsed them.
    const t = totals();
    expect(t.unverified_turn_cap_run_count).toBe(3);
    expect(t.unverified_verify_failed_run_count).toBe(2);
    // Asymmetric on purpose. With 2 and 2 the two mappings could be swapped
    // inside unverifiedKindOf and every assertion here would still hold.
    expect(t.unverified_turn_cap_run_count).not.toBe(t.unverified_verify_failed_run_count);
    // Same split per session, not only in totals — the per-session keys are a
    // separate emission and were shipped unasserted.
    const s2 = sess();
    expect(s2.unverified_turn_cap_run_count).toBe(3);
    expect(s2.unverified_verify_failed_run_count).toBe(2);
    expect(s2.unverified_other_run_count).toBe(1);
  });

  it("verifies the split counts are actually different (not byte-identical)", () => {
    // #34 item 8: byte-identical assertions at :70/:78. The first test is still
    // named for splitting behavior it shares byte-for-byte with the second, so
    // it still passes with the reason branch disabled. This test asserts the
    // counts are different, which is the actual invariant.
    const t = totals();
    const s = sess();
    // Totals and session must agree
    expect(t.unverified_turn_cap_run_count).toBe(s.unverified_turn_cap_run_count);
    expect(t.unverified_verify_failed_run_count).toBe(s.unverified_verify_failed_run_count);
    // The counts must be different (asymmetric fixture)
    expect(t.unverified_turn_cap_run_count).toBeGreaterThan(t.unverified_verify_failed_run_count);
  });

  it("classifies a pre-#327 row with no reason from completed and verified", () => {
    // null reason means "not recorded" — never a claim about the run. Both
    // legacy rows must land in the same buckets as their reason-bearing twins,
    // or the split silently under-counts every run written before today.
    const t = totals();
    expect(t.unverified_turn_cap_run_count).toBe(3);      // 601, 607 (reason) + 604 (inferred)
    expect(t.unverified_verify_failed_run_count).toBe(2); // 602 (reason) + 603 (inferred)
  });

  it("trusts reason over the old predicate when the two disagree", () => {
    // author:606 is completed:false, verified:null with an unrecognized reason.
    // The old predicate would bucket it turn-cap; reading `reason` makes it
    // "other". So this fails if the code infers instead of reading — and unlike
    // the row it replaced, this shape is one the writer can actually emit.
    const t = totals();
    expect(t.unverified_other_run_count).toBe(1);
    expect(t.unverified_run_count).toBe(6);
  });

  it("does not silently treat an unrecognized reason as success", () => {
    // A value the bridge adds later (say "error") must not read as "fine".
    // Anything that is not "ok" did not succeed.
    const s = sess();
    expect(s.unverified_input).toBe(UNVERIFIED_IN);
  });

  it("excludes a review row that ran out of turns, not just a passing one", () => {
    // review:601 carries reason "turn-cap" — the shape that discriminates. A
    // review row whose reason is "ok" cannot catch a classifier that checks
    // `reason` BEFORE the review guard, because "ok" returns null either way.
    // Production writes this row: review runs go through the same run_agent,
    // and review rows already carry a reason today.
    const s = sess();
    expect(s.review_run_count).toBe(2);
    expect(s.unverified_run_count).toBe(6);
    expect(s.unverified_input).toBe(UNVERIFIED_IN);
    const t = totals();
    expect(t.unverified_turn_cap_run_count).toBe(3);
  });

  it("shows the split, with counts, in the text report", () => {
    // Asserting only that the words "turn cap" and "verify" appear would pass
    // against the old single-number line, which already said both in its
    // footnote prose. The counts are the thing that is new.
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false }));
    expect(text).toContain("turn cap 3");
    expect(text).toContain("verify failed 2");
    expect(text).toContain("unrecognized reason 1");
  });

  it("includes per-kind token counts in the text split line", () => {
    // #34 item 4: per-kind tokens through tallyKinds. The turn-cap runs burn
    // the full cap by construction, so one turn-cap run among three failures
    // should own most of the tokens. A wrong number here misleads in a
    // specific, predictable direction.
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false }));
    // turn-cap runs: 601 (20000/2000), 604 (50000/5000), 607 (11000/1100)
    // total turn-cap input: 81000
    expect(text).toMatch(/turn cap 3 \(in=81,000\)/);
    // verify-failed runs: 602 (30000/3000), 603 (40000/4000)
    // total verify-failed input: 70000
    expect(text).toMatch(/verify failed 2 \(in=70,000\)/);
  });

  it("omits the split on a ledger where no authoring run failed", () => {
    // runs-labelled.jsonl does contain two failed rows, but both are review —
    // excluded by construction. The name has to say "authoring" or it claims a
    // property of the fixture that is not true.
    const clean = new URL("./fixtures/ledger/runs-labelled.jsonl", import.meta.url).pathname;
    const t = totals({ ledgerPath: clean });
    expect(t.unverified_turn_cap_run_count).toBeUndefined();
    expect(t.unverified_verify_failed_run_count).toBeUndefined();
    expect(t.unverified_other_run_count).toBeUndefined();
  });

  it("collects distinct unknown reason strings in unverified_other_reasons", () => {
    // #34 item 3: the field whose entire purpose is telling a reader which
    // unknown string appeared, so a classification regression is distinguishable
    // from a workload change. Mutating the field away must fail this test.
    const t = totals();
    expect(t.unverified_other_reasons).toEqual(["killed"]);
  });

  it("omits zero-count kinds from the text split line", () => {
    // #34 item 7: no fixture exercises a ledger with turn-cap failures and no
    // verify failures (or the reverse), so the per-part filter in the text split
    // line never runs. This is the shape production hits first.
    const tcOnly = new URL("./fixtures/ledger/runs-tc-only.jsonl", import.meta.url).pathname;
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false, ledgerPath: tcOnly }));
    expect(text).toMatch(/turn cap 2 \(in=30,000\)/);
    expect(text).not.toContain("verify failed 0");
    expect(text).not.toContain("unrecognized reason 0");
  });
});

describe("renderSavingsReport — the footnote does not claim coverage it lacks", () => {
  it("does not say crashed runs are among the ones it counted", () => {
    // A crash never reaches the ledger write (nhangen/claude-ceo#328), so the
    // report cannot have counted one. Saying it did tells a reader the failed
    // total is complete when it is not.
    const text = capture(() => renderSavingsReport(reader, { ...base, json: false }));
    expect(text).not.toContain("crashed or hit the turn cap");
    expect(text).toContain("is not in the ledger at all");
  });
});

describe("renderSavingsReport — conflict kind (#64)", () => {
  function sessConflict(opts: Record<string, unknown> = {}): any {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...baseWithConflict, ...opts })));
    return p.sessions.find((x: any) => x.session_id === "sess-spend");
  }
  function totalsConflict(opts: Record<string, unknown> = {}): any {
    return JSON.parse(capture(() => renderSavingsReport(reader, { ...baseWithConflict, ...opts }))).totals;
  }

  it("classifies reason:ok with completed:false as conflict", () => {
    // author:608: reason:"ok", completed:false, verified:null — the bridge bug
    // where reason was assigned before the verify block ran. completed:false
    // makes this a real contradiction regardless of verified state.
    const t = totalsConflict();
    expect(t.unverified_conflict_run_count).toBe(1);
  });

  it("does NOT classify completed:true, verified:null as conflict (#73)", () => {
    // author:609: reason:"ok", completed:true, verified:null — this is the
    // NORMAL success shape when verify_cmd is unset. The bridge never sets
    // verified on such runs. Treating it as a conflict over-reports failures.
    const t = totalsConflict();
    expect(t.unverified_conflict_run_count).toBe(1);
    // author:609 must not be in the unverified count
    expect(t.unverified_run_count).toBe(7);
  });

  it("does not count conflict rows as turn-cap or verify-failed", () => {
    const t = totalsConflict();
    expect(t.unverified_turn_cap_run_count).toBe(3);
    expect(t.unverified_verify_failed_run_count).toBe(2);
    expect(t.unverified_conflict_run_count).toBe(1);
  });

  it("shows conflict in the text report", () => {
    const text = capture(() => renderSavingsReport(reader, { ...baseWithConflict, json: false }));
    expect(text).toContain("conflict 1");
  });

  it("conflict guard catches completed:false but not verified:null alone", () => {
    // Regression for #73: the guard must NOT treat verified:null as a conflict
    // when completed:true — that's the normal unverified success shape.
    const t = totalsConflict();
    // 7 unverified: 601,602,603,604,606,607 (turn-cap/verify-failed/other) + 608 (conflict)
    // author:609 (completed:true, verified:null) is NOT unverified
    expect(t.unverified_run_count).toBe(7);
  });
});

describe("renderSavingsReport — Input priced with unattributed sessions (#67)", () => {
  const LEDGER_UNATTRIBUTED = new URL("./fixtures/ledger-conflict/runs-unattributed.jsonl", import.meta.url).pathname;
  const baseUnattributed = {
    since: 0, sinceStr: "all", json: false,
    ledgerPath: LEDGER_UNATTRIBUTED, counterfactualModel: DEFAULT_COUNTERFACTUAL_MODEL,
  };

  it("prints ledger-wide values when no sessions are attributed", () => {
    // On a ledger with zero attributed sessions and non-zero cache-split input,
    // the "Input priced" line must show the actual ledger-wide values, not zeros.
    // Before #67, the values came from attributedGroups (empty), printing
    // "0 fresh + 0 re-read" beside a non-zero counterfactual.
    const text = capture(() => renderSavingsReport(reader, baseUnattributed));
    expect(text).toContain("Input priced");
    expect(text).not.toContain("0 fresh + 0 re-read");
  });

  it("shows non-zero token counts in the Input priced line", () => {
    const text = capture(() => renderSavingsReport(reader, baseUnattributed));
    // 100k input with 40 turns → most is cache-read. The line should show
    // actual token counts, not zeros.
    expect(text).toMatch(/Input priced.*\d.*fresh \+ \d.*re-read/);
  });
});
