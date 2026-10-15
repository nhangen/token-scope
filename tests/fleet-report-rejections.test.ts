import { describe, expect, it } from "bun:test";
import { fleetReportJson, renderFleetReport } from "@/reports/fleet";
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

  it("carries provider unavailable reason into fleet source states", () => {
    const result = fleetReportJson(
      {
        providers: {
          events: [],
          unavailable: ["gemini-cli"],
          unavailableReasons: { "gemini-cli": ["collector_error"] },
          partial: {},
        },
        orca: { records: [], metadata: {}, hosts: {}, sources: [], runtime: { id: null, version: null } },
        olla: null,
        ollaState: { source: "olla", state: "unavailable", reason: "TOKEN_SCOPE_OLLA_URL not configured" },
      },
      { window: "1d", sinceMs: 0, collectedAt: "2026-09-22T14:05:01.000Z", promptOriginHost: null },
    );
    expect(result.sources).toContainEqual({
      source: "provider-gemini-cli",
      state: "unavailable",
      reason: "collector_error",
    });
  });

  it("falls back to unreadable when no unavailable reason was recorded", () => {
    const result = fleetReportJson(
      {
        providers: {
          events: [],
          unavailable: ["gemini-cli"],
          partial: {},
        },
        orca: { records: [], metadata: {}, hosts: {}, sources: [], runtime: { id: null, version: null } },
        olla: null,
        ollaState: { source: "olla", state: "unavailable", reason: "TOKEN_SCOPE_OLLA_URL not configured" },
      },
      { window: "1d", sinceMs: 0, collectedAt: "2026-09-22T14:05:01.000Z", promptOriginHost: null },
    );
    expect(result.sources).toContainEqual({
      source: "provider-gemini-cli",
      state: "unavailable",
      reason: "unreadable",
    });
  });

  it("counts undated provider events as untimed_excluded and renders the footer line", () => {
    const undated1 = event({ eventId: "claude:undated1", ts: null });
    const undated2 = event({ eventId: "claude:undated2", ts: "invalid-date" });
    const dated = event({ eventId: "claude:dated", ts: "2026-09-22T14:02:00.000Z" });

    const res = report([undated1, undated2, dated]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.timestamp).toBe("2026-09-22T14:02:00.000Z");
    expect(res.untimed_excluded).toBe(2);

    const rendered = renderFleetReport(res);
    expect(rendered).toContain("2 event(s) outside --since only because they carry no timestamp");
  });

  it("omits the untimed footer line when untimed_excluded is zero", () => {
    const dated = event({ eventId: "claude:dated", ts: "2026-09-22T14:02:00.000Z" });
    const res = report([dated]);
    expect(res.untimed_excluded).toBe(0);

    const rendered = renderFleetReport(res);
    expect(rendered).not.toContain("outside --since only because they carry no timestamp");
  });
});
