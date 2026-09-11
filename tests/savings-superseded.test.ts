import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { renderSavingsReport, DEFAULT_COUNTERFACTUAL_MODEL } from "@/reports/savings";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SPEND_DIR = new URL("./fixtures/spend-projects", import.meta.url).pathname;
const LEDGER = new URL("./fixtures/ledger/runs-superseded.jsonl", import.meta.url).pathname;
const ESCALATIONS = new URL("./fixtures/escalations/escalations.jsonl", import.meta.url).pathname;
const NO_ESCALATIONS = new URL("./fixtures/escalations/does-not-exist.jsonl", import.meta.url).pathname;

const EMPTY_DIR = mkdtempSync(join(tmpdir(), "ts-savings-empty-"));
const EDGE_LEDGER = new URL("./fixtures/ledger/runs-superseded-edges.jsonl", import.meta.url).pathname;
const EDGE_ESC = new URL("./fixtures/escalations/escalations-edges.jsonl", import.meta.url).pathname;
const UNATTR_LEDGER = new URL("./fixtures/ledger/runs-superseded-unattr.jsonl", import.meta.url).pathname;

let reader: Reader;
// resolveAttemptGapSeconds reads live process.env at render time, so the window
// these fixtures are built against is a third input the fixtures do not pin.
// Exporting OLLAMA_ATTEMPT_GAP=200000 turned 9 of 13 of these red on correct code.
let savedGap: string | undefined;
beforeAll(() => {
  savedGap = process.env["OLLAMA_ATTEMPT_GAP"];
  delete process.env["OLLAMA_ATTEMPT_GAP"];
  reader = createReader({ source: "jsonl", projectsDirs: [SPEND_DIR] });
});
afterAll(() => {
  reader.close();
  if (savedGap === undefined) delete process.env["OLLAMA_ATTEMPT_GAP"];
  else process.env["OLLAMA_ATTEMPT_GAP"] = savedGap;
});

