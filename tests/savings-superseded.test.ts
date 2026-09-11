import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { renderSavingsReport, DEFAULT_COUNTERFACTUAL_MODEL } from "@/reports/savings";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SPEND_DIR = new URL("./fixtures/spend-projects", import.meta.url).pathname;
const LEDGER = new URL("./fixtures/ledger/runs-superseded.jsonl", import.meta.url).pathname;
const ESCALATIONS = new URL("./fixtures/escalations/escalations.jsonl", import.meta.url).pathname;
const NO_ESCALATIONS = new URL("./fixtures/escalations/does-not-exist.jsonl", import.meta.url).pathname;

const EMPTY_DIR = mkdtempSync(join(tmpdir(), "ts-savings-empty-"));

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
const withEsc = { ...base, escalationsPath: ESCALATIONS };
const withoutEsc = { ...base, escalationsPath: NO_ESCALATIONS };

// The ledger fixture's seven rows, against three escalation records all stamped
// 2026-07-08T11:00:00Z (epoch 1783508400), i.e. a window of 07:00..11:00:
//
//   author:600  09:00  /w/600   100000/40000  ok        no escalation           -> kept
//   author:601  09:00  /w/601    20000/ 5000  turn-cap  in window, cwd matches  -> SUPERSEDED
//   author:601  10:00  /w/601    24000/ 6000  turn-cap  in window, cwd matches  -> SUPERSEDED
//   author:601  07-06  /w/601     9000/  900  turn-cap  two days early          -> kept (unverified)
//   author:602  09:00  /w/other   7000/  700  turn-cap  escalation cwd is /w/602-> kept (unverified)
//   author:603  09:00  /w/603     5000/  500  ok        escalation exists       -> kept (it succeeded)
//   author:601  12:00  /w/601     6000/  600  turn-cap  after the escalation    -> kept (unverified)
const SUPERSEDED_IN = 20000 + 24000;   // 44000
const SUPERSEDED_OUT = 5000 + 6000;    // 11000
const UNVERIFIED_IN = 9000 + 7000 + 6000;  // 22000 — turn-cap rows that were NOT superseded
const UNVERIFIED_OUT = 900 + 700 + 600;    //  2200
const TOTAL_IN = 100000 + 20000 + 24000 + 9000 + 7000 + 5000 + 6000;  // 171000
const TOTAL_OUT = 40000 + 5000 + 6000 + 900 + 700 + 500 + 600;        //  53700

