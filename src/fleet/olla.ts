import {
  FLEET_SCHEMA_VERSION,
  parseFleetRecord,
  type FleetOperationalSnapshot,
  type FleetProvenance,
  type FleetRecordStatus,
} from "@/fleet-contract";

const JSON_PATHS = [
  "/internal/status",
  "/internal/status/endpoints",
  "/internal/status/models",
  "/internal/stats/models?include_endpoints=true&include_summary=true",
] as const;
const METRICS_PATH = "/internal/metrics" as const;
const SOURCE_PATHS = [...JSON_PATHS, METRICS_PATH] as const;

export type OllaSourcePath = (typeof SOURCE_PATHS)[number];
export type OllaFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface OllaEndpointMetadata {
  id: string;
  name: string;
  type: string | null;
  url: string | null;
  host: string | null;
  status: string | null;
  priority: number | null;
}

export interface OllaRoutingMetadata {
  engine: string | null;
  profile: string | null;
  balancer: string | null;
}

export type OllaSnapshotScope =
  | "system"
  | "endpoint"
  | "model_status"
  | "model_stats"
  | "model_endpoint"
  | "metrics"
  | "metrics_endpoint"
  | "metrics_model"
  | "metrics_model_endpoint";

export interface OllaSnapshotMetadata {
  scope: OllaSnapshotScope;
  sourcePath: OllaSourcePath;
  endpoint: OllaEndpointMetadata | null;
  model: string | null;
  routing: OllaRoutingMetadata | null;
}

export interface OllaSourceObservation {
  path: OllaSourcePath;
  state: "available" | "partial" | "unavailable";
  reason: "stale" | "missing" | "unreadable" | "malformed" | "privacy" | "dependency" | null;
  provenance: FleetProvenance;
}

export interface OllaTelemetryCollection {
  snapshots: FleetOperationalSnapshot[];
  metadata: Record<string, OllaSnapshotMetadata>;
  sources: OllaSourceObservation[];
  endpointChanges: { disappeared: string[] | null };
  observedRoutes: OllaObservedRoute[];
}

export interface CollectOllaTelemetryOptions {
  baseUrl: string;
  collectedAt?: string;
  staleAfterMs?: number;
  fetch?: OllaFetch;
  previous?: OllaTelemetryCollection;
  observedRoutes?: OllaRouteObservation[];
}

export interface OllaRouteCorrelation {
  requestId?: string;
  runId?: string;
  endpointId?: string;
  endpointName?: string;
  model?: string;
  timestamp?: string;
}

export interface OllaRouteObservation extends OllaRouteCorrelation {}

export interface OllaObservedRoute {
  requestId: string | null;
  runId: string | null;
  endpointId: string | null;
  endpointName: string | null;
  model: string | null;
  timestamp: string | null;
}

export type OllaRouteCorrelationResult =
  | { state: "matched"; key: string; snapshot: FleetOperationalSnapshot }
  | { state: "unmatched"; key: string | null; snapshot: null }
  | { state: "ambiguous"; key: string; snapshot: null; provenance: FleetProvenance[] };

class PrivacyError extends Error {}

const PRIVATE_KEYS = new Set([
  "authorization",
  "credential",
  "credentials",
  "headers",
  "prompt",
  "prompt_text",
  "raw_authorization_headers",
  "terminal_content",
  "terminal_scrollback",
]);

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function measurement(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function optionalMeasurement(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function canonicalTimestamp(value: unknown, name: string): string {
  const raw = stringValue(value, name);
  const milliseconds = Date.parse(raw);
  if (Number.isNaN(milliseconds)) throw new Error(`${name} must be a timestamp`);
  return new Date(milliseconds).toISOString();
}

function assertNoPrivateFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) assertNoPrivateFields(child);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key.toLowerCase().replaceAll("-", "_"))) {
      throw new PrivacyError("private source field rejected");
    }
    assertNoPrivateFields(child);
  }
}

function safeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256);
}