function capErr(fn: () => void): string {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { fn(); } finally { process.stderr.write = orig; }
  return lines.join("");
}

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
// sinceStr "30d" means no floor is applied, which this fixture needs: a --since
// floor drops undatable rows from the report entirely (#50), and one of these
// rows exists to prove an undatable run STAYS in the counterfactual.
const edge = {
  ...base, sinceStr: "30d", ledgerPath: EDGE_LEDGER, escalationsPath: EDGE_ESC, byLabel: true,
};
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
    expect(p.escalations_path).toBe(ESCALATIONS);
    expect(p.escalations_status).toBe("ok");
    expect(p.attempt_gap_seconds).toBe(14400);
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
    const p = JSON.parse(capture(() => renderSavingsReport(reader, { ...withEsc, byLabel: true })));
    expect(p.totals.superseded_run_count).toBe(2);
    // Name the row, or the arm is a copy of the previous assertion and deleting
    // author:603 from the fixture costs it nothing.
    const l603 = p.by_label.find((x: any) => x.label === "603");
    expect(l603.superseded_run_count).toBe(0);
    expect(l603.author_input).toBe(5000);
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
    expect(p.totals.unverified_run_count).toBe(5);
    // escalations_path is top-level beside ledger_path, NOT inside totals, and it
    // is emitted even here — naming the sidecar that was consulted and came back
    // empty is the only thing separating "nothing was superseded" from "the file
    // was not there". An earlier version of this arm read p.totals.escalations_path,
    // a key that is undefined in both branches, so it passed with the whole spread
    // deleted.
    expect(p.escalations_path).toBe(NO_ESCALATIONS);
    expect(p.escalations_status).toBe("absent");
    expect(p.attempt_gap_seconds).toBe(14400);
    expect(p.totals.ollama_input).toBe(TOTAL_IN);
  });

  it("skips a malformed escalation line and one with no superseded_run_id", () => {
    // The fixture leads with an unparseable line and ends with a record naming no
    // run. The parse itself is asserted in escalations.test.ts, where deleting
    // either line actually fails; here the point is that the report SAYS so
    // rather than absorbing the loss into a smaller exclusion.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    expect(p.totals.superseded_run_count).toBe(2);
    expect(p.escalations_records).toBe(3);
    expect(p.escalations_skipped_lines).toBe(2);
    const out = capture(() => renderSavingsReport(reader, { ...withEsc, json: false }));
    expect(out).toMatch(/2 line\(s\) in .* yielded no record/);
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

  it("nulls the removed figure when superseded runs are all unattributed", () => {
    // The guard used to ask whether ANY group was attributed, not whether any
    // SUPERSEDED volume was. With one attributed session that superseded nothing
    // and the superseded runs sitting in the unattributed bucket, the sum over
    // attributed groups is an empty 0 and the footnote printed the confident
    // "Excluding them removed $0.0000" the comment one line above forbids.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    expect(p.totals.counterfactual_usd).not.toBeNull();
    const unattributed = { ...withEsc, ledgerPath: UNATTR_LEDGER };
    const q = JSON.parse(capture(() => renderSavingsReport(reader, unattributed)));
    expect(q.totals.superseded_run_count).toBe(2);
    expect(q.totals.superseded_excluded_usd).toBeNull();
    const out = capture(() => renderSavingsReport(reader, { ...unattributed, json: false }));
    expect(out).toContain("Superseded by an escalation");
    expect(out).not.toContain("Excluding them removed");
  });

  it("counts escalation records that name no run in the ledger", () => {
    // cwd equality is the strictest of the four conditions and the likeliest to
    // drift — a renamed worktree breaks every record naming it, forever and
    // invisibly, and the double-count comes back with no footnote. Counting is
    // what `undatableRuns` already does for the same reason.
    //
    // 703 (no cwd), 704 (empty cwd) and 705 (no such run) name nothing. 700
    // matched. 701 names a real run that is merely undatable, so it found its
    // run and is NOT counted — see the next arm.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, edge)));
    expect(p.escalations_records).toBe(5);
    expect(p.escalations_skipped_lines).toBe(1);
    expect(p.escalations_unmatched).toBe(3);
    const out = capture(() => renderSavingsReport(reader, { ...edge, json: false }));
    expect(out).toMatch(/3 of 5 escalation record\(s\) name a run that is not in this ledger/);
  });

  it("does not count a record whose run is present but ineligible", () => {
    // The counter exists to catch cwd drift. A record naming a run that SUCCEEDED
    // is doing its job by not firing, and one naming an undatable run is the
    // documented conservative case — counting either fires the drift warning on
    // the design working as intended. On the canonical fixture that was 2 of 3.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    // 601 matched; 603 names a run that succeeded; only 602 (worktree drift) is
    // genuinely naming nothing.
    expect(p.escalations_unmatched).toBe(1);
  });

  it("does not warn about unmatched records on a scoped report", () => {
    // --session and --since filter the runs before the matcher sees them, so a
    // scoped report leaves most records naming nothing by construction.
    const out = capture(() => renderSavingsReport(reader, { ...edge, json: false, sessionId: "sess-spend" }));
    expect(out).not.toMatch(/name a run that is not in this ledger/);
  });

  it("includes both window boundaries and excludes one second past", () => {
    // 07:00:00 is exactly epoch-gap and 11:00:00 is exactly epoch; 06:59:59 is one
    // second outside. Without a row on each edge the window SIZE is unpinned —
    // 14400 could be anything in [7200, 180000) and the suite stays green.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, edge)));
    expect(p.totals.superseded_run_count).toBe(2);
    expect(p.totals.superseded_input).toBe(1000 + 2000);
  });

  it("leaves an undatable run in the counterfactual", () => {
    // README ships this as a guarantee. A run with no timestamp cannot be placed
    // in the window, and over-stating the saving beats inventing an exclusion.
    const p = JSON.parse(capture(() => renderSavingsReport(reader, edge)));
    const l701 = p.by_label.find((x: any) => x.label === "701");
    expect(l701.superseded_run_count).toBe(0);
    expect(l701.author_input).toBe(8000);
  });

  it("never supersedes on a record with no epoch, no cwd, or an empty cwd", () => {
    // 702 has no epoch, 703 no cwd, 704 an empty cwd matching a legacy ledger row
    // whose own cwd is "". Each guard's absence widens a record into "supersedes
    // every run with this label".
    const p = JSON.parse(capture(() => renderSavingsReport(reader, edge)));
    for (const label of ["702", "703", "704"]) {
      const row = p.by_label.find((x: any) => x.label === label);
      expect(row.superseded_run_count).toBe(0);
    }
  });

  it("warns when an explicitly-named sidecar is not there", () => {
    const err = capErr(() => renderSavingsReport(reader, { ...withoutEsc, json: false }));
    expect(err).toContain("does-not-exist.jsonl");
  });

  it("discloses the ledger's own load status, not just the sidecar's", () => {
    // Five fields about the sidecar and none about the ledger reads as an
    // integrity claim about the whole report, while the PRIMARY source can fail
    // to load and render a confident zero.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), "ts-savings-badledger-"));
    const lp = join(dir, "runs.jsonl");
    writeFileSync(lp, '{"run_id":"author:1","ollama_input_tokens":1}\n');
    chmodSync(lp, 0o000);
    try {
      let out = "";
      const err = capErr(() => { out = capture(() => renderSavingsReport(reader, { ...base, ledgerPath: lp })); });
      expect(err).toContain("could not read");
      expect(JSON.parse(out).ledger_status).toBe("unreadable");
    } finally { chmodSync(lp, 0o600); }
    const ok = JSON.parse(capture(() => renderSavingsReport(reader, withEsc)));
    expect(ok.ledger_status).toBe("ok");
  });

  it("warns when the sidecar is there and cannot be read", () => {
    // The loudest case, and the one with no benign reading: the file exists, so
    // this is not "you never delegated" — it is a subtraction that did not happen.
    // chmod 000 does not stop root, so this would false-pass in a root container.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), "ts-savings-unreadable-"));
    const p = join(dir, "escalations.jsonl");
    writeFileSync(p, '{"epoch":1783508400,"superseded_run_id":"author:601","cwd":"/w/601"}\n');
    chmodSync(p, 0o000);
    try {
      const err = capErr(() => renderSavingsReport(reader, { ...base, escalationsPath: p, json: false }));
      expect(err).toContain("could not read");
      expect(err).toContain(p);
      // Both renders warn; capturing only the first leaks the second into the
      // suite's own output.
      let out = "";
      capErr(() => { out = capture(() => renderSavingsReport(reader, { ...base, escalationsPath: p })); });
      expect(JSON.parse(out).escalations_status).toBe("unreadable");
    } finally { chmodSync(p, 0o600); }
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

// Production entry point: parseArgs tests prove the flag is read into args, not
// that main() ever hands it to the report. A dropped assignment between the two
// typechecks clean, and the whole feature would be inert.
describe("--escalations end to end", () => {
  const ROOT = join(new URL(".", import.meta.url).pathname, "..");
  const CLI = join(ROOT, "src", "cli.ts");

  function run(extra: string[]) {
    const proc = Bun.spawnSync(["bun", CLI, "--savings", "--ledger", LEDGER, ...extra], {
      cwd: ROOT,
      env: { ...process.env, OLLAMA_ATTEMPT_GAP: "", OLLAMA_AGENT_ESCALATIONS: "" },
      stdout: "pipe", stderr: "pipe",
    });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  }

  it("excludes superseded runs when run as a command", () => {
    const r = run(["--escalations", ESCALATIONS, "--json"]);
    expect(r.code).toBe(0);
    const p = JSON.parse(r.out);
    expect(p.escalations_path).toBe(ESCALATIONS);
    expect(p.totals.superseded_run_count).toBe(2);
    expect(p.totals.superseded_input).toBe(SUPERSEDED_IN);
  });

  it("excludes nothing, and says why, without the flag", () => {
    const r = run(["--json"]);
    expect(r.code).toBe(0);
    const p = JSON.parse(r.out);
    expect(p.totals.superseded_run_count).toBeUndefined();
    expect(p.escalations_status).toBe("absent");
  });
});