describe("renderSavingsReport — superseded (escalated) runs", () => {
  it("counts the two in-window same-cwd turn-cap runs as superseded", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    const s = p.sessions.find((x: any) => x.session_id === "sess-spend");
    expect(s.superseded_run_count).toBe(2);
    expect(s.superseded_input).toBe(SUPERSEDED_IN);
    expect(s.superseded_output).toBe(SUPERSEDED_OUT);
    expect(p.totals.superseded_run_count).toBe(2);
    expect(p.totals.superseded_input).toBe(SUPERSEDED_IN);
    expect(p.totals.superseded_output).toBe(SUPERSEDED_OUT);
  });

  it("does not supersede a run outside the attempt window", () => {
    // author:601 at 2026-07-06 predates the escalation by two days. The wrapper's
    // cap only looks back OLLAMA_ATTEMPT_GAP; a run older than that belongs to an
    // earlier, separately-resolved cycle and was not redone by this escalation.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    expect(p.totals.superseded_input).toBe(SUPERSEDED_IN);
    expect(p.totals.unverified_input).toBe(UNVERIFIED_IN);
  });

  it("does not supersede a run in a different worktree", () => {
    // author:602's escalation names /w/602; the ledger row ran in /w/other. The
    // label alone is not an identity — it is a ticket number and is reused.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    const kinds = p.totals.unverified_turn_cap_run_count;
    expect(kinds).toBe(3);
  });

  it("does not supersede a run that succeeded", () => {
    // author:603 has an escalation in window with a matching cwd, but the run
    // itself completed and verified. An escalation names the failed attempts it
    // replaced; excluding a successful run would delete real saved work.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    expect(p.totals.superseded_run_count).toBe(2);
  });

  it("keeps superseded volume in the totals so no spend is hidden", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    expect(p.totals.ollama_input).toBe(TOTAL_IN);
    expect(p.totals.ollama_output).toBe(TOTAL_OUT);
  });

  it("does not double-count a superseded run as unverified", () => {
    // Unverified rows stay IN the counterfactual and are footnoted as a share of
    // it. A superseded row is OUT of it. Leaving it in both makes the footnote a
    // percentage of a figure it is not part of.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    expect(p.totals.unverified_run_count).toBe(3);
    expect(p.totals.unverified_input).toBe(UNVERIFIED_IN);
    expect(p.totals.unverified_output).toBe(UNVERIFIED_OUT);
  });

  it("drops the superseded volume out of the counterfactual", () => {
    const withP = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    const withoutP = JSON.parse(capture(() => renderSavingsReport(reader, withoutEsc)));
    expect(withP.totals.counterfactual_usd).toBeLessThan(withoutP.totals.counterfactual_usd);
    // The drop is exactly the priced value the report says it removed.
    const drop = withoutP.totals.counterfactual_usd - withP.totals.counterfactual_usd;
    expect(drop).toBeCloseTo(withP.totals.superseded_excluded_usd, 10);
    expect(withP.totals.superseded_excluded_usd).toBeGreaterThan(0);
  });

  it("treats a missing escalations file as no escalations", () => {
    // The axis keys follow the house convention: present on every row or on
    // none, so a ledger nothing superseded reports byte-identically to before.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withoutEsc)));
    expect(p.totals.superseded_run_count).toBeUndefined();
    expect(p.totals.escalations_path).toBeUndefined();
    expect(p.totals.unverified_run_count).toBe(5);
    expect(p.totals.ollama_input).toBe(TOTAL_IN);
  });

  it("skips a malformed escalation line and one with no superseded_run_id", () => {
    // The fixture leads with an unparseable line and ends with a record naming no
    // run. Neither may match anything, and the bad first line may not cost the
    // three good records that follow it.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    expect(p.totals.superseded_run_count).toBe(2);
  });

  it("footnotes the exclusion in text mode", () => {
    const out = capture(() => renderSavingsReport(reader, { ...withEsc, json: false }));
    expect(out).toContain("escalat");
    expect(out).toMatch(/2 authoring run\(s\)/);
    expect(out).toContain("superseded_run_id");
    // The Totals row, not only the footnote: the footnote explains a number the
    // reader has to be able to find in the table above it.
    expect(out).toContain("Superseded by an escalation (excluded from counterfactual)");
    expect(out).toMatch(/Superseded by an escalation[^\n]*44,000/);
  });

  it("says nothing about supersession when there is none", () => {
    const out = capture(() => renderSavingsReport(reader, { ...withoutEsc, json: false }));
    // Not the bare word: the ledger fixture's own filename carries it.
    expect(out).not.toContain("superseded_run_id");
    expect(out).not.toContain("Superseded by an escalation");
  });

  it("does not claim a $0.0000 removal when nothing is attributed", () => {
    // The removed figure is summed over attributed groups, to match the
    // counterfactual it is a subtraction from. With no attributed session that
    // sum is an empty 0, and printing it says the exclusion changed nothing at
    // exactly the moment it cannot be checked.
    const empty = createReader({ source: "jsonl", projectsDirs: [EMPTY_DIR] });
    try {
      const p = JSON.parse(capture(() => renderSavingsReport(empty, withEsc)));
      expect(p.totals.counterfactual_usd).toBeNull();
      expect(p.totals.superseded_run_count).toBe(2);
      expect(p.totals.superseded_excluded_usd).toBeNull();
      const out = capture(() => renderSavingsReport(empty, { ...withEsc, json: false }));
      expect(out).toContain("Superseded by an escalation");
      expect(out).not.toContain("Excluding them removed");
    } finally { empty.close(); }
  });

  it("breaks superseded runs out by label", () => {
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...withEsc, byLabel: true })));
    const l601 = p.by_label.find((x: any) => x.label === "601");
    expect(l601.superseded_run_count).toBe(2);
    expect(l601.superseded_input).toBe(SUPERSEDED_IN);
    // ...and out of that label's authoring volume, or by_label's own
    // counterfactual prices the rows the session-level one just dropped.
    expect(l601.author_input).toBe(9000 + 6000);
    expect(l601.author_output).toBe(900 + 600);
    const l600 = p.by_label.find((x: any) => x.label === "600");
    expect(l600.superseded_run_count).toBe(0);
  });
});
