import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { claudeEventsFromTranscript } from "@/providers/claude";
import { ollamaEvents } from "@/providers/ollama";
import type { LedgerRun } from "@/ledger";
import { codexEventsFromRollout } from "@/providers/codex";
import { collectProviderEvents, dedupeEvents } from "@/providers";
import { providerRows, renderProviderReport } from "@/reports/providers";

const FX = join(import.meta.dir, "fixtures", "providers");

describe("claude adapter", () => {
  it("normalizes usage classes and skips torn lines", () => {
    const ev = claudeEventsFromTranscript(
      readFileSync(join(FX, "claude-sample.jsonl"), "utf8"),
      "claude-sample.jsonl",
    );
    expect(ev.length).toBe(2);
    expect(ev[0]!.inputTokens).toBe(100);
    expect(ev[0]!.cacheReadTokens).toBe(200);
    expect(ev[0]!.cacheWriteTokens).toBe(30);
    expect(ev[0]!.reasoningTokens).toBeNull();
    expect(ev[0]!.billingRoute).toBe("subscription");
  });
});

describe("ollama adapter", () => {
  it("keeps absent cache/reasoning classes null, not zero", () => {
    // Snake_case fixture mirrors the real ledger rows (#37 step 1: inspect a
    // real record before freezing the schema). Drive through readLedger so
    // the field mapping under test matches production.
    const ev = ollamaEvents(join(FX, "ledger-sample.jsonl"));
    expect(ev.length).toBe(1);
    expect(ev[0]!.inputTokens).toBe(5758);
    expect(ev[0]!.cacheReadTokens).toBeNull();
    expect(ev[0]!.reasoningTokens).toBeNull();
    expect(ev[0]!.billingRoute).toBe("local");
  });
});

describe("codex adapter", () => {
  it("emits one aggregate event with final cumulative totals", () => {
    const ev = codexEventsFromRollout(
      readFileSync(join(FX, "codex-rollout.jsonl"), "utf8"),
      "codex-rollout.jsonl",
    );
    expect(ev.length).toBe(1);
    expect(ev[0]!.eventId.startsWith("codex:019e-codex")).toBe(true);
    expect(ev[0]!.inputTokens).toBe(900);
    expect(ev[0]!.cacheReadTokens).toBe(150);
    expect(ev[0]!.reasoningTokens).toBe(40);
  });
});

describe("dedup + report", () => {
  const text = readFileSync(join(FX, "claude-sample.jsonl"), "utf8");
  const once = claudeEventsFromTranscript(text, "same.jsonl");
  const collected = {
    events: [...once, ...once], // re-scan of the same source
    unavailable: [] as string[],
  };

  it("collapses re-scans deterministically", () => {
    const rows = providerRows({ ...collected, events: dedupeEvents(collected.events) });
    expect(rows.filter((r) => r.harness === "claude").length).toBe(1);
    expect(rows[0]!.events).toBe(2); // deduped to distinct events only
  });

  it("renders nulls as em-dashes and lists unavailable sources", () => {
    const out = renderProviderReport(
      [{ harness: "x", billingRoute: "local", model: "m", events: 1, input: 5, output: null, cacheRead: null, cacheWrite: null, reasoning: null }],
      ["opencode"],
    );
    expect(out).toContain("—");
    expect(out).toContain("unavailable sources (volume unknown, not zero): opencode");
  });

  it("--since filters events without timestamps", () => {
    const since = Date.parse("2099-01-01"); // everything is older
    const rows = providerRows(collected, since + 1e12);
    expect(rows.length).toBe(0);
  });

  it("collectProviderEvents reports missing sources as unknown", () => {
    const c = collectProviderEvents({
      claudeRoot: "/nonexistent",
      ledgerPath: "/nonexistent.jsonl",
      codexHome: "/nonexistent",
      opencodeDb: "/nonexistent.db",
    });
    // Absent sources are legitimately empty (a machine without codex has zero
    // codex usage). Unavailable is reserved for present-but-unreadable sources
    // (locked/corrupt db) where volume is unknown rather than zero (#37).
    expect(c.unavailable).toEqual(["opencode"]);
  });
});