function assertSafeLabelValue(value: string): void {
  if (/\b(?:bearer|basic)(?:\s+|%20)\S+/i.test(value)) {
    throw new PrivacyError("credential-like label value rejected");
  }
  if (/(?:^|[?&#/:;\s])(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret|token|key)\s*[:=]\s*\S+/i.test(value)) {
    throw new PrivacyError("credential-like label value rejected");
  }
  try {
    const parsed = new URL(value);
    const sensitiveQuery = [...parsed.searchParams.keys()].some((key) =>
      /^(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret|token|key)$/i.test(key)
    );
    if (parsed.username !== "" || parsed.password !== "" || sensitiveQuery) {
      throw new PrivacyError("credential-like label value rejected");
    }
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
  }
}

function privateSafeLabel(value: string): string {
  assertSafeLabelValue(value);
  return safeLabel(value);
}

function privateSafePersistenceValue<T>(value: T): T {
  if (typeof value === "string") return privateSafeLabel(value) as T;
  if (Array.isArray(value)) return value.map(privateSafePersistenceValue) as T;
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).map(([key, child]) => {
    if (PRIVATE_KEYS.has(key.toLowerCase().replaceAll("-", "_"))) {
      throw new PrivacyError("private persistence field rejected");
    }
    return [privateSafeLabel(key), privateSafePersistenceValue(child)];
  });
  return Object.fromEntries(entries) as T;
}

function optionalPrivateSafeLabel(value: unknown): string | null {
  const label = optionalString(value);
  return label === null ? null : privateSafeLabel(label);
}

function sanitizedUrl(value: unknown): { url: string | null; host: string | null } {
  if (typeof value !== "string" || value.length === 0) return { url: null, host: null };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { url: null, host: null };
    }
    assertSafeLabelValue(decodedUrlComponent(parsed.pathname));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return { url: parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "" : "/"), host: parsed.hostname };
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
    return { url: null, host: null };
  }
}

function decodedUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PrivacyError("invalid encoded URL component rejected");
  }
}

function sanitizedBaseUrl(value: string): { baseUrl: string; provenanceBaseUrl: string; host: string } {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Olla base URL must use HTTP or HTTPS");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new PrivacyError("credential-bearing Olla base URL rejected");
  }
  assertSafeLabelValue(value);
  assertSafeLabelValue(decodedUrlComponent(parsed.pathname));
  assertSafeLabelValue(decodedUrlComponent(parsed.search));
  assertSafeLabelValue(decodedUrlComponent(parsed.hash));
  const provenanceBaseUrl = privateSafeLabel(parsed.origin);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return {
    baseUrl: parsed.toString().replace(/\/$/, ""),
    provenanceBaseUrl,
    host: privateSafeLabel(parsed.hostname),
  };
}

function sourceName(path: OllaSourcePath): string {
  return `olla-${path.replace(/^\/internal\//, "").replaceAll(/[/?=&]+/g, "-")}`;
}

function provenanceFor(
  baseUrl: string,
  path: OllaSourcePath,
  collectedAt: string,
  completeness: FleetProvenance["completeness"],
): FleetProvenance {
  return {
    source: sourceName(path),
    locator: `${baseUrl}${path}`,
    collected_at: collectedAt,
    completeness,
  };
}

function recordStatus(
  health: FleetRecordStatus,
  provenance: FleetProvenance,
): FleetRecordStatus {
  return provenance.completeness === "partial" ? "partial" : health;
}

function parseLatency(value: unknown): number | null {
  if (typeof value === "number") return optionalMeasurement(value);
  if (typeof value !== "string") return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(ns|us|µs|ms|s)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ns") return amount / 1_000_000;
  if (unit === "us" || unit === "µs") return amount / 1_000;
  if (unit === "s") return amount * 1_000;
  return amount;
}

function endpointHealth(status: string | null): FleetRecordStatus {
  return status === "healthy" ? "ok" : status === null ? "unknown" : "error";
}

function systemHealth(status: string | null): FleetRecordStatus {
  return status === "healthy" ? "ok" : status === null ? "unknown" : "error";
}

