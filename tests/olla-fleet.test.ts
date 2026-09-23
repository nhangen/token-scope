import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseFleetRecord, snapshotCounterDelta } from "@/fleet-contract";
import {
  collectOllaTelemetry,
  correlateOllaRoute,
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
  fetch?: OllaFetch;
  previous?: OllaTelemetryCollection;
  observedRoutes?: Array<{
    requestId?: string;
    runId?: string;
    sessionId?: string;
    endpointId?: string;
    endpointName?: string;
    model?: string;
  }>;
} = {}): Promise<OllaTelemetryCollection> {
  return collectOllaTelemetry({
    baseUrl: opts.baseUrl ?? "http://router.local:40114",
    collectedAt: opts.collectedAt ?? COLLECTED_AT,
    staleAfterMs: 60_000,
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
    expect(collected.snapshots.length).toBeGreaterThan(5);
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
      expect(source.provenance.locator).toContain(source.path);
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
      await result.catch((error) => {
        expect(JSON.stringify(error)).not.toContain(privacyCase.secret);
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

  it("matches exact observed request, run, and session routes without requiring an observed model", async () => {
    const collected = await collect({}, {
      observedRoutes: [{
        requestId: "request-without-model",
        endpointId: "ml1-id",
      }, {
        runId: "ollama-agent:author%3A91",
        endpointId: "ml1-id",
      }, {
        sessionId: "ollama-agent:session-without-model",
        endpointId: "ml1-id",
      }],
    });
    const cases = [
      {
        route: { requestId: "request-without-model", model: "qwen3.8:27b" },
        key: "request_id=olla:request-without-model",
      },
      {
        route: { runId: "ollama-agent:author%3A91", model: "qwen3.8:27b" },
        key: "run_id=ollama-agent:author%3A91",
      },
      {
        route: { sessionId: "ollama-agent:session-without-model", model: "qwen3.8:27b" },
        key: "session_id=ollama-agent:session-without-model",
      },
    ];
    for (const testCase of cases) {
      const result = correlateOllaRoute(collected, testCase.route);
      expect(result.state, testCase.key).toBe("matched");
      if (result.state !== "matched") throw new Error("expected model-optional route match");
      expect(result.key).toBe(testCase.key);
      expect(result.snapshot.backend_host).toBe("ml1");
    }
  });

  it("falls through request, run, and session correlation IDs by precedence", async () => {
    const collected = await collect({}, {
      observedRoutes: [{
        runId: "ollama-agent:author%3A91",
        endpointId: "ml1-id",
      }, {
        sessionId: "ollama-agent:session-91",
        endpointId: "ml2-id",
      }],
    });

    const runMatch = correlateOllaRoute(collected, {
      requestId: "unobserved-request",
      runId: "ollama-agent:author%3A91",
      sessionId: "ollama-agent:session-91",
    });
    expect(runMatch.state).toBe("matched");
    if (runMatch.state !== "matched") throw new Error("expected run fallback match");
    expect(runMatch.key).toBe("run_id=ollama-agent:author%3A91");
    expect(runMatch.snapshot.backend_host).toBe("ml1");

    const sessionMatch = correlateOllaRoute(collected, {
      requestId: "unobserved-request",
      runId: "ollama-agent:unobserved-run",
      sessionId: "ollama-agent:session-91",
    });
    expect(sessionMatch.state).toBe("matched");
    if (sessionMatch.state !== "matched") throw new Error("expected session fallback match");
    expect(sessionMatch.key).toBe("session_id=ollama-agent:session-91");
    expect(sessionMatch.snapshot.backend_host).toBe("ml2");
  });

  it("keeps multiple distinct observations at the selected precedence ambiguous", async () => {
    const collected = await collect({}, {
      observedRoutes: [{
        runId: "ollama-agent:ambiguous-run",
        endpointId: "ml1-id",
      }, {
        runId: "ollama-agent:ambiguous-run",
        endpointId: "ml2-id",
      }],
    });

    const result = correlateOllaRoute(collected, {
      requestId: "unobserved-request",
      runId: "ollama-agent:ambiguous-run",
    });
    expect(result).toEqual({
      state: "ambiguous",
      key: "run_id=ollama-agent:ambiguous-run",
      snapshot: null,
      provenance: [],
    });
  });

  it("deduplicates JSON and Prometheus observations of the same model-absent backend", async () => {
    const collected = await collect({}, {
      observedRoutes: [{
        requestId: "duplicate-route",
        endpointId: "ml1-id",
      }],
    });
    const result = correlateOllaRoute(collected, { requestId: "duplicate-route" });
    expect(result.state).toBe("matched");
    if (result.state !== "matched") throw new Error("expected one canonical backend match");
    expect(result.key).toBe("request_id=olla:duplicate-route");
    expect(result.snapshot.backend_host).toBe("ml1");
  });

  it("preserves ambiguity when one endpoint name identifies distinct backends", async () => {
    const endpoints = JSON.parse(fixture("endpoints.json"));
    endpoints.endpoints[1].name = endpoints.endpoints[0].name;
    const collected = await collect({
      "/internal/status/endpoints": JSON.stringify(endpoints),
    }, {
      observedRoutes: [{
        requestId: "ambiguous-route",
        endpointName: endpoints.endpoints[0].name,
      }],
    });
    const result = correlateOllaRoute(collected, { requestId: "ambiguous-route" });
    expect(result.state).toBe("ambiguous");
    if (result.state !== "ambiguous") throw new Error("expected distinct-backend ambiguity");
    expect(result.key).toBe("request_id=olla:ambiguous-route");
    expect(result.provenance.length).toBeGreaterThan(0);
  });
});
