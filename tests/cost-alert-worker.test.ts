import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const worker = new URL("../hooks/cost-alert-worker.ts", import.meta.url).pathname;
const transcript = new URL("./fixtures/hook/sess-hook.jsonl", import.meta.url).pathname;

// The fixture is one opus response (20,000 output tokens = $1.50) written as
// three content-block entries, each repeating the same usage object. The worker
// must bill it once, or every threshold in it fires at a third of the real spend.
/** argv: <transcript> <checkpointDir> <cap> <turns> <checkpointPct> <turnWarnPct> */
function spawn(t: string, cap: string, opts: { turns?: string; pct?: string; warn?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ts-hook-"));
  const proc = Bun.spawnSync(["bun", worker, t, dir, cap, opts.turns ?? "50", opts.pct ?? "25", opts.warn ?? "0.5"]);
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
    expect(msg).toContain("5% of the weekly cap");
    expect(msg).toContain("% of cap");
  });

  it("stays silent once a rung is behind it", () => {
    // The old hook warned on EVERY turn past 5x the threshold, so the alert
    // stopped meaning anything. With a cap the fixture clears on turn 1, the
    // crossing turn is in the past and there is nothing new to say.
    const msg = statusMessage(ladder, "20000"); // rung 100% crossed on turn 1
    expect(msg).not.toContain("of the weekly cap");
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
    const msg = statusMessage(context, CAP);
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