interface LoadedSource {
  path: OllaSourcePath;
  body: string | null;
  value: unknown;
  observation: OllaSourceObservation;
}

interface AdapterContext {
  baseUrl: string;
  routerHost: string;
  collectedAt: string;
  staleAfterMs: number;
  processStart: string | null;
  processId: string | null;
  endpointById: Map<string, OllaEndpointMetadata>;
  endpointByName: Map<string, OllaEndpointMetadata[]>;
  snapshots: FleetOperationalSnapshot[];
  metadata: Record<string, OllaSnapshotMetadata>;
}

function setObservation(
  source: LoadedSource,
  state: OllaSourceObservation["state"],
  reason: OllaSourceObservation["reason"],
): void {
  source.observation.state = state;
  source.observation.reason = reason;
  source.observation.provenance = {
    ...source.observation.provenance,
    completeness: state === "unavailable" ? "unavailable" : state === "partial" ? "partial" : "complete",
  };
}

function sourceTimestamp(source: LoadedSource): string {
  return canonicalTimestamp(objectValue(source.value, source.path).timestamp, `${source.path}.timestamp`);
}

function windowFor(context: AdapterContext, timestamp: string): { start: string; end: string } {
  if (context.processStart === null || Date.parse(context.processStart) >= Date.parse(timestamp)) {
    throw new Error("Olla process start is unavailable for cumulative counters");
  }
  return { start: context.processStart, end: timestamp };
}

function addSnapshot(
  context: AdapterContext,
  source: LoadedSource,
  input: {
    scope: OllaSnapshotScope;
    identity: string;
    timestamp: string;
    health: FleetRecordStatus;
    backendHost?: string | null;
    backend?: string | null;
    model?: string | null;
    counters: Record<string, number | null>;
    endpoint?: OllaEndpointMetadata | null;
    routing?: OllaRoutingMetadata | null;
  },
): void {
  const safeInput = privateSafePersistenceValue(input);
  const recordIdScope = privateSafeLabel(safeInput.scope);
  const recordIdIdentity = privateSafeLabel(safeInput.identity);
  const recordIdTimestamp = privateSafeLabel(safeInput.timestamp);
  const candidate: FleetOperationalSnapshot = {
    schema_version: FLEET_SCHEMA_VERSION,
    record_type: "operational_snapshot",
    record_id: `olla:${recordIdScope}:${encodeURIComponent(recordIdIdentity)}:${recordIdTimestamp}`,
    run_id: null,
    session_id: null,
    request_id: null,
    prompt_origin_host: null,
    execution_host: null,
    router_host: context.routerHost,
    backend_host: safeInput.backendHost ?? null,
    harness: null,
    provider: "olla",
    backend: safeInput.backend ?? null,
    model: safeInput.model ?? null,
    timestamp: safeInput.timestamp,
    status: recordStatus(safeInput.health, source.observation.provenance),
    provenance: source.observation.provenance,
    window: windowFor(context, input.timestamp),
    process_id: context.processId,
    stale_after_ms: context.staleAfterMs,
    counters: Object.fromEntries(
      Object.entries(safeInput.counters).filter(([, value]) =>
        value === null || (Number.isFinite(value) && value >= 0)
      ),
    ),
  };
  const record = privateSafePersistenceValue(candidate);
  const parsed = parseFleetRecord(record);
  if (parsed.record_type !== "operational_snapshot") throw new Error("wrong snapshot type");
  context.snapshots.push(parsed);
  context.metadata[parsed.record_id] = privateSafePersistenceValue({
    scope: safeInput.scope,
    sourcePath: source.path,
    endpoint: safeInput.endpoint ?? null,
    model: safeInput.model ?? null,
    routing: safeInput.routing ?? null,
  });
}

function endpointMetadata(value: unknown): OllaEndpointMetadata {
  const endpoint = objectValue(value, "endpoint");
  const display = sanitizedUrl(endpoint.url);
  return privateSafePersistenceValue({
    id: stringValue(endpoint.id, "endpoint.id"),
    name: stringValue(endpoint.name, "endpoint.name"),
    type: optionalString(endpoint.type),
    url: display.url,
    host: display.host,
    status: optionalString(endpoint.status),
    priority: optionalMeasurement(endpoint.priority),
  });
}

