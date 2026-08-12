import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const worker = new URL("../hooks/cost-alert-worker.ts", import.meta.url).pathname;
const transcript = new URL("./fixtures/hook/sess-hook.jsonl", import.meta.url).pathname;

// The fixture is one opus response (20,000 output tokens = $1.50) written as
// three content-block entries, each repeating the same usage object. The worker
// must bill it once, or every threshold in it fires at a third of the real spend.
function run(): { turns: number; cost: number; body: string } {
  const dir = mkdtempSync(join(tmpdir(), "ts-hook-"));
  const proc = Bun.spawnSync(["bun", worker, transcript, dir, "1", "50"]);
  expect(proc.exitCode).toBe(0);
  const files = readdirSync(dir);
  expect(files).toEqual(["sess-hook.md"]);
  const body = readFileSync(join(dir, files[0]!), "utf8");
  return {
    turns: Number(/^turns: (\d+)$/m.exec(body)![1]),
    cost: Number(/^cost: ([\d.]+)$/m.exec(body)![1]),
    body,
  };
}

describe("cost-alert-worker — one turn per API response (#19)", () => {
  it("bills a three-block response once", () => {
    const { turns, cost } = run();
    expect(turns).toBe(1);
    expect(cost).toBeCloseTo(1.5, 2);
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
