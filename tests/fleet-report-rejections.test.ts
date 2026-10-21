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

  it("surfaces olla.rejectedRoutes as an olla-routes partial source state", () => {
    const result = fleetReportJson(
      {
        providers: { events: [event({ eventId: "claude:d1" })], unavailable: [], partial: {} },
        orca: { records: [], metadata: {}, hosts: {}, sources: [], runtime: { id: null, version: null } },
        olla: {
          snapshots: [],
          metadata: {},
          sources: [{ path: "/internal/status", state: "available", reason: null, errorClass: null, provenance: { source: "/internal/status", locator: "http://router.local", collected_at: "2026-09-22T14:05:01.000Z", completeness: "complete" } }],
          endpointChanges: { disappeared: null },
          observedRoutes: [],
          rejectedRoutes: [{ reason: "missing_endpoint" }],
        },
        ollaState: { source: "olla", state: "available", reason: null },
      },
      { window: "1d", sinceMs: 0, collectedAt: "2026-09-22T14:05:01.000Z", promptOriginHost: null },
    );
    expect(result.sources).toContainEqual({
      source: "olla-routes",
      state: "partial",
      reason: "rejected route observation(s): missing_endpoint",
    });
  });

  it("merges the distinct observed-route rejection reasons into the route-file rejection reason", () => {
    const result = fleetReportJson(
      {
        providers: { events: [event({ eventId: "claude:d1" })], unavailable: [], partial: {} },
        orca: { records: [], metadata: {}, hosts: {}, sources: [], runtime: { id: null, version: null } },
        olla: {
          snapshots: [],
          metadata: {},
          sources: [{ path: "/internal/status", state: "available", reason: null, errorClass: null, provenance: { source: "/internal/status", locator: "http://router.local", collected_at: "2026-09-22T14:05:01.000Z", completeness: "complete" } }],
          endpointChanges: { disappeared: null },
          observedRoutes: [],
          rejectedRoutes: [{ reason: "missing_endpoint" }, { reason: "invalid_key" }, { reason: "missing_endpoint" }],
        },
        ollaState: { source: "olla", state: "available", reason: null },
        routeFileState: { source: "olla-routes", state: "partial", reason: "rejected route observation(s): oversize_label, privacy" },
      },
      { window: "1d", sinceMs: 0, collectedAt: "2026-09-22T14:05:01.000Z", promptOriginHost: null },
    );
    expect(result.sources.filter((source) => source.source === "olla-routes")).toEqual([
      { source: "olla-routes", state: "partial", reason: "rejected route observation(s): invalid_key, missing_endpoint, oversize_label, privacy" },
    ]);
  });

  it("keeps the unavailable olla-routes state alongside rejected route observations (#187)", () => {
    const result = fleetReportJson(
      {
        providers: { events: [event({ eventId: "claude:d1" })], unavailable: [], partial: {} },
        orca: { records: [], metadata: {}, hosts: {}, sources: [], runtime: { id: null, version: null } },
        olla: {
          snapshots: [],
          metadata: {},
          sources: [{ path: "/internal/status", state: "available", reason: null, errorClass: null, provenance: { source: "/internal/status", locator: "http://router.local", collected_at: "2026-09-22T14:05:01.000Z", completeness: "complete" } }],
          endpointChanges: { disappeared: null },
          observedRoutes: [],
          rejectedRoutes: [{ reason: "missing_endpoint" }],
        },
        ollaState: { source: "olla", state: "available", reason: null },
        routeFilePartial: true,
        routeFileState: { source: "olla-routes", state: "unavailable", reason: "TOKEN_SCOPE_OLLA_ROUTES is unreadable or not JSON" },
      },
      { window: "1d", sinceMs: 0, collectedAt: "2026-09-22T14:05:01.000Z", promptOriginHost: null },
    );
    const routes = result.sources.filter((source) => source.source === "olla-routes");
    expect(routes).toEqual([
      { source: "olla-routes", state: "unavailable", reason: "TOKEN_SCOPE_OLLA_ROUTES is unreadable or not JSON" },
      { source: "olla-routes", state: "partial", reason: "rejected route observation(s)" },
    ]);
  });

  it("surfaces token-shaped promptOriginHost as prompt-origin partial privacy source while keeping rows ok", () => {
    const result = fleetReportJson(
      {
        providers: { events: [event({ eventId: "claude:d1" })], unavailable: [], partial: {} },
        orca: { records: [], metadata: {}, hosts: {}, sources: [], runtime: { id: null, version: null } },
        olla: null,
        ollaState: { source: "olla", state: "unavailable", reason: "TOKEN_SCOPE_OLLA_URL not configured" },
      },
      { window: "1d", sinceMs: 0, collectedAt: "2026-09-22T14:05:01.000Z", promptOriginHost: "host-sk-ant-api03-abcdefghijklmnop" },
    );
    expect(result.sources).toContainEqual({
      source: "prompt-origin",
      state: "partial",
      reason: "privacy",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.status).toBe("ok");
    expect(result.rows[0]!.prompt_origin_host).toBeNull();
  });

  it("surfaces oversize promptOriginHost as prompt-origin partial oversize_label source", () => {
    const result = fleetReportJson(
      {
        providers: { events: [event({ eventId: "claude:d1" })], unavailable: [], partial: {} },
        orca: { records: [], metadata: {}, hosts: {}, sources: [], runtime: { id: null, version: null } },
        olla: null,
        ollaState: { source: "olla", state: "unavailable", reason: "TOKEN_SCOPE_OLLA_URL not configured" },
      },
      { window: "1d", sinceMs: 0, collectedAt: "2026-09-22T14:05:01.000Z", promptOriginHost: "a".repeat(257) },
    );
    expect(result.sources).toContainEqual({
      source: "prompt-origin",
      state: "partial",
      reason: "oversize_label",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.status).toBe("ok");
    expect(result.rows[0]!.prompt_origin_host).toBeNull();
  });
});