function uniqueEndpointByName(context: AdapterContext, name: string): OllaEndpointMetadata | null {
  const endpoints = context.endpointByName.get(name) ?? [];
  return endpoints.length === 1 ? endpoints[0]! : null;
}

function buildSystem(source: LoadedSource, context: AdapterContext): void {
  const root = objectValue(source.value, source.path);
  const system = objectValue(root.system, "status.system");
  const proxy = objectValue(root.proxy, "status.proxy");
  const security = objectValue(root.security, "status.security");
  const violations = objectValue(security.violations, "status.security.violations");
  const timestamp = canonicalTimestamp(root.timestamp, "status.timestamp");
  const engine = optionalPrivateSafeLabel(proxy.engine);
  const profile = optionalPrivateSafeLabel(proxy.profile);
  const balancer = optionalPrivateSafeLabel(proxy.balancer);
  addSnapshot(context, source, {
    scope: "system",
    identity: context.routerHost,
    timestamp,
    health: systemHealth(optionalString(system.status)),
    backend: engine,
    counters: {
      requests: measurement(system.total_requests, "system.total_requests"),
      failures: measurement(system.total_failures, "system.total_failures"),
      avg_latency_ms: parseLatency(system.avg_latency),
      active_connections: measurement(system.active_connections, "system.active_connections"),
      security_violations: measurement(system.security_violations, "system.security_violations"),
      blocked_ips: measurement(security.blocked_ips, "security.blocked_ips"),
      rate_limit_violations: measurement(violations.rate_limits, "violations.rate_limits"),
      size_limit_violations: measurement(violations.size_limits, "violations.size_limits"),
    },
    routing: {
      engine,
      profile,
      balancer,
    },
  });
}

function buildEndpoints(source: LoadedSource, context: AdapterContext): void {
  const root = objectValue(source.value, source.path);
  const timestamp = canonicalTimestamp(root.timestamp, "endpoints.timestamp");
  const entries = arrayValue(root.endpoints, "endpoints.endpoints").map((value) => ({
    endpoint: endpointMetadata(value),
    raw: objectValue(value, "endpoint"),
  }));
  for (const { endpoint, raw } of entries) {
    context.endpointById.set(endpoint.id, endpoint);
    const named = context.endpointByName.get(endpoint.name) ?? [];
    named.push(endpoint);
    context.endpointByName.set(endpoint.name, named);
    addSnapshot(context, source, {
      scope: "endpoint",
      identity: endpoint.id,
      timestamp,
      health: endpointHealth(endpoint.status),
      backendHost: endpoint.host,
      backend: endpoint.type,
      counters: {
        health_up: endpoint.status === "healthy" ? 1 : 0,
        requests: measurement(raw.request_count, "endpoint.request_count"),
        avg_latency_ms: optionalMeasurement(raw.avg_latency_ms),
        min_latency_ms: optionalMeasurement(raw.min_latency_ms),
        max_latency_ms: optionalMeasurement(raw.max_latency_ms),
        active_connections: measurement(raw.active_connections, "endpoint.active_connections"),
        models: measurement(raw.model_count, "endpoint.model_count"),
      },
      endpoint,
    });
  }
}

function buildModelStatus(source: LoadedSource, context: AdapterContext): void {
  const root = objectValue(source.value, source.path);
  const timestamp = canonicalTimestamp(root.timestamp, "models.timestamp");
  for (const value of arrayValue(root.recent_models, "models.recent_models")) {
    const model = objectValue(value, "model");
    const name = privateSafeLabel(stringValue(model.name, "model.name"));
    let endpointCount: number | null = null;
    if (model.endpoint_ids !== undefined) {
      const endpointIds = arrayValue(model.endpoint_ids, "model.endpoint_ids");
      if (endpointIds.some((id) => typeof id !== "string" || id.length === 0)) {
        throw new Error("model.endpoint_ids must contain non-empty strings");
      }
      endpointCount = endpointIds.length;
    }
    addSnapshot(context, source, {
      scope: "model_status",
      identity: name,
      timestamp,
      health: endpointCount !== null && endpointCount > 0 ? "ok" : "unknown",
      model: name,
      counters: { endpoints: endpointCount },
    });
  }
}

