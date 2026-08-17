import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_WEEKLY_CAP } from "@/credits";

const worker = new URL("../hooks/cost-alert-worker.ts", import.meta.url).pathname;
const transcript = new URL("./fixtures/hook/sess-hook.jsonl", import.meta.url).pathname;

// The fixture is one opus response (20,000 output tokens = $1.50) written as
// three content-block entries, each repeating the same usage object. The worker
// must bill it once, or every threshold in it fires at a third of the real spend.
/**
 * argv: <transcript> <checkpointDir> <cap> [turns] [checkpointPct] [turnWarnPct]
 *
 * Trailing options are OMITTED when not given, so the worker's own defaults
 * apply. Substituting a value here instead — which the first version of this
 * helper did — means no test ever exercises the shipped default, and that is
 * precisely how a threshold that could never fire got shipped.
 */
function spawn(t: string, cap: string, opts: { turns?: string; pct?: string; warn?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ts-hook-"));
  const argv = ["bun", worker, t, dir, cap];
  if (opts.turns !== undefined || opts.pct !== undefined || opts.warn !== undefined) argv.push(opts.turns ?? "50");
  if (opts.pct !== undefined || opts.warn !== undefined) argv.push(opts.pct ?? "25");
  if (opts.warn !== undefined) argv.push(opts.warn);
  const proc = Bun.spawnSync(argv);
  return { dir, proc, stdout: proc.stdout.toString().trim(), stderr: proc.stderr.toString() };
}

function statusMessage(t: string, cap: string, opts: { turns?: string; pct?: string; warn?: string } = {}): string {
  const { proc, stdout } = spawn(t, cap, opts);
  expect(proc.exitCode).toBe(0);
  return (JSON.parse(stdout) as { statusMessage?: string }).statusMessage ?? "";
}

function run(): { turns: number; credits: number; capPct: number; cost: number; body: string } {
  // cap 100 credits => the 20,000-credit fixture is far past every rung, so the
  // checkpoint is guaranteed and the frontmatter is readable.
  const { dir, proc } = spawn(transcript, "100");
  expect(proc.exitCode).toBe(0);
  const files = readdirSync(dir);
  expect(files).toEqual(["sess-hook.md"]);
  const body = readFileSync(join(dir, files[0]!), "utf8");
  return {
    turns: Number(/^turns: (\d+)$/m.exec(body)![1]),
    credits: Number(/^credits: ([\d.]+)$/m.exec(body)![1]),
    capPct: Number(/^cap_pct: ([\d.]+)$/m.exec(body)![1]),
    cost: Number(/^cost: ([\d.]+)$/m.exec(body)![1]),
    body,
  };
}

describe("cost-alert-worker — one turn per API response (#19)", () => {
  it("bills a three-block response once", () => {
    const { turns, cost, credits } = run();
    expect(turns).toBe(1);
    expect(cost).toBeCloseTo(1.5, 2);
    expect(credits).toBe(100_000); // 20,000 output tokens x 5, counted once
  });

  it("still counts every tool_use block, not just the first", () => {
    // The dedup guard sits AFTER the content walk on purpose: each entry carries
    // a different block, so skipping the whole iteration would lose all tools
    // after the first. This assertion is what pins that ordering.
    const { body } = run();
    expect(body).toContain("Read");
    expect(body).toContain("Grep");
  });
});

describe("cost-alert-worker — thresholds are credits, not dollars", () => {
  const ladder = new URL("./fixtures/hook/sess-ladder.jsonl", import.meta.url).pathname;
  const context = new URL("./fixtures/hook/sess-context.jsonl", import.meta.url).pathname;
  const CAP = "1000000"; // 1M credits; the ladder fixture spends 20k per turn

  it("announces a rung as a share of the weekly cap", () => {
    // 3 turns x 20k = 60k = 6% of cap, crossing the 5% rung on the last turn.
    const msg = statusMessage(ladder, CAP);
    expect(msg).toContain("Crossed 5% of the weekly cap");
    expect(msg).toContain("% of cap");
  });

  it("stays silent once a rung is behind it", () => {
    // The old hook warned on EVERY turn past 5x the threshold, so the alert
    // stopped meaning anything. With a cap the fixture clears on turn 1, the
    // crossing turn is in the past and there is nothing new to say.
    // "Crossed" is the rung's own word, distinct from the checkpoint notice —
    // which legitimately does fire here, and says "Checkpointed at".
    const msg = statusMessage(ladder, "20000"); // rung 100% crossed on turn 1
    expect(msg).not.toContain("Crossed");
  });

  it("does not fire a dollar-shaped alert at all", () => {
    // Guards the regression this change exists to prevent: a $10 default that
    // every real session cleared, so 634 checkpoints piled up unread.
    const msg = statusMessage(ladder, CAP);
    expect(msg).not.toMatch(/Session crossed \$/);
  });

  it("warns when one turn's context alone costs a slice of the week", () => {
    // Turn 2 re-sends 1M tokens of context: 100k credits at the cache-read
    // weight, 10% of a 1M cap, against a 0.5% warn threshold.
    //
    // The threshold is passed rather than defaulted, because CAP here is a
    // synthetic 1M and the shipped default is calibrated against the real 1.2B.
    // Left to default, 0.0056% of 1M is 56 credits — under which turn *1*'s
    // context already crosses, and the "warn only on the crossing turn" guard
    // then correctly suppresses turn 2. That tested the fixture's arithmetic,
    // not the mechanism. The shipped default is exercised against the real cap
    // in "defaults that actually fire" below, which is where it belongs.
    const msg = statusMessage(context, CAP, { warn: "0.5" });
    expect(msg).toContain("Context is");
    expect(msg).toContain("/clear");
  });

  it("does not warn about context that is cheap relative to the cap", () => {
    const msg = statusMessage(context, "1000000000000");
    expect(msg).not.toContain("Context is");
  });

  it("never asks the caller to stop — output carries no blocking decision", () => {
    // This hook is advisory by construction: a Stop hook that emitted
    // decision:"block" would force-continue the turn, which is the opposite of
    // a spend warning. Only statusMessage may appear.
    const { stdout } = spawn(context, "1000");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).every((k) => k === "statusMessage")).toBe(true);
    expect(parsed["decision"]).toBeUndefined();
    expect(parsed["continue"]).toBeUndefined();
  });

  it("refuses a non-positive or unparseable cap instead of firing every rung", () => {
    // cap 0 would make every rung 0, so a single turn would "cross" all of them.
    for (const bad of ["0", "-5", "abc"]) {
      const { proc, stdout, stderr } = spawn(ladder, bad);
      expect(proc.exitCode).toBe(0);       // never break the user's session
      expect(stdout).toBe("{}");           // but say nothing
      expect(stderr).toContain("must be a positive number");
    }
  });
});

