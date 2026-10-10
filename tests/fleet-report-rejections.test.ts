import { describe, expect, it } from "bun:test";
import { fleetReportJson } from "@/reports/fleet";
import type { ProviderEvent } from "@/providers/types";

function event(overrides: Partial<ProviderEvent>): ProviderEvent {
  return {
    eventId: "claude:e1",
    harness: "claude",
    billingRoute: "subscription",
    modelProvider: "anthropic",
    model: "claude-opus-4-8",
    ts: "2026-09-22T14:02:00.000Z",
    status: "ok",
    retryOf: null,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    cashChargeUsd: null,
    provenance: "session.jsonl",
    requestId: null,
    runId: null,
    sessionId: null,
    ...overrides,
  };
}

function report(events: ProviderEvent[]) {
  return fleetReportJson(
    {
      providers: { events, unavailable: [], partial: {} },
      orca: { records: [], metadata: {}, hosts: {}, sources: [], runtime: { id: null, version: null } },
      olla: null,
      ollaState: { source: "olla", state: "unavailable", reason: "TOKEN_SCOPE_OLLA_URL not configured" },
    },
    { window: "1d", sinceMs: 0, collectedAt: "2026-09-22T14:05:01.000Z", promptOriginHost: null },
  );
}

describe("fleet report contract rejections", () => {
  it("counts an out-of-contract value against its source and keeps other rows", () => {
    const result = report([event({ inputTokens: -1 }), event({ eventId: "claude:e2" })]);
    expect(result.rows).toHaveLength(1);
    expect(result.sources).toContainEqual({
      source: "provider-claude",
      state: "partial",
      reason: "1 event(s) rejected by fleet contract: usage.input_tokens must be a non-negative integer or null",
    });
  });

  it("propagates a record-shape fault in the adapter's own output", () => {
    expect(() => report([event({ runId: "unqualified" })])).toThrow("run_id must be source-qualified");
  });
});