function buildModelStats(source: LoadedSource, context: AdapterContext): void {
  const root = objectValue(source.value, source.path);
  const timestamp = canonicalTimestamp(root.timestamp, "model stats.timestamp");
  for (const value of arrayValue(root.models, "model stats.models")) {
    const model = objectValue(value, "model stats model");
    const name = privateSafeLabel(stringValue(model.name, "model.name"));
    addSnapshot(context, source, {
      scope: "model_stats",
      identity: name,
      timestamp,
      health: "unknown",
      model: name,
      counters: {
        requests: measurement(model.total_requests, "model.total_requests"),
        successful_requests: measurement(model.successful_requests, "model.successful_requests"),
        failed_requests: measurement(model.failed_requests, "model.failed_requests"),
        avg_latency_ms: parseLatency(model.average_latency),
        p95_latency_ms: parseLatency(model.p95_latency),
        p99_latency_ms: parseLatency(model.p99_latency),
        unique_clients: measurement(model.unique_clients, "model.unique_clients"),
        routing_hits: measurement(model.routing_hits, "model.routing_hits"),
        routing_misses: measurement(model.routing_misses, "model.routing_misses"),
        routing_fallbacks: measurement(model.routing_fallbacks, "model.routing_fallbacks"),
      },
    });
    if (model.endpoint_breakdown === undefined) continue;
    for (const [endpointName, endpointValue] of Object.entries(objectValue(
      model.endpoint_breakdown,
      "model.endpoint_breakdown",
    ))) {
      const safeEndpointName = privateSafeLabel(endpointName);
      const endpointStats = objectValue(endpointValue, "model endpoint stats");
      const endpoint = uniqueEndpointByName(context, safeEndpointName);
      addSnapshot(context, source, {
        scope: "model_endpoint",
        identity: `${name}:${endpoint?.id ?? safeEndpointName}`,
        timestamp,
        health: measurement(endpointStats.consecutive_errors, "endpoint.consecutive_errors") > 0
          ? "error"
          : "ok",
        backendHost: endpoint?.host ?? null,
        backend: endpoint?.type ?? null,
        model: name,
        counters: {
          requests: measurement(endpointStats.request_count, "endpoint.request_count"),
          avg_latency_ms: parseLatency(endpointStats.average_latency),
          success_rate_percent: measurement(endpointStats.success_rate, "endpoint.success_rate"),
          consecutive_errors: measurement(endpointStats.consecutive_errors, "endpoint.consecutive_errors"),
        },
        endpoint,
      });
    }
  }
}

interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseMetricLabels(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.length === 0) return {};
  const labels: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"(?:,|$)/g;
  let consumed = 0;
  for (const match of raw.matchAll(pattern)) {
    if (match.index !== consumed) throw new Error("malformed Prometheus labels");
    const key = match[1]!;
    if (PRIVATE_KEYS.has(key.toLowerCase().replaceAll("-", "_"))) {
      throw new PrivacyError("private metric label rejected");
    }
    const value = match[2]!.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    assertSafeLabelValue(value);
    labels[key] = value;
    consumed = match.index + match[0].length;
  }
  if (consumed !== raw.length) throw new Error("malformed Prometheus labels");
  return labels;
}

function parsePrometheus(body: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(olla_[a-zA-Z0-9_]+)(?:\{(.*)\})?\s+([^\s]+)(?:\s+\d+)?$/.exec(line);
    if (!match) throw new Error("malformed Prometheus sample");
    const value = Number(match[3]);
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid Prometheus value");
    samples.push({ name: match[1]!, labels: parseMetricLabels(match[2]), value });
  }
  return samples;
}

function counterName(metric: string, prefix: string): string {
  const name = metric.slice(prefix.length).replace(/_total$/, "");
  return prefix === "olla_endpoint_" && name === "up" ? "health_up" : name;
}