describe("cost-alert-worker — defaults that actually fire", () => {
  // Read from the module rather than written out: this block asserts that the
  // shipped thresholds fire against the REAL cap, so a hardcoded copy here would
  // keep passing against a cap the tool no longer uses — which is what happened
  // when the cap moved off 166.7M and these tests stayed green regardless.
  const REAL_CAP = String(DEFAULT_WEEKLY_CAP);
  const bigContext = new URL("./fixtures/hook/sess-bigcontext.jsonl", import.meta.url).pathname;
  const cheapLong = new URL("./fixtures/hook/sess-cheap-long.jsonl", import.meta.url).pathname;
  const alternating = new URL("./fixtures/hook/sess-alternating.jsonl", import.meta.url).pathname;

  it("warns about a 1.1M-token context at the SHIPPED default, not a hypothetical one", () => {
    // The first cut defaulted to 0.5% of the cap, which needs 8.3M tokens of
    // context against a 1M window — it could never fire. The README example it
    // shipped with was 7x below its own threshold, which is how that was caught.
    // This asserts the default as shipped, with no override.
    const msg = statusMessage(bigContext, REAL_CAP);
    expect(msg).toContain("Context is");
    expect(msg).toContain("/clear");
  });

  it("attributes the context warning to context, not to output", () => {
    // It used to trigger on whole-turn credits while saying "context", so an
    // output-heavy turn produced "Context is 0 tokens — each turn now costs 1.0M
    // credits … /clear resets it". /clear fixes nothing for output-driven cost.
    const msg = statusMessage(bigContext, REAL_CAP);
    expect(msg).toMatch(/Context is [\d.]+[kM]? tokens/);
    expect(msg).not.toContain("Context is 0 tokens");
  });

  it("warns once, not again on every dip and rise", () => {
    // Guarding against the previous turn only meant any cheap turn re-armed the
    // nag; the guard is now the peak of all prior turns.
    const msg = statusMessage(alternating, REAL_CAP);
    // Turn 3 matches turn 1's context, so it is not a new peak and must not re-warn.
    expect(msg).not.toContain("Context is");
  });

  it("does not checkpoint a long but cheap session", () => {
    // 60 turns of near-zero spend. Turn count alone used to write a file — and
    // once the credit rungs went quiet it wrote one with NO message at all. That
    // trigger, not the dollar threshold, is what kept 634 files accumulating.
    const { dir, proc } = spawn(cheapLong, REAL_CAP);
    expect(proc.exitCode).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("never writes a checkpoint without saying so", () => {
    // cap 1000 credits: the fixture is far past it, so a file is written and the
    // message must mention it even though no rung crossed on the final turn.
    const { dir, proc, stdout } = spawn(cheapLong, "1000");
    expect(proc.exitCode).toBe(0);
    expect(readdirSync(dir)).toEqual(["sess-hook.md"]);
    const msg = (JSON.parse(stdout) as { statusMessage?: string }).statusMessage ?? "";
    expect(msg).not.toBe("");
    expect(msg).toContain("checkpointed");
  });

  it("announces the checkpoint once — not on every later turn", () => {
    // The announcement is keyed on the WRITE, not on the threshold. Keying it on
    // the threshold would recreate the every-turn warning this change removed.
    const first = spawn(cheapLong, "1000");
    expect(readdirSync(first.dir)).toEqual(["sess-hook.md"]);
    // A second run against the same dir finds the file already there.
    const again = Bun.spawnSync(["bun", worker, cheapLong, first.dir, "1000"]);
    const msg = (JSON.parse(again.stdout.toString().trim()) as { statusMessage?: string }).statusMessage ?? "";
    expect(msg).not.toContain("checkpointed");
  });
});

describe("plugin packaging", () => {
  it("declares one version across package.json, src/version.ts and the plugin manifest", () => {
    // The 1.4.0 release bumped package.json and src/version.ts but not the plugin
    // manifest, so the marketplace kept installing 1.3.2 and every fix stayed
    // undelivered. Nothing else catches this: all three files are valid alone.
    const root = new URL("../", import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8")) as { version: string };
    const src = readFileSync(join(root, "src/version.ts"), "utf8");
    const declared = /"([^"]+)"/.exec(src)![1];
    expect(manifest.version).toBe(pkg.version);
    expect(declared).toBe(pkg.version);
  });
});

describe("cost-alert.sh — the wrapper's own config handling", () => {
  // This logic lives in bash, and the worker's stderr is discarded by the
  // wrapper, so nothing else would notice it rejecting a legal value.
  const wrapper = new URL("../hooks/cost-alert.sh", import.meta.url).pathname;
  const transcript = new URL("./fixtures/hook/sess-bigcontext.jsonl", import.meta.url).pathname;

  function runWrapper(cap: string): { out: string; err: string } {
    const dir = mkdtempSync(join(tmpdir(), "ts-wrap-"));
    const p = Bun.spawnSync(["bash", wrapper], {
      stdin: new TextEncoder().encode(JSON.stringify({ transcript_path: transcript })),
      env: { ...process.env, TOKEN_SCOPE_CREDIT_CAP: cap, TOKEN_SCOPE_CHECKPOINT_DIR: dir },
    });
    return { out: p.stdout.toString().trim(), err: p.stderr.toString() };
  }

  function capPct(cap: string): number {
    const { out } = runWrapper(cap);
    const m = /([\d.]+)% of cap/.exec((JSON.parse(out) as { statusMessage?: string }).statusMessage ?? "");
    return m ? Number(m[1]) : NaN;
  }

  it("accepts a K/M/B suffix, because --credits does through the same variable", () => {
    // TOKEN_SCOPE_CREDIT_CAP is read by the report via parseCap, which takes
    // "166.7M". The wrapper used to reject it and silently disable all alerting,
    // so one variable meant two different things to two consumers.
    expect(capPct("166.7M")).toBeCloseTo(capPct("166700000"), 1);
    expect(capPct("1M")).toBeCloseTo(capPct("1000k"), 1);
  });

  it("scales the cap rather than ignoring the suffix", () => {
    // A dropped suffix would read "166.7M" as 166.7 credits. Compare two caps
    // that both produce a message: the smaller cap must yield the larger share.
    // (1B is too large for this fixture to trip anything, hence 1M.)
    expect(capPct("1M")).toBeGreaterThan(capPct("166.7M"));
  });

  it("refuses a zero cap in any spelling, and says so where the message survives", () => {
    for (const bad of ["0", "0.0", ".0", "00"]) {
      const { out, err } = runWrapper(bad);
      expect(out).toBe("{}");
      expect(err).toContain("greater than zero");
    }
  });

  it("refuses an unparseable cap with a diagnostic, not silence", () => {
    for (const bad of ["abc", "1e6", "5MB", "1,000", "."]) {
      const { out, err } = runWrapper(bad);
      expect(out).toBe("{}");
      expect(err).toContain("must be a positive number");
    }
  });

  it("falls back to the default when the variable is unset or empty", () => {
    expect(capPct("")).toBeCloseTo(capPct(String(DEFAULT_WEEKLY_CAP)), 1);
  });

  it("warns about a big context THROUGH THE WRAPPER at shipped defaults", () => {
    // The regression this exists to catch: the worker's context threshold moved to
    // 0.04% but cost-alert.sh kept passing the old 0.5%, so every worker-level
    // test passed while production could never warn. Only an end-to-end run
    // through the wrapper sees it.
    const { out } = runWrapper("");
    const msg = (JSON.parse(out) as { statusMessage?: string }).statusMessage ?? "";
    expect(msg).toContain("Context is");
  });

  it("hard-codes no threshold defaults of its own", () => {
    // Defaults belong to the worker alone. A number written in both files is the
    // drift above waiting to happen again, and nothing else would notice.
    const src = readFileSync(wrapper, "utf8");
    for (const line of src.split("\n")) {
      if (!/^(CREDIT_CAP|CHECKPOINT_TURNS|CHECKPOINT_PCT|TURN_WARN_PCT)=/.test(line)) continue;
      expect(line).toMatch(/:-\}"$/);   // "${VAR:-}" — empty, never a literal
    }
  });
});
