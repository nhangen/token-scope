import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { renderSavingsReport, DEFAULT_COUNTERFACTUAL_MODEL } from "@/reports/savings";
import { getPricing } from "@/pricing";

const SPEND_DIR = new URL("./fixtures/spend-projects", import.meta.url).pathname;
const LEDGER = new URL("./fixtures/ledger/runs-cache.jsonl", import.meta.url).pathname;

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

// ollama has no prompt cache, so an agentic run re-sends its whole prefix every
// turn and the ledger's ollama_input_tokens is the SUM of those re-sends. Claude
// would have paid full input price for each token exactly once — on the turn it
// first appeared — and cache-read price for every later re-send.
//
// So the uncached share is the FINAL prefix, not "the first turn": each token is
// new once, and the per-turn deltas telescope to the last prefix. Under linear
// prefix growth that is 2/(t+1) of the recorded total, which is what the code
// uses. A `turns` of 1 or null is entirely uncached — one pass, nothing re-read.
//
// Fixture (authoring rows only; review:700 is excluded from the counterfactual
// and is present precisely to prove the split does not leak into it):
//   author:700  100000 in  turns=1     -> 100% uncached
//   author:701  300000 in  turns=3     -> 2/4 = 150000 uncached, 150000 cached
//   author:702  100000 in  turns=null  -> 100% uncached (unknown, priced high)
const P = getPricing(DEFAULT_COUNTERFACTUAL_MODEL)!;
const payload = () => JSON.parse(capture(() => renderSavingsReport(reader, base)));
const totals = () => payload().totals;
// `totals.counterfactual_usd` is the ATTRIBUTED rollup and is null when no session
// has a matching PM spend record, as here. The per-session figure is always
// computed, so the pricing assertions read that.
const sess = () => payload().sessions[0];

describe("counterfactual prices re-read input at the cache-read rate (#465)", () => {
  it("splits a multi-turn run's input into uncached and cached", () => {
    const t = sess();
    expect(t.counterfactual_uncached_input).toBe(100000 + 150000 + 100000);
    expect(t.counterfactual_cached_input).toBe(150000);
  });

  it("prices the cached half at cache-read, not full input", () => {
    const t = totals();
    const expected =
      (350000 * P.inputPerMillion + 150000 * P.cacheReadPerMillion + 30000 * P.outputPerMillion) / 1e6;
    expect(sess().counterfactual_usd).toBeCloseTo(expected, 6);
  });

  it("is strictly cheaper than pricing every input token as fresh", () => {
    const cf = sess().counterfactual_usd;
    const naive = (500000 * P.inputPerMillion + 30000 * P.outputPerMillion) / 1e6;
    expect(cf).toBeLessThan(naive);
    // Guard the direction AND the size: a split that rounded to nothing would
    // still pass `toBeLessThan`.
    expect(naive - cf).toBeCloseTo(
      150000 * (P.inputPerMillion - P.cacheReadPerMillion) / 1e6, 6);
  });

  it("treats turns=1 and turns=null as fully uncached", () => {
    // Exact, not a floor. `>= 200000` would also hold if turns:null were treated as
    // fully CACHED, since author:701 alone contributes 150,000 uncached — so the
    // loose form passes under the mutation it exists to catch.
    // author:700 (turns=1) + author:702 (turns=null) = 200,000, and author:701
    // contributes exactly half of 300,000. Anything else moves this number.
    const t = sess();
    expect(t.counterfactual_uncached_input).toBe(350000);
    expect(t.counterfactual_cached_input).toBe(150000);
  });

  it("does not apply the split to review rows", () => {
    // review:700 is 900000 input over 9 turns — nine times the authoring volume.
    // If it leaked in, both split keys would jump by six figures.
    const t = sess();
    expect(t.counterfactual_uncached_input + t.counterfactual_cached_input).toBe(500000);
  });
});
