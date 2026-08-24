import { describe, it, expect } from "bun:test";
import { JsonlReader } from "../src/jsonl";
import { join } from "path";

const DIR = join(import.meta.dir, "fixtures/spend-projects");
const DIR_HAIKU = join(import.meta.dir, "fixtures/spend-projects/-Users-alice-projects-haiku");

function reader() {
  return new JsonlReader([DIR]);
}

describe("querySubagentSpendByAgent", () => {
  it("returns a Map of agent ID to SubagentSpend", () => {
    const r = reader();
    const byAgent = r.querySubagentSpendByAgent("sess-spend");
    r.close();

    expect(byAgent).toBeInstanceOf(Map);
    expect(byAgent.size).toBe(2);
    expect(byAgent.has("agent-multi")).toBe(true);
    expect(byAgent.has("agent-haiku")).toBe(true);
  });

  it("computes per-agent token counts correctly", () => {
    const r = reader();
    const byAgent = r.querySubagentSpendByAgent("sess-spend");
    r.close();

    const multi = byAgent.get("agent-multi")!;
    expect(multi.outputTokens).toBe(450);   // 300 + 150
    expect(multi.inputTokens).toBe(45);     // 30 + 15
    expect(multi.cacheReadTokens).toBe(5000); // 2000 + 3000
    expect(multi.cacheWriteTokens).toBe(500); // 500 + 0
    expect(multi.agentCount).toBe(1);

    // haiku: 1 record with 20 input, 200 output, 1000 cache-read
    const haiku = byAgent.get("agent-haiku")!;
    expect(haiku.outputTokens).toBe(200);
    expect(haiku.inputTokens).toBe(20);
    expect(haiku.cacheReadTokens).toBe(1000);
    expect(haiku.cacheWriteTokens).toBe(0);
    expect(haiku.agentCount).toBe(1);
  });

  it("computes per-agent cost correctly", () => {
    const r = reader();
    const byAgent = r.querySubagentSpendByAgent("sess-spend");
    r.close();

    // multi uses claude-sonnet-4-6 (has pricing)
    const multi = byAgent.get("agent-multi")!;
    expect(multi.costUsd).toBeGreaterThan(0);
    expect(multi.costPartial).toBe(false);

    // haiku uses claude-haiku-3-5 (no pricing in test fixture)
    const haiku = byAgent.get("agent-haiku")!;
    expect(haiku.costUsd).toBeNull();
    expect(haiku.costPartial).toBe(true);
  });

  it("returns empty Map for unknown session", () => {
    const r = reader();
    const byAgent = r.querySubagentSpendByAgent("sess-unknown");
    r.close();

    expect(byAgent.size).toBe(0);
  });
});

describe("querySubagentSpendByAgent — Haiku batch (#69)", () => {
  it("resolves 41-record Haiku batch to a cost in $0.63–1.10", () => {
    // Acceptance criterion from #18: the 2026-07-09 lean-PM batch
    // (Haiku agent, 41 assistant records) resolvable to a dollar figure
    // in one command, matching the hand-computed $0.63–1.10 range.
    const r = new JsonlReader([DIR_HAIKU]);
    const byAgent = r.querySubagentSpendByAgent("sess-spend");
    r.close();

    const haiku = byAgent.get("agent-haiku")!;
    expect(haiku).toBeDefined();
    expect(haiku.agentCount).toBe(1);
    expect(haiku.costPartial).toBe(false);
    expect(haiku.costUsd).toBeGreaterThan(0.63);
    expect(haiku.costUsd).toBeLessThan(1.10);
  });
});