function buildMetrics(source: LoadedSource, context: AdapterContext): void {
  if (source.body === null) throw new Error("metrics body unavailable");
  const samples = parsePrometheus(source.body);
  const groups = new Map<string, {
    scope: OllaSnapshotScope;
    identity: string;
    endpoint: OllaEndpointMetadata | null;
    model: string | null;
    counters: Record<string, number>;
    health: FleetRecordStatus;
  }>();
  const group = (
    key: string,
    scope: OllaSnapshotScope,
    identity: string,
    endpoint: OllaEndpointMetadata | null,
    model: string | null,
  ) => {
    const existing = groups.get(key) ?? { scope, identity, endpoint, model, counters: {}, health: "ok" as const };
    groups.set(key, existing);
    return existing;
  };
  for (const sample of samples) {
    const endpointName = sample.labels.endpoint;
    const model = sample.labels.model === undefined ? null : privateSafeLabel(sample.labels.model);
    if (endpointName !== undefined && model !== null) {
      const safeEndpointName = privateSafeLabel(endpointName);
      const endpoint = uniqueEndpointByName(context, safeEndpointName);
      const entry = group(
        `model-endpoint:${model}:${safeEndpointName}`,
        "metrics_model_endpoint",
        `${model}:${endpoint?.id ?? safeEndpointName}`,
        endpoint,
        model,
      );
      entry.counters[counterName(sample.name, "olla_model_endpoint_")] = sample.value;
      continue;
    }
    if (endpointName !== undefined) {
      const safeEndpointName = privateSafeLabel(endpointName);
      const endpoint = uniqueEndpointByName(context, safeEndpointName);
      const entry = group(
        `endpoint:${safeEndpointName}`,
        "metrics_endpoint",
        endpoint?.id ?? safeEndpointName,
        endpoint,
        null,
      );
      entry.counters[counterName(sample.name, "olla_endpoint_")] = sample.value;
      if (sample.name === "olla_endpoint_up" && sample.value === 0) entry.health = "error";
      continue;
    }
    if (model !== null) {
      const entry = group(`model:${model}`, "metrics_model", model, null, model);
      entry.counters[counterName(sample.name, "olla_model_")] = sample.value;
      continue;
    }
    if (Object.keys(sample.labels).length > 0) continue;
    const entry = group("system", "metrics", context.routerHost, null, null);
    entry.counters[counterName(sample.name, "olla_")] = sample.value;
  }
  for (const entry of groups.values()) {
    addSnapshot(context, source, {
      scope: entry.scope,
      identity: entry.identity,
      timestamp: context.collectedAt,
      health: entry.health,
      backendHost: entry.endpoint?.host ?? null,
      backend: entry.endpoint?.type ?? null,
      model: entry.model,
      counters: entry.counters,
      endpoint: entry.endpoint,
    });
  }
}

function sourceEndpointIds(collection: OllaTelemetryCollection): string[] {
  return [...new Set(Object.values(collection.metadata)
    .filter((metadata) => metadata.scope === "endpoint")
    .map((metadata) => metadata.endpoint?.id)
    .filter((id): id is string => id !== undefined))].sort();
}

function qualifiedRequestId(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  const id = privateSafeLabel(value);
  return id.startsWith("olla:") ? id : `olla:${id}`;
}

function qualifiedRunId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const id = privateSafeLabel(value);
  const separator = id.indexOf(":");
  return separator > 0 && separator < id.length - 1 ? id : null;
}

