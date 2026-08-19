import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = new URL("./fixtures/ledger", import.meta.url).pathname;

// A ledger fixture row must be a row the writer can actually produce. Traced
// against `ollama_agent/agent.py` in nhangen/claude-ceo, the reachable
// (reason, completed, verified) set is exactly:
//
//   reason "ok"            -> completed true,  verified true or null
//   reason "turn-cap"      -> completed false, verified null
//   reason "verify-failed" -> completed false, verified false
//   reason absent (legacy) -> the same four (completed, verified) pairs
//
// `reason = "ok"` is assigned at exactly two sites and both set completed=True
// in the same block; everything else falls through to the post-loop assignment
// where completed is False. So `completed:true, verified:false` is unreachable,
// and so is any reason value sitting on `completed:true, verified:true` — that
// pair IS the branch that hardcodes "ok".
//
// Why this test exists rather than a note somewhere: a fixture encoding a shape
// production never emits makes a predicate look covered against inputs that
// cannot occur. That is the defect the `reason` axis was filed about
// (nhangen/token-scope#31), and a panel then found the same defect in the
// fixture written to fix it. Catching it needed a reviewer tracing Python; it
// should cost a test run.
const KNOWN_REASON: Record<string, string[]> = {
  "ok": ["true|true", "true|null"],
  "turn-cap": ["false|null"],
  "verify-failed": ["false|false"],
};

// The (completed, verified) pairs the loop can produce at all, whatever the
// reason. `true|false` is absent: verified is only ever set true immediately
// before a break, and both breaks set completed true in the same block.
const REACHABLE_PAIRS = ["true|true", "true|null", "false|false", "false|null"];

// An UNKNOWN reason is not a violation — the bridge is expected to grow new
// termination causes, and a fixture probing one is the right instinct. What it
// may not do is sit on a pair that contradicts it. `true|true` is the branch
// that hardcodes "ok", so no other value can ever appear there.
const UNKNOWN_REASON_FORBIDDEN_PAIRS = ["true|true", "true|false"];

function violation(reason: string, pair: string): string | null {
  if (!REACHABLE_PAIRS.includes(pair)) return `pair ${pair} is unreachable`;
  if (reason === "null") return null;              // legacy row, any reachable pair
  const allowed = KNOWN_REASON[reason];
  if (allowed) {
    return allowed.includes(pair) ? null : `reason "${reason}" cannot pair with ${pair}`;
  }
  return UNKNOWN_REASON_FORBIDDEN_PAIRS.includes(pair)
    ? `unknown reason "${reason}" cannot pair with ${pair} (that pair hardcodes "ok")`
    : null;
}

// Rows that predate the invariant. Each is `completed:true, verified:false` —
// one single unreachable shape, reached for by several fixtures independently,
// which is what makes it worth gating rather than fixing case by case. Tracked
// as nhangen/token-scope#33; this list may shrink and must never grow.
const GRANDFATHERED = new Set([
  'runs-bench.jsonl:4', 'runs-failed.jsonl:3',
  'runs-labelled.jsonl:2', 'runs-labelled.jsonl:3',
  'runs-unverified.jsonl:2', 'runs-unverified.jsonl:4',
  'runs.jsonl:2',
]);

function shapesIn(file: string): { loc: string; shape: string }[] {
  const out: { loc: string; shape: string }[] = [];
  const text = readFileSync(join(DIR, file), "utf8");
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { return; }  // malformed-line fixtures are their own test's business
    const v = (k: string) => (row[k] === undefined ? "null" : String(row[k]));
    out.push({ loc: `${file}:${i + 1}`, shape: `${v("reason")}|${v("completed")}|${v("verified")}` });
  });
  return out;
}

describe("ledger fixtures encode only rows the bridge can emit", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));

  it("finds fixture files to check", () => {
    // Guards the guard: a rename of the fixture dir would otherwise make this
    // whole suite pass by checking nothing.
    expect(files.length).toBeGreaterThan(3);
  });

  it("every row is a reachable (reason, completed, verified) combination", () => {
    const violations = files
      .flatMap(shapesIn)
      .filter((r) => !GRANDFATHERED.has(r.loc))
      .map((r) => {
        const [reason, ...rest] = r.shape.split("|");
        const why = violation(reason!, rest.join("|"));
        return why === null ? null : `${r.loc} -> ${r.shape} (${why})`;
      })
      .filter((x): x is string => x !== null);
    expect(violations).toEqual([]);
  });

  it("no grandfathered entry names a row that is now fine, or a row that is gone", () => {
    // Keeps the allowlist honest in both directions: a fixed row must be struck
    // from the list rather than left to cover a future regression at the same
    // path, and a stale entry must not linger after a fixture is deleted.
    const all = new Map(files.flatMap(shapesIn).map((r) => [r.loc, r.shape]));
    for (const loc of GRANDFATHERED) {
      const shape = all.get(loc);
      expect(shape, `${loc} is grandfathered but no longer exists`).toBeDefined();
      const [reason, ...rest] = shape!.split("|");
      expect(violation(reason!, rest.join("|")), `${loc} is emittable now — remove it from GRANDFATHERED`).not.toBeNull();
    }
  });
});
