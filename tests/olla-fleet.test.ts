import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseFleetRecord, snapshotCounterDelta, PrivacyError } from "@/fleet-contract";
import {
  collectOllaTelemetry,
  correlateOllaRoute,
  errorClassName,
  type OllaFetch,
  type OllaTelemetryCollection,
} from "@/fleet/olla";

const FX = join(import.meta.dir, "fixtures", "olla");
const COLLECTED_AT = "2026-09-22T14:05:01.000Z";

function fixture(name: string): string {
  return readFileSync(join(FX, name), "utf8");
}

function fixtureFetch(overrides: Record<string, string | Error | number> = {}): OllaFetch {
  const bodies: Record<string, string> = {
    "/internal/status": fixture("status.json"),
    "/internal/status/endpoints": fixture("endpoints.json"),
    "/internal/status/models": fixture("models.json"),
    "/internal/stats/models?include_endpoints=true&include_summary=true": fixture("model-stats.json"),
    "/internal/metrics": fixture("metrics.prom"),
  };
  return async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    const override = overrides[path];
    if (override instanceof Error) throw override;
    if (typeof override === "number") return new Response("", { status: override });
    const body = typeof override === "string" ? override : bodies[path];
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

async function collect(overrides: Record<string, string | Error | number> = {}, opts: {
  baseUrl?: string;
  collectedAt?: string;
  timeoutMs?: number;
  fetch?: OllaFetch;
  previous?: OllaTelemetryCollection;
  observedRoutes?: Array<{
    requestId?: string;
    runId?: string;
    endpointId?: string;
    endpointName?: string;
    model?: string;
    timestamp?: string;
  }>;
} = {}): Promise<OllaTelemetryCollection> {
  return collectOllaTelemetry({
    baseUrl: opts.baseUrl ?? "http://router.local:40114",
    collectedAt: opts.collectedAt ?? COLLECTED_AT,
    staleAfterMs: 60_000,
    timeoutMs: opts.timeoutMs,
    fetch: opts.fetch ?? fixtureFetch(overrides),
    previous: opts.previous,
    observedRoutes: opts.observedRoutes,
  });
}

function snapshot(collection: OllaTelemetryCollection, scope: string, selector?: string) {
  const entry = collection.snapshots.find((candidate) => {
    const metadata = collection.metadata[candidate.record_id];
    return metadata?.scope === scope && (
      selector === undefined
      || metadata.endpoint?.id === selector
      || metadata.model === selector
    );
  });
  if (!entry) throw new Error(`missing ${scope} snapshot ${selector ?? ""}`);
  return entry;
}

describe("Olla fleet telemetry adapter", () => {
  const baseUrlPrivacyCases = JSON.parse(fixture("private-base-urls.json")).private as Array<{
    label: string;
    url: string;
    secret: string;
  }>;

  for (const privacyCase of baseUrlPrivacyCases) {
    it(`rejects ${privacyCase.label} before fetch or provenance creation`, async () => {
      let fetchCount = 0;
      const result = collect({}, {
        baseUrl: privacyCase.url,
        fetch: async () => {
          fetchCount += 1;
          return new Response("", { status: 404 });
        },
      });
      await expect(result, privacyCase.label).rejects.toThrow("credential-like label value rejected");
      expect(fetchCount, privacyCase.secret).toBe(0);
    });
  }

  it("limits provenance locators to the safe origin and known endpoint path", async () => {
    const safe = JSON.parse(fixture("private-base-urls.json")).safe as {
      url: string;
      requestPrefix: string;
    };
    const fetchFixtures = fixtureFetch();
    const collected = await collect({}, {
      baseUrl: safe.url,
      fetch: (url, init) => {
        const parsed = new URL(url);
        parsed.pathname = parsed.pathname.replace(new RegExp(`^${safe.requestPrefix}`), "");
        return fetchFixtures(parsed.toString(), init);
      },
    });
    for (const source of collected.sources) {
      expect(source.provenance.locator).toBe(`http://router.local:40114${source.path}`);
      expect(source.provenance.locator).not.toContain("mode=readonly");
      expect(source.provenance.locator).not.toContain("#local");
    }
  });

  it("ingests endpoint/model health, counters, latency, and sanitized routing metadata", async () => {
    const collected = await collect();
    expect(collected.snapshots).toHaveLength(12);
    for (const record of collected.snapshots) expect(parseFleetRecord(record)).toEqual(record);

    const system = snapshot(collected, "system");
    expect(system.counters).toMatchObject({
      requests: 50,
      failures: 1,
      avg_latency_ms: 120,
      active_connections: 3,
    });
    expect(collected.metadata[system.record_id]?.routing).toEqual({
      engine: "olla",
      profile: "auto",
      balancer: "least-connections",
    });

    const endpoint = snapshot(collected, "endpoint", "ml1-id");
    expect(endpoint.status).toBe("ok");
    expect(endpoint.counters).toMatchObject({ requests: 40, avg_latency_ms: 110, health_up: 1 });
    expect(collected.metadata[endpoint.record_id]?.endpoint).toEqual({
      id: "ml1-id",
      name: "ml1-5080",
      type: "vllm",
      url: "http://ml1:5080/v1",
      host: "ml1",
      status: "healthy",
      priority: 100,
    });
    expect(JSON.stringify(collected)).not.toContain("secret");
    expect(JSON.stringify(collected)).not.toContain("api_key");

    const modelStatus = snapshot(collected, "model_status", "qwen3.8:27b");
    expect(modelStatus.status).toBe("ok");
    expect(modelStatus.counters.endpoints).toBe(2);

    const model = snapshot(collected, "model_stats", "qwen3.8:27b");
    expect(model.counters).toMatchObject({
      requests: 50,
      successful_requests: 48,
      failed_requests: 2,
      avg_latency_ms: 120,
      routing_hits: 44,
      routing_misses: 4,
      routing_fallbacks: 2,
    });
  });

  it("parses Prometheus text into global, endpoint, model, and model-endpoint snapshots", async () => {
    const collected = await collect();
    expect(snapshot(collected, "metrics").counters).toMatchObject({
      requests: 50,
      failures: 1,
      avg_latency_ms: 120,
    });
    expect(snapshot(collected, "metrics_endpoint", "ml1-id").counters).toMatchObject({
      requests: 40,
      avg_latency_ms: 110,
      health_up: 1,
    });
    expect(snapshot(collected, "metrics_model", "qwen3.8:27b").counters).toMatchObject({
      requests: 50,
      avg_latency_ms: 120,
      routing_hits: 44,
    });
    expect(snapshot(collected, "metrics_model_endpoint", "qwen3.8:27b").counters.requests).toBe(40);
  });

  it("keeps reset and restart deltas explicit instead of producing negative or zero values", async () => {
    const before = await collect();
    const reset = await collect({ "/internal/metrics": fixture("metrics-reset.prom") }, {
      collectedAt: "2026-09-22T14:06:01.000Z",
    });
    expect(snapshotCounterDelta(snapshot(before, "metrics"), snapshot(reset, "metrics"), "requests"))
      .toEqual({ state: "reset", value: null });

    const restartedStatus = JSON.stringify({
      ...JSON.parse(fixture("status.json")),
      timestamp: "2026-09-22T14:06:00Z",
      system: {
        ...JSON.parse(fixture("status.json")).system,
        start_time: "2026-09-22T14:05:30Z",
      },
    });
    const restarted = await collect({
      "/internal/status": restartedStatus,
      "/internal/metrics": fixture("metrics-reset.prom"),
    }, { collectedAt: "2026-09-22T14:06:01.000Z" });
    expect(snapshotCounterDelta(snapshot(before, "metrics"), snapshot(restarted, "metrics"), "requests"))
      .toEqual({ state: "restart", value: null });
  });

  it("reports stale, missing, unreadable, and malformed sources with provenance", async () => {
    const staleStatus = JSON.stringify({
      ...JSON.parse(fixture("status.json")),
      timestamp: "2026-09-22T14:00:00Z",
    });
    const collected = await collect({
      "/internal/status": staleStatus,
      "/internal/status/endpoints": new Error("connection refused"),
      "/internal/status/models": "{not json",
      "/internal/metrics": 404,
    });
    expect(collected.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/internal/status", state: "partial", reason: "stale" }),
      expect.objectContaining({ path: "/internal/status/endpoints", state: "unavailable", reason: "unreadable" }),
      expect.objectContaining({ path: "/internal/status/models", state: "partial", reason: "malformed" }),
      expect.objectContaining({ path: "/internal/metrics", state: "unavailable", reason: "missing" }),
    ]));
    for (const source of collected.sources) {
      expect(source.provenance.collected_at).toBe(COLLECTED_AT);
      expect(source.provenance.locator).toBe(`http://router.local:40114${source.path}`);
    }
  });

  it("rejects private source fields instead of persisting them", async () => {
    const collected = await collect({
      "/internal/status/endpoints": fixture("private-endpoints.json"),
    });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      path: "/internal/status/endpoints",
      state: "partial",
      reason: "privacy",
    }));
    expect(collected.snapshots.some((record) =>
      collected.metadata[record.record_id]?.scope === "endpoint"
    )).toBe(false);
    expect(JSON.stringify(collected)).not.toContain("Bearer secret");
  });

  it("rejects credential-like Prometheus label values without leaking them into records or IDs", async () => {
    const collected = await collect({
      "/internal/metrics": fixture("metrics-private.prom"),
    });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      path: "/internal/metrics",
      state: "partial",
      reason: "privacy",
      provenance: expect.objectContaining({ completeness: "partial" }),
    }));
    expect(JSON.stringify(collected)).not.toContain("secret-value");
    expect(collected.snapshots.some((record) =>
      collected.metadata[record.record_id]?.sourcePath === "/internal/metrics"
    )).toBe(false);
  });

  it("rejects credential-like model names from both JSON model sources", async () => {
    const cases: Array<[string, string, string]> = [
      ["/internal/status/models", "private-models.json", "json-model-secret"],
      [
        "/internal/stats/models?include_endpoints=true&include_summary=true",
        "private-model-stats.json",
        "stats-model-secret",
      ],
    ];
    for (const [path, fixtureName, secret] of cases) {
      const collected = await collect({ [path]: fixture(fixtureName) });
      expect(collected.sources, path).toContainEqual(expect.objectContaining({
        path,
        state: "partial",
        reason: "privacy",
        provenance: expect.objectContaining({ completeness: "partial" }),
      }));
      expect(JSON.stringify(collected), path).not.toContain(secret);
      expect(collected.snapshots.some((record) => record.provenance.locator?.includes(path)), path)
        .toBe(false);
    }
  });

  it("rejects credential-like endpoint types before metadata or snapshot persistence", async () => {
    const collected = await collect({
      "/internal/status/endpoints": fixture("private-endpoint-type.json"),
    });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      path: "/internal/status/endpoints",
      state: "partial",
      reason: "privacy",
      provenance: expect.objectContaining({ completeness: "partial" }),
    }));
    expect(JSON.stringify(collected)).not.toContain("endpoint-secret");
    expect(collected.snapshots.some((record) =>
      collected.metadata[record.record_id]?.sourcePath === "/internal/status/endpoints"
    )).toBe(false);
  });

  const endpointUrlPrivacyCases: Array<[string, string]> = [
    ["private-endpoint-url-token.json", "endpoint-token-secret"],
    ["private-endpoint-url-key.json", "endpoint-key-secret"],
  ];

  for (const [fixtureName, secret] of endpointUrlPrivacyCases) {
    it(`rejects credential-like endpoint URL path from ${fixtureName}`, async () => {
      const collected = await collect({
        "/internal/status/endpoints": fixture(fixtureName),
      });
      expect(collected.sources).toContainEqual(expect.objectContaining({
        path: "/internal/status/endpoints",
        state: "partial",
        reason: "privacy",
        provenance: expect.objectContaining({ completeness: "partial" }),
      }));
      expect(JSON.stringify(collected)).not.toContain(secret);
      expect(collected.snapshots.some((record) =>
        collected.metadata[record.record_id]?.sourcePath === "/internal/status/endpoints"
      )).toBe(false);
    });
  }

  const endpointPrivacyCases: Array<{
    label: string;
    path: string;
    fixtureName: string;
    secret: string;
  }> = [
    {
      label: "endpoint IDs",
      path: "/internal/status/endpoints",
      fixtureName: "private-endpoint-id.json",
      secret: "id-secret",
    },
    {
      label: "endpoint names",
      path: "/internal/status/endpoints",
      fixtureName: "private-endpoint-name.json",
      secret: "name-secret",
    },
    {
      label: "endpoint statuses",
      path: "/internal/status/endpoints",
      fixtureName: "private-endpoint-status.json",
      secret: "status-secret",
    },
    {
      label: "unknown endpoint breakdown keys",
      path: "/internal/stats/models?include_endpoints=true&include_summary=true",
      fixtureName: "private-endpoint-breakdown-key.json",
      secret: "endpoint-key-secret",
    },
  ];

  for (const privacyCase of endpointPrivacyCases) {
    it(`rejects credential-like ${privacyCase.label} at the persistence boundary`, async () => {
      const collected = await collect({
        [privacyCase.path]: fixture(privacyCase.fixtureName),
      });
      expect(collected.sources).toContainEqual(expect.objectContaining({
        path: privacyCase.path,
        state: "partial",
        reason: "privacy",
        provenance: expect.objectContaining({ completeness: "partial" }),
      }));
      expect(JSON.stringify(collected)).not.toContain(privacyCase.secret);
      expect(collected.snapshots.some((record) =>
        collected.metadata[record.record_id]?.sourcePath === privacyCase.path
      )).toBe(false);
    });
  }

  it("rejects credential-like routing strings before metadata or snapshot persistence", async () => {
    const collected = await collect({
      "/internal/status": fixture("private-routing.json"),
    });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      path: "/internal/status",
      state: "partial",
      reason: "privacy",
      provenance: expect.objectContaining({ completeness: "partial" }),
    }));
    expect(JSON.stringify(collected)).not.toContain("route-secret");
    expect(collected.snapshots.some((record) =>
      collected.metadata[record.record_id]?.sourcePath === "/internal/status"
    )).toBe(false);
  });

  it("rejects credential-like observed request and run IDs before collection persistence", async () => {
    await expect(collect({}, {
      observedRoutes: [{ requestId: "Bearer request-secret", endpointId: "ml1-id" }],
    })).rejects.toThrow("credential-like label value rejected");
    await expect(collect({}, {
      observedRoutes: [{ runId: "codex:Bearer run-secret", endpointId: "ml1-id" }],
    })).rejects.toThrow("credential-like label value rejected");
  });

  const qualifiedRoutePrivacyCases = JSON.parse(fixture("private-observed-route-ids.json")) as Array<{
    label: string;
    secret: string;
    route: {
      requestId?: string;
      runId?: string;
      endpointId: string;
    };
  }>;

  for (const privacyCase of qualifiedRoutePrivacyCases) {
    it(`rejects credential assignments in ${privacyCase.label} before persistence`, async () => {
      const result = collect({}, { observedRoutes: [privacyCase.route] });
      await expect(result).rejects.toThrow("credential-like label value rejected");
      await result.catch((error: Error) => {
        expect(`${error.message}\n${error.stack ?? ""}`).not.toContain(privacyCase.secret);
      });
    });
  }

  it("keeps missing endpoint_ids unknown instead of reporting a measured zero", async () => {
    const collected = await collect({
      "/internal/status/models": fixture("models-missing-endpoint-ids.json"),
    });
    const model = snapshot(collected, "model_status", "qwen3.8:27b");
    expect(model.counters.endpoints).toBeNull();
    expect(model.status).toBe("unknown");
    expect(model.provenance.completeness).toBe("complete");
  });

  it("marks malformed endpoint_ids partial instead of counting only valid-looking entries", async () => {
    const collected = await collect({
      "/internal/status/models": fixture("models-malformed-endpoint-ids.json"),
    });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      path: "/internal/status/models",
      state: "partial",
      reason: "malformed",
      provenance: expect.objectContaining({ completeness: "partial" }),
    }));
    expect(collected.snapshots.some((record) =>
      collected.metadata[record.record_id]?.scope === "model_status"
    )).toBe(false);
  });

  it("reports endpoint disappearance between scrapes", async () => {
    const previous = await collect();
    const endpoints = JSON.parse(fixture("endpoints.json"));
    endpoints.endpoints = endpoints.endpoints.slice(0, 1);
    endpoints.total_count = 1;
    const current = await collect({
      "/internal/status/endpoints": JSON.stringify(endpoints),
    }, { previous });
    expect(current.endpointChanges.disappeared).toEqual(["ml2-id"]);
  });

  it("leaves endpoint disappearance unknown when the endpoint source is unavailable or malformed", async () => {
    const previous = await collect();
    const cases: Array<[string, string | Error | number, string, string]> = [
      ["missing", 404, "unavailable", "missing"],
      ["unreadable", new Error("connection refused"), "unavailable", "unreadable"],
      ["malformed", fixture("malformed-endpoints.json"), "partial", "malformed"],
    ];
    for (const [name, endpointSource, state, reason] of cases) {
      const current = await collect({
        "/internal/status/endpoints": endpointSource,
      }, { previous });
      expect(current.endpointChanges.disappeared, name).toBeNull();
      expect(current.sources, name).toContainEqual(expect.objectContaining({
        path: "/internal/status/endpoints",
        state,
        reason,
        provenance: expect.objectContaining({
          completeness: state === "unavailable" ? "unavailable" : "partial",
        }),
      }));
    }
  });

  it("requires an independently observed request/run key and never injects it into aggregate snapshots", async () => {
    const unobserved = await collect();
    expect(correlateOllaRoute(unobserved, {
      requestId: "gentle-galloping-9a2d",
      runId: "codex:run-88",
      endpointId: "ml1-id",
      model: "qwen3.8:27b",
    })).toEqual({ state: "unmatched", key: null, snapshot: null });

    const collected = await collect({ "/internal/metrics": 404 }, {
      observedRoutes: [{
        requestId: "gentle-galloping-9a2d",
        runId: "codex:run-88",
        endpointId: "ml1-id",
        model: "qwen3.8:27b",
      }, {
        runId: "codex:run-89",
        endpointId: "ml1-id",
        model: "qwen3.8:27b",
      }],
    });
    const matched = correlateOllaRoute(collected, {
      requestId: "gentle-galloping-9a2d",
      runId: "codex:run-88",
    });
    expect(matched.state).toBe("matched");
    if (matched.state !== "matched") throw new Error("expected exact route match");
    expect(matched.key).toBe("request_id=olla:gentle-galloping-9a2d");
    expect(matched.snapshot.request_id).toBeNull();
    expect(matched.snapshot.run_id).toBeNull();
    expect(matched.snapshot.backend_host).toBe("ml1");

    const runMatched = correlateOllaRoute(collected, { runId: "codex:run-89" });
    expect(runMatched.state).toBe("matched");
    if (runMatched.state !== "matched") throw new Error("expected exact run match");
    expect(runMatched.key).toBe("run_id=codex:run-89");
    expect(runMatched.snapshot.run_id).toBeNull();

    expect(correlateOllaRoute(collected, {
      requestId: "unmatched",
      endpointId: "ml1-id",
      model: "qwen3.8:27b",
    })).toEqual({ state: "unmatched", key: null, snapshot: null });
    expect(correlateOllaRoute(collected, {
      requestId: "no-route",
      model: "qwen3.8:27b",
    })).toEqual({ state: "unmatched", key: null, snapshot: null });
  });

  it("returns ambiguous with both provenance records when JSON and Prometheus match the same route", async () => {
    const collected = await collect({}, {
      observedRoutes: [{
        requestId: "duplicate-route",
        endpointId: "ml1-id",
        model: "qwen3.8:27b",
      }],
    });
    const result = correlateOllaRoute(collected, { requestId: "duplicate-route" });
    expect(result).toMatchObject({
      state: "ambiguous",
      key: "request_id=olla:duplicate-route",
      snapshot: null,
    });
    if (result.state !== "ambiguous") throw new Error("expected duplicate-source ambiguity");
    expect(result.provenance).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "olla-stats-models-include_endpoints-true-include_summary-true" }),
        expect.objectContaining({ source: "olla-metrics" }),
    ]));
    expect(result.provenance).toHaveLength(2);
  });

  it("returns ambiguous with empty provenance when multiple observed routes match the query", async () => {
    const collected = await collect({}, {
      observedRoutes: [
        {
          requestId: "ambiguous-observed",
          endpointId: "ml1-id",
          model: "qwen3.8:27b",
        },
        {
          requestId: "ambiguous-observed",
          endpointId: "ml2-id",
          model: "qwen3.8:27b",
        },
      ],
    });
    const result = correlateOllaRoute(collected, { requestId: "ambiguous-observed" });
    expect(result).toEqual({
      state: "ambiguous",
      key: "request_id=olla:ambiguous-observed",
      snapshot: null,
      provenance: [],
    });
  });

  it("excludes snapshots when route timestamp falls outside the snapshot window", async () => {
    const collected = await collect({ "/internal/metrics": 404 }, {
      observedRoutes: [{
        requestId: "window-test-route",
        endpointId: "ml1-id",
        model: "qwen3.8:27b",
      }],
    });

    const inside = correlateOllaRoute(collected, {
      requestId: "window-test-route",
      timestamp: "2026-09-22T13:30:00.000Z",
    });
    expect(inside.state).toBe("matched");

    const atStart = correlateOllaRoute(collected, {
      requestId: "window-test-route",
      timestamp: "2026-09-22T13:00:00.000Z",
    });
    expect(atStart.state).toBe("matched");

    const before = correlateOllaRoute(collected, {
      requestId: "window-test-route",
      timestamp: "2026-09-22T12:59:59.000Z",
    });
    expect(before.state).toBe("unmatched");

    const atEnd = correlateOllaRoute(collected, {
      requestId: "window-test-route",
      timestamp: "2026-09-22T14:05:00.000Z",
    });
    expect(atEnd.state).toBe("unmatched");
  });

  it("filters snapshot windows using candidate route timestamp when query timestamp is omitted", async () => {
    const collectedInside = await collect({ "/internal/metrics": 404 }, {
      observedRoutes: [{
        requestId: "candidate-window-route-1",
        endpointId: "ml1-id",
        model: "qwen3.8:27b",
        timestamp: "2026-09-22T13:00:00.000Z",
      }],
    });
    const inside = correlateOllaRoute(collectedInside, {
      requestId: "candidate-window-route-1",
    });
    expect(inside.state).toBe("matched");

    const collectedOutside = await collect({ "/internal/metrics": 404 }, {
      observedRoutes: [{
        requestId: "candidate-window-route-2",
        endpointId: "ml1-id",
        model: "qwen3.8:27b",
        timestamp: "2026-09-22T12:59:59.000Z",
      }],
    });
    const outside = correlateOllaRoute(collectedOutside, {
      requestId: "candidate-window-route-2",
    });
    expect(outside.state).toBe("unmatched");
  });

  it("sanitizes query parameters in correlateOllaRoute to match stored candidates", async () => {
    const collected = await collect({ "/internal/metrics": 404 }, {
      observedRoutes: [{
        requestId: "sanitize-query-route",
        endpointId: "ml1-id",
        endpointName: "ml1-5080",
        model: "qwen3.8:27b",
      }],
    });
    const result = correlateOllaRoute(collected, {
      requestId: "sanitize-query-route",
      endpointId: "ml1-id\u0000",
      endpointName: "ml1-5080\u0000",
      model: "qwen3.8:27b\u0001",
    });
    expect(result.state).toBe("matched");

    const emptyQuery = correlateOllaRoute(collected, {
      requestId: "sanitize-query-route",
      endpointId: "",
      model: "",
    });
    expect(emptyQuery.state).toBe("matched");
  });

  it("rejects credential assignments in correlateOllaRoute query parameters and timestamp", async () => {
    const collected = await collect({ "/internal/metrics": 404 }, {
      observedRoutes: [{
        requestId: "safe-route",
        endpointId: "ml1-id",
        model: "qwen3.8:27b",
      }],
    });

    const secret = "Bearer secret-credential-value";
    expect(() => correlateOllaRoute(collected, { requestId: secret })).toThrow("credential-like label value rejected");
    expect(() => correlateOllaRoute(collected, { runId: secret })).toThrow("credential-like label value rejected");
    expect(() => correlateOllaRoute(collected, { requestId: "safe-route", endpointId: secret })).toThrow("credential-like label value rejected");
    expect(() => correlateOllaRoute(collected, { requestId: "safe-route", endpointName: secret })).toThrow("credential-like label value rejected");
    expect(() => correlateOllaRoute(collected, { requestId: "safe-route", model: secret })).toThrow("credential-like label value rejected");
    expect(() => correlateOllaRoute(collected, { requestId: "safe-route", timestamp: secret })).toThrow("credential-like label value rejected");
    expect(() => correlateOllaRoute(collected, { endpointId: secret })).toThrow("credential-like label value rejected");
  });

  it("reports rejected observed routes for invalid keys without dropping valid routes", async () => {
    const collected = await collect({}, {
      observedRoutes: [
        { runId: "run-89", endpointId: "ml1-id" },
        { requestId: "", endpointId: "ml1-id" },
        { endpointId: "ml1-id" },
        { requestId: "req-with-bad-run", runId: "run-90", endpointId: "ml1-id" },
        { requestId: "valid-key-route", endpointId: "ml1-id" },
      ],
    });
    expect(collected.rejectedRoutes).toEqual([
      { reason: "invalid_key" },
      { reason: "invalid_key" },
      { reason: "invalid_key" },
      { reason: "invalid_key" },
    ]);
    expect(collected.observedRoutes).toHaveLength(1);
    expect(collected.observedRoutes[0]!.requestId).toBe("olla:valid-key-route");
  });

  it("reports rejected observed routes for missing endpoints", async () => {
    const collected = await collect({}, {
      observedRoutes: [
        { requestId: "no-endpoint-route" },
        { requestId: "empty-endpoint-route", endpointId: "", endpointName: "" },
      ],
    });
    expect(collected.rejectedRoutes).toEqual([
      { reason: "missing_endpoint" },
      { reason: "missing_endpoint" },
    ]);
    expect(collected.observedRoutes).toEqual([]);
  });

  it("rejects observed routes with control-character-only keys or endpoints", async () => {
    const collected = await collect({}, {
      observedRoutes: [
        { requestId: "\u0000", endpointId: "ml1-id" },
        { requestId: "olla:", endpointId: "ml1-id" },
        { requestId: "valid-key", endpointId: "\u0000", endpointName: "\u0001" },
      ],
    });
    expect(collected.rejectedRoutes).toEqual([
      { reason: "invalid_key" },
      { reason: "invalid_key" },
      { reason: "missing_endpoint" },
    ]);
    expect(collected.observedRoutes).toHaveLength(0);
  });

  it("rejects credential assignments in invalid observed routes instead of masking as rejection", async () => {
    const secret = "Bearer token-secret-val";

    await expect(collect({}, {
      observedRoutes: [{ runId: "bad-key-no-colon", endpointId: secret }],
    })).rejects.toThrow("credential-like label value rejected");

    await expect(collect({}, {
      observedRoutes: [{ requestId: secret }],
    })).rejects.toThrow("credential-like label value rejected");
  });

  it("isolates per-route malformed timestamps in rejectedRoutes and preserves scraped snapshots", async () => {
    const collected = await collect({}, {
      observedRoutes: [
        { requestId: "bad-time-route", endpointId: "ml1-id", timestamp: "not-a-timestamp" },
        { requestId: "good-time-route", endpointId: "ml1-id", timestamp: "2026-09-22T13:30:00Z" },
      ],
    });
    expect(collected.rejectedRoutes).toEqual([{ reason: "malformed_timestamp" }]);
    expect(collected.observedRoutes).toHaveLength(1);
    expect(collected.observedRoutes[0]!.requestId).toBe("olla:good-time-route");
    expect(collected.snapshots.length).toBeGreaterThan(0);
  });

  it("rejects credential assignments in route timestamp before persistence", async () => {
    let capturedError: unknown = null;
    try {
      await collect({}, {
        observedRoutes: [{
          requestId: "secret-timestamp-route",
          endpointId: "ml1-id",
          timestamp: "Bearer token-in-time",
        }],
      });
    } catch (error) {
      capturedError = error;
    }
    expect(capturedError).toBeInstanceOf(PrivacyError);
    expect((capturedError as Error).message).toBe("credential-like label value rejected");
    expect((capturedError as Error).message).not.toContain("token-in-time");
    expect((capturedError as Error).stack).not.toContain("token-in-time");
  });

  it("defaults rejectedRoutes to empty array when observedRoutes is empty or omitted", async () => {
    const unobserved = await collect();
    expect(unobserved.rejectedRoutes).toEqual([]);

    const empty = await collect({}, { observedRoutes: [] });
    expect(empty.rejectedRoutes).toEqual([]);
  });

  const FAKE_SECRET = "FAKE-EXAMPLE-TOKEN";
  const credentialForms: Array<[string, string]> = [
    ["prefixed secret name", `ep-client_secret=${FAKE_SECRET}`],
    ["prefixed token name", `svc-refresh_token=${FAKE_SECRET}`],
    ["header-style name", `x-api-key: ${FAKE_SECRET}`],
    ["comma-joined name", `a,token=${FAKE_SECRET}`],
    ["percent-encoded assignment", `token%3D${FAKE_SECRET}`],
    ["double-encoded assignment", `token%253D${FAKE_SECRET}`],
    ["control-character split name", `tok\u0001en=${FAKE_SECRET}`],
    ["encoded bearer scheme", `Bearer%2520${FAKE_SECRET}`],
    ["matrix session parameter", `svc;jsessionid=${FAKE_SECRET}`],
    ["spaced assignment", `token = ${FAKE_SECRET}`],
    ["assignment still encoded after three decodes", `token%2525253D${FAKE_SECRET}`],
    ["embedded URL userinfo", `see http://reader:${FAKE_SECRET}@ml1`],
    ["scheme-less userinfo", `reader:${FAKE_SECRET}@ml1`],
    ["unspaced digit-leading value", `api_key:3fa85f64-${FAKE_SECRET}`],
  ];

  function endpointsWith(change: (endpoint: Record<string, unknown>) => void): string {
    const endpoints = JSON.parse(fixture("endpoints.json"));
    change(endpoints.endpoints[0]);
    return JSON.stringify(endpoints);
  }

  function expectPrivacyRejected(collected: OllaTelemetryCollection, path: string, label: string): void {
    expect(collected.sources, label).toContainEqual(expect.objectContaining({ path, state: "partial", reason: "privacy" }));
    expect(JSON.stringify(collected), label).not.toContain(FAKE_SECRET);
  }

  for (const [label, value] of credentialForms) {
    it(`rejects a ${label} in every persisted source string`, async () => {
      expectPrivacyRejected(await collect({
        "/internal/status/endpoints": endpointsWith((endpoint) => { endpoint.name = value; }),
      }), "/internal/status/endpoints", `endpoint name: ${label}`);
      expectPrivacyRejected(await collect({
        "/internal/status/endpoints": endpointsWith((endpoint) => { endpoint.url = `http://ml1:5080/v1/${value}`; }),
      }), "/internal/status/endpoints", `endpoint URL path: ${label}`);
      expectPrivacyRejected(await collect({
        "/internal/metrics": `olla_model_requests_total{model="${value}"} 1\n`,
      }), "/internal/metrics", `Prometheus model label: ${label}`);
      const stats = JSON.parse(fixture("model-stats.json"));
      stats.models[0].endpoint_breakdown = { [value]: stats.models[0].endpoint_breakdown["ml1-5080"] };
      const statsPath = "/internal/stats/models?include_endpoints=true&include_summary=true";
      expectPrivacyRejected(
        await collect({ [statsPath]: JSON.stringify(stats) }),
        statsPath,
        `endpoint breakdown key: ${label}`,
      );
      const route = collect({}, { observedRoutes: [{ runId: `codex:${value}`, endpointId: "ml1-id" }] });
      await expect(route, `route run ID: ${label}`).rejects.toThrow("credential-like label value rejected");
    });
  }

  it("keeps telemetry names that merely contain token words", async () => {
    const collected = await collect({
      "/internal/metrics": 'olla_model_requests_total{model="tokenizer-max_tokens:8b"} 1\n',
    });
    expect(snapshot(collected, "metrics_model", "tokenizer-max_tokens:8b").counters.requests).toBe(1);
  });

  it("does not echo an unparseable base URL in the thrown error", async () => {
    const error = await collect({}, { baseUrl: `not a url ${FAKE_SECRET}` }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(`${(error as Error).message}\n${(error as Error).stack ?? ""}`).not.toContain(FAKE_SECRET);
  });

  it("rolls back every snapshot and endpoint lookup from a source rejected mid-way", async () => {
    const endpoints = JSON.parse(fixture("endpoints.json"));
    endpoints.endpoints[1].request_count = "not a number";
    const collected = await collect({ "/internal/status/endpoints": JSON.stringify(endpoints) });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      path: "/internal/status/endpoints",
      state: "partial",
      reason: "malformed",
    }));
    expect(collected.snapshots.some((record) => collected.metadata[record.record_id]?.scope === "endpoint"))
      .toBe(false);
    const enriched = collected.snapshots.filter((record) =>
      collected.metadata[record.record_id]?.endpoint !== null || record.backend_host !== null
    );
    expect(enriched).toEqual([]);
  });

  it("keeps endpoint health unknown instead of measuring zero when status is missing", async () => {
    const collected = await collect({
      "/internal/status/endpoints": endpointsWith((endpoint) => { delete endpoint.status; }),
    });
    const endpoint = snapshot(collected, "endpoint", "ml1-id");
    expect(endpoint.status).toBe("unknown");
    expect(endpoint.counters.health_up).toBeNull();
  });

  it("leaves endpoint disappearance unknown without a valid previous endpoint source", async () => {
    expect((await collect()).endpointChanges.disappeared).toBeNull();
    const previous = await collect({ "/internal/status/endpoints": 404 });
    expect((await collect({}, { previous })).endpointChanges.disappeared).toBeNull();
  });

  it("reports metric health only where an up gauge measured it", async () => {
    const collected = await collect();
    expect(snapshot(collected, "metrics_model", "qwen3.8:27b").status).toBe("unknown");
    expect(snapshot(collected, "metrics").status).toBe("unknown");
    expect(snapshot(collected, "metrics_endpoint", "ml1-id").status).toBe("ok");
    expect(snapshot(collected, "metrics_endpoint", "ml2-id").status).toBe("error");
  });

  it("marks a metric whose family does not match its labels malformed instead of renaming it", async () => {
    const collected = await collect({
      "/internal/metrics": 'olla_requests_total{endpoint="ml1-5080"} 7\n',
    });
    expect(collected.sources).toContainEqual(expect.objectContaining({
      path: "/internal/metrics",
      state: "partial",
      reason: "malformed",
    }));
  });

  it("marks every other source dependency-partial when the status source has no process start", async () => {
    const status = JSON.parse(fixture("status.json"));
    delete status.system.start_time;
    const collected = await collect({ "/internal/status": JSON.stringify(status) });
    expect(collected.snapshots).toHaveLength(0);
    for (const source of collected.sources.filter((candidate) => candidate.path !== "/internal/status")) {
      expect(source, source.path).toMatchObject({ state: "partial", reason: "dependency" });
    }
  });

  it("marks non-numeric and negative Prometheus values malformed", async () => {
    for (const body of ["olla_requests_total NaN\n", "olla_requests_total -1\n", 'olla_model_requests_total{model="a" 1\n']) {
      const collected = await collect({ "/internal/metrics": body });
      expect(collected.sources, body).toContainEqual(expect.objectContaining({
        path: "/internal/metrics",
        state: "partial",
        reason: "malformed",
      }));
    }
  });

  it("keeps hosts whose name contains a credential word when a port follows", async () => {
    const collected = await collect({
      "/internal/status/endpoints": endpointsWith((endpoint) => { endpoint.url = "http://auth01:11434/v1"; }),
    }, { baseUrl: "http://auth-gw:40114" });
    expect(collected.sources.every((source) => source.state === "available")).toBe(true);
    expect(collected.metadata[snapshot(collected, "endpoint", "ml1-id").record_id]?.endpoint?.url)
      .toBe("http://auth01:11434/v1");
  });

  it("rejects credential-like endpoint IDs carried in a caller-supplied previous collection", async () => {
    const previous = await collect();
    const planted = Object.values(previous.metadata).find((metadata) => metadata.scope === "endpoint")!;
    planted.endpoint = { ...planted.endpoint!, id: `token=${FAKE_SECRET}` };
    const result = collect({}, { previous });
    await expect(result).rejects.toThrow("credential-like label value rejected");
    await result.catch((error: Error) => {
      expect(`${error.message}\n${error.stack ?? ""}`).not.toContain(FAKE_SECRET);
    });
  });

  describe("fetch timeout and failure class tracking (#119)", () => {
    it("rejects invalid timeoutMs (negative, zero, or non-finite)", async () => {
      await expect(collect({}, { timeoutMs: 0 })).rejects.toThrow("timeoutMs must be positive");
      await expect(collect({}, { timeoutMs: -10 })).rejects.toThrow("timeoutMs must be positive");
      await expect(collect({}, { timeoutMs: NaN })).rejects.toThrow("timeoutMs must be positive");
    });

    it("marks source unavailable with reason timeout and errorClass TimeoutError on fetch timeout", async () => {
      const collected = await collect({}, {
        timeoutMs: 20,
        fetch: async (url, init) => {
          const path = new URL(url).pathname;
          if (path === "/internal/status/endpoints") {
            return new Promise((_, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(init.signal?.reason ?? new DOMException("The operation timed out.", "TimeoutError"));
              });
            });
          }
          return fixtureFetch({})(url, init);
        },
      });
      const endpointsSource = collected.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(endpointsSource.state).toBe("unavailable");
      expect(endpointsSource.reason).toBe("timeout");
      expect(endpointsSource.errorClass).toBe("TimeoutError");

      const statusSource = collected.sources.find((s) => s.path === "/internal/status")!;
      expect(statusSource.state).toBe("available");
      expect(statusSource.errorClass).toBeNull();
    });

    it("records errorClass for fetch exceptions distinguishing network bugs from protocol errors", async () => {
      const collectedTypeError = await collect({
        "/internal/status/endpoints": new TypeError("network failed"),
      });
      const typeErrorSource = collectedTypeError.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(typeErrorSource.state).toBe("unavailable");
      expect(typeErrorSource.reason).toBe("unreadable");
      expect(typeErrorSource.errorClass).toBe("TypeError");

      const collected500 = await collect({
        "/internal/status/endpoints": 500,
      });
      const source500 = collected500.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(source500.state).toBe("unavailable");
      expect(source500.reason).toBe("unreadable");
      expect(source500.errorClass).toBeNull();

      const collected404 = await collect({
        "/internal/status/endpoints": 404,
      });
      const source404 = collected404.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(source404.state).toBe("unavailable");
      expect(source404.reason).toBe("missing");
      expect(source404.errorClass).toBeNull();
    });

    it("records errorClass for JSON parsing errors", async () => {
      const collected = await collect({
        "/internal/status/models": "{ invalid json body",
      });
      const source = collected.sources.find((s) => s.path === "/internal/status/models")!;
      expect(source.state).toBe("partial");
      expect(source.reason).toBe("malformed");
      expect(source.errorClass).toBe("SyntaxError");
    });

    it("records errorClass for builder exceptions distinguishing programming bugs from malformed data", async () => {
      const endpoints = JSON.parse(fixture("endpoints.json"));
      endpoints.endpoints[1].request_count = "not a number";
      const collected = await collect({ "/internal/status/endpoints": JSON.stringify(endpoints) });
      const source = collected.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(source.state).toBe("partial");
      expect(source.reason).toBe("malformed");
      expect(source.errorClass).toBe("Error");
    });

    it("preserves errorClass null on available and dependency sources", async () => {
      const collected = await collect();
      for (const source of collected.sources) {
        expect(source.state).toBe("available");
        expect(source.errorClass).toBeNull();
      }

      const status = JSON.parse(fixture("status.json"));
      delete status.system.start_time;
      const collectedDep = await collect({ "/internal/status": JSON.stringify(status) });
      const depSource = collectedDep.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(depSource.state).toBe("partial");
      expect(depSource.reason).toBe("dependency");
      expect(depSource.errorClass).toBeNull();
    });

    it("records PrivacyError as errorClass when privacy checks fail", async () => {
      const endpoints = JSON.parse(fixture("endpoints.json"));
      endpoints.endpoints[0].id = "sk-secret1234567890123456";
      const collected = await collect({ "/internal/status/endpoints": JSON.stringify(endpoints) });
      const source = collected.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(source.state).toBe("partial");
      expect(source.reason).toBe("privacy");
      expect(source.errorClass).toBe("PrivacyError");
    });

    it("never leaks error message or URL text into errorClass", async () => {
      const secretUrl = "http://internal-db.local:5432/token=supersecret";
      const customError = new TypeError(`Failed to fetch from ${secretUrl}`);
      // Simulate library error formatting
      customError.name = `FetchError: connect ECONNREFUSED ${secretUrl}`;
      const collected = await collect({}, {
        fetch: async () => Promise.reject(customError),
      });
      const source = collected.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(source.state).toBe("unavailable");
      expect(source.reason).toBe("unreadable");
      expect(source.errorClass).toBe("TypeError");
      expect(JSON.stringify(source)).not.toContain("supersecret");
      expect(JSON.stringify(source)).not.toContain("5432");
    });

    it("handles non-string or credential-like error.name without crashing", async () => {
      const malformedError = { name: 404, message: "not found" };
      const collected = await collect({}, {
        fetch: async () => Promise.reject(malformedError),
      });
      const source = collected.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(source.state).toBe("unavailable");
      expect(source.reason).toBe("unreadable");
      expect(source.errorClass).toBe("Error");

      const credentialError = { name: "sk-secret1234567890123456", message: "credential in name" };
      const collectedCred = await collect({}, {
        fetch: async () => Promise.reject(credentialError),
      });
      const sourceCred = collectedCred.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(sourceCred.state).toBe("unavailable");
      expect(sourceCred.reason).toBe("unreadable");
      expect(sourceCred.errorClass).toBe("Error");
    });

    it("evaluates errorClassName accurately across error types", () => {
      expect(errorClassName(new TypeError("bug"))).toBe("TypeError");
      expect(errorClassName(new SyntaxError("syntax"))).toBe("SyntaxError");
      expect(errorClassName(new DOMException("timed out", "TimeoutError"))).toBe("TimeoutError");
      expect(errorClassName(new DOMException("aborted", "AbortError"))).toBe("AbortError");
      expect(errorClassName({ name: 404 })).toBe("Error");
      expect(errorClassName({ name: "token=leak" })).toBe("Error");
      expect(errorClassName({ name: "sk-secret1234567890123456" })).toBe("Error");
      expect(errorClassName("failed")).toBe("string");
      expect(errorClassName(null)).toBe("object");
    });

    it("attaches default AbortSignal and normalizes errorClass to TimeoutError on client abort", async () => {
      let sawSignal = false;
      const collected = await collect({}, {
        fetch: async (url, init) => {
          if (init?.signal instanceof AbortSignal) sawSignal = true;
          const path = new URL(url).pathname;
          if (path === "/internal/status/endpoints") {
            const err = new DOMException("The operation was aborted.", "AbortError");
            return new Promise((_, reject) => {
              init?.signal?.addEventListener("abort", () => reject(err));
            });
          }
          return fixtureFetch({})(url, init);
        },
        timeoutMs: 15,
      });
      expect(sawSignal).toBe(true);
      const source = collected.sources.find((s) => s.path === "/internal/status/endpoints")!;
      expect(source.state).toBe("unavailable");
      expect(source.reason).toBe("timeout");
      expect(source.errorClass).toBe("TimeoutError");
    });
  });
});