function normalizeObservedRoutes(routes: OllaRouteObservation[] | undefined): OllaObservedRoute[] {
  const normalized = (routes ?? []).map((route): OllaObservedRoute | null => {
    const requestId = qualifiedRequestId(route.requestId);
    const runId = qualifiedRunId(route.runId);
    const endpointId = route.endpointId === undefined ? null : privateSafeLabel(route.endpointId);
    const endpointName = route.endpointName === undefined ? null : privateSafeLabel(route.endpointName);
    const model = route.model === undefined ? null : privateSafeLabel(route.model);
    if ((requestId === null && runId === null) || (endpointId === null && endpointName === null)) return null;
    return {
      requestId,
      runId,
      endpointId,
      endpointName,
      model,
      timestamp: route.timestamp === undefined ? null : canonicalTimestamp(route.timestamp, "route.timestamp"),
    };
  }).filter((route): route is OllaObservedRoute => route !== null);
  const byValue = new Map(normalized.map((route) => [JSON.stringify(route), route]));
  return [...byValue.values()];
}

export async function collectOllaTelemetry(
  options: CollectOllaTelemetryOptions,
): Promise<OllaTelemetryCollection> {
  const { baseUrl, provenanceBaseUrl, host } = sanitizedBaseUrl(options.baseUrl);
  const collectedAt = canonicalTimestamp(options.collectedAt ?? new Date().toISOString(), "collectedAt");
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error("staleAfterMs must be non-negative");
  }
  const fetcher = options.fetch ?? ((url: string) => fetch(url));
  const loaded = await Promise.all(SOURCE_PATHS.map(async (path): Promise<LoadedSource> => {
    const observation: OllaSourceObservation = {
      path,
      state: "available",
      reason: null,
      provenance: provenanceFor(provenanceBaseUrl, path, collectedAt, "complete"),
    };
    try {
      const response = await fetcher(`${baseUrl}${path}`, { method: "GET" });
      if (!response.ok) {
        const state: OllaSourceObservation["state"] = "unavailable";
        observation.state = state;
        observation.reason = response.status === 404 ? "missing" : "unreadable";
        observation.provenance.completeness = "unavailable";
        return { path, body: null, value: null, observation };
      }
      const body = await response.text();
      if (path === METRICS_PATH) return { path, body, value: null, observation };
      try {
        const value = JSON.parse(body);
        assertNoPrivateFields(value);
        const timestamp = canonicalTimestamp(objectValue(value, path).timestamp, `${path}.timestamp`);
        if (Date.parse(collectedAt) - Date.parse(timestamp) > staleAfterMs) {
          observation.state = "partial";
          observation.reason = "stale";
          observation.provenance.completeness = "partial";
        }
        return { path, body, value, observation };
      } catch (error) {
        observation.state = "partial";
        observation.reason = error instanceof PrivacyError ? "privacy" : "malformed";
        observation.provenance.completeness = "partial";
        return { path, body: null, value: null, observation };
      }
    } catch {
      observation.state = "unavailable";
      observation.reason = "unreadable";
      observation.provenance.completeness = "unavailable";
      return { path, body: null, value: null, observation };
    }
  }));
  const byPath = new Map(loaded.map((source) => [source.path, source]));
  const statusSource = byPath.get("/internal/status")!;
  let processStart: string | null = null;
  if (statusSource.value !== null) {
    try {
      const system = objectValue(objectValue(statusSource.value, "status").system, "status.system");
      processStart = canonicalTimestamp(system.start_time, "system.start_time");
    } catch {
      setObservation(statusSource, "partial", "malformed");
      statusSource.value = null;
    }
  }
  const context: AdapterContext = {
    baseUrl,
    routerHost: host,
    collectedAt,
    staleAfterMs,
    processStart,
    processId: processStart === null ? null : `olla:${host}:${processStart}`,
    endpointById: new Map(),
    endpointByName: new Map(),
    snapshots: [],
    metadata: {},
  };
  const builders: Array<[OllaSourcePath, (source: LoadedSource, context: AdapterContext) => void]> = [
    ["/internal/status", buildSystem],
    ["/internal/status/endpoints", buildEndpoints],
    ["/internal/status/models", buildModelStatus],
    ["/internal/stats/models?include_endpoints=true&include_summary=true", buildModelStats],
    [METRICS_PATH, buildMetrics],
  ];
  for (const [path, builder] of builders) {
    const source = byPath.get(path)!;
    if ((path === METRICS_PATH ? source.body : source.value) === null) continue;
    if (processStart === null) {
      setObservation(source, "partial", "dependency");
      continue;
    }
    const snapshotCount = context.snapshots.length;
    const metadataIds = new Set(Object.keys(context.metadata));
    try {
      builder(source, context);
    } catch (error) {
      context.snapshots.splice(snapshotCount);
      for (const id of Object.keys(context.metadata)) {
        if (!metadataIds.has(id)) delete context.metadata[id];
      }
      setObservation(source, "partial", error instanceof PrivacyError ? "privacy" : "malformed");
    }
  }
  const collection: OllaTelemetryCollection = {
    snapshots: context.snapshots.sort((a, b) => a.record_id.localeCompare(b.record_id)),
    metadata: context.metadata,
    sources: loaded.map((source) => source.observation),
    endpointChanges: { disappeared: [] },
    observedRoutes: normalizeObservedRoutes(options.observedRoutes),
  };
  if (options.previous !== undefined) {
    const endpointSource = byPath.get("/internal/status/endpoints")!;
    if (endpointSource.observation.state === "available") {
      const currentIds = new Set(sourceEndpointIds(collection));
      collection.endpointChanges.disappeared = sourceEndpointIds(options.previous)
        .filter((id) => !currentIds.has(id));
    } else {
      collection.endpointChanges.disappeared = null;
    }
  }
  return collection;
}

export function correlateOllaRoute(
  collection: OllaTelemetryCollection,
  route: OllaRouteCorrelation,
): OllaRouteCorrelationResult {
  const requestId = qualifiedRequestId(route.requestId);
  const runId = qualifiedRunId(route.runId);
  if (requestId === null && runId === null) {
    return { state: "unmatched", key: null, snapshot: null };
  }
  const observed = collection.observedRoutes.filter((candidate) => {
    if (requestId !== null && candidate.requestId !== requestId) return false;
    if (requestId === null && runId !== null && candidate.runId !== runId) return false;
    if (runId !== null && candidate.runId !== runId) return false;
    if (route.endpointId !== undefined && candidate.endpointId !== route.endpointId) return false;
    if (route.endpointName !== undefined && candidate.endpointName !== route.endpointName) return false;
    if (route.model !== undefined && candidate.model !== route.model) return false;
    return true;
  });
  if (observed.length === 0) return { state: "unmatched", key: null, snapshot: null };
  const key = requestId !== null ? `request_id=${requestId}` : `run_id=${runId!}`;
  if (observed.length > 1) {
    return { state: "ambiguous", key, snapshot: null, provenance: [] };
  }
  const observedRoute = observed[0]!;
  const scopes: OllaSnapshotScope[] = observedRoute.model === null
    ? ["endpoint", "metrics_endpoint"]
    : ["model_endpoint", "metrics_model_endpoint"];
  const matches = collection.snapshots.filter((snapshot) => {
    const metadata = collection.metadata[snapshot.record_id];
    if (metadata === undefined || !scopes.includes(metadata.scope) || metadata.endpoint === null) return false;
    if (observedRoute.endpointId !== null && metadata.endpoint.id !== observedRoute.endpointId) return false;
    if (observedRoute.endpointName !== null && metadata.endpoint.name !== observedRoute.endpointName) return false;
    if (observedRoute.model !== null && metadata.model !== observedRoute.model) return false;
    const timestampValue = observedRoute.timestamp ?? route.timestamp ?? null;
    if (timestampValue !== null) {
      const timestamp = Date.parse(canonicalTimestamp(timestampValue, "route.timestamp"));
      if (timestamp < Date.parse(snapshot.window.start) || timestamp >= Date.parse(snapshot.window.end)) return false;
    }
    return true;
  });
  if (matches.length === 1) return { state: "matched", key, snapshot: matches[0]! };
  if (matches.length > 1) {
    const provenance = [...new Map(matches.map((snapshot) => [
      JSON.stringify(snapshot.provenance),
      snapshot.provenance,
    ])).values()];
    return { state: "ambiguous", key, snapshot: null, provenance };
  }
  return { state: "unmatched", key: null, snapshot: null };
}
