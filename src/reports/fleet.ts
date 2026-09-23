import { readFileSync } from "fs";
import { collectOrcaPlacement, type OrcaPlacementCollection } from "@/fleet/orca";
import {
  collectOllaTelemetry,
  correlateOllaRoute,
  type OllaRouteObservation,
  type OllaTelemetryCollection,
} from "@/fleet/olla";
import {
  FLEET_SCHEMA_VERSION,
  classifySnapshotFreshness,
  parseFleetRecord,
  type FleetOperationalSnapshot,
  type FleetProvenance,
  type FleetUsageEvent,
} from "@/fleet-contract";
import { collectProviderEvents, type Collected, type ProviderEvent } from "@/providers";
import {
  privateSafeEventId,
  privateSafeProviderIdentity,
  tsMs,
} from "@/providers/types";

export type FleetJoinState =
  | "matched"
  | "provider"
  | "unmatched"
  | "ambiguous"
  | "stale"
  | "partial"
  | "unavailable";

export interface FleetMeasurement {
  value: number;
  unit: "ms" | "tokens/s";
  scope: "request" | "aggregate";
}

export interface FleetReportRow {
  event_id: string;
  timestamp: string | null;
  prompt_origin_host: string | null;
  execution_host: string | null;
  router_host: string | null;
  backend_host: string | null;
  backend: string | null;
  harness: string;
  provider: string;
  model: string | null;
  billing_route: ProviderEvent["billingRoute"];
  request_id: string | null;
  run_id: string | null;
  session_id: string | null;
  status: ProviderEvent["status"];
  input_tokens: number | null;
  output_tokens: number | null;
  cash_charge_usd: number | null;
  placement_state: FleetJoinState;
  route_state: FleetJoinState;
  ttft: FleetMeasurement | null;
  decode_tps: FleetMeasurement | null;
  total_latency: FleetMeasurement | null;
  provenance: Array<FleetProvenance & { scope: "usage" | "placement" | "aggregate" }>;
}

export interface FleetSourceState {
  source: string;
  state: "available" | "partial" | "unavailable" | "unsupported";
  reason: string | null;
}

export interface FleetReportJson {
  schema_version: typeof FLEET_SCHEMA_VERSION;
  window: string;
  rows: FleetReportRow[];
  sources: FleetSourceState[];
}

interface FleetCollections {
  providers: Collected;
  orca: OrcaPlacementCollection;
  olla: OllaTelemetryCollection | null;
  ollaState: FleetSourceState;
}

const ORCA_MAX_AGE_MS = 5 * 60_000;

function canonicalTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : new Date(milliseconds).toISOString();
}

function usageRecord(
  event: ProviderEvent,
  collectedAt: string,
  promptOriginHost: string | null,
): FleetUsageEvent {
  const eventId = privateSafeProviderIdentity(event.eventId)
    ?? privateSafeEventId("fleet", event.eventId);
  const candidate = {
    schema_version: FLEET_SCHEMA_VERSION,
    record_type: "usage_event",
    record_id: `usage:${eventId}`,
    run_id: event.runId ?? null,
    session_id: event.sessionId ?? null,
    request_id: event.requestId ?? null,
    prompt_origin_host: promptOriginHost,
    execution_host: null,
    router_host: null,
    backend_host: null,
    harness: event.harness,
    provider: event.modelProvider,
    backend: null,
    model: event.model,
    timestamp: canonicalTimestamp(event.ts),
    status: event.status,
    provenance: {
      source: `provider-${event.harness}`,
      locator: event.provenance,
      collected_at: collectedAt,
      completeness: "complete",
    },
    usage: {
      input_tokens: event.inputTokens,
      output_tokens: event.outputTokens,
      cache_read_tokens: event.cacheReadTokens,
      cache_write_tokens: event.cacheWriteTokens,
      reasoning_tokens: event.reasoningTokens,
      cash_charge_usd: event.cashChargeUsd,
    },
  } as const;
  const parsed = parseFleetRecord(candidate);
  if (parsed.record_type !== "usage_event") throw new Error("wrong fleet usage record type");
  return parsed;
}

function fleetEventId(event: ProviderEvent): string {
  return privateSafeProviderIdentity(event.eventId)
    ?? privateSafeEventId("fleet", event.eventId);
}

function incompleteOrcaCoverage(orca: OrcaPlacementCollection): "partial" | "unavailable" | null {
  if (orca.sources.some((source) => source.state === "unavailable")) return "unavailable";
  if (orca.sources.some((source) => source.state === "partial")) return "partial";
  return null;
}

function placementFor(
  usage: FleetUsageEvent,
  orca: OrcaPlacementCollection,
): { state: FleetJoinState; snapshot: FleetOperationalSnapshot | null } {
  const incompleteCoverage = incompleteOrcaCoverage(orca);
  if (orca.records.length === 0 && incompleteCoverage !== null) {
    return { state: incompleteCoverage, snapshot: null };
  }
  let snapshot: FleetOperationalSnapshot | null = null;
  for (const field of ["request_id", "run_id", "session_id"] as const) {
    const identity = usage[field];
    if (identity === null) continue;
    const matches = orca.records.filter((record) => record[field] === identity);
    if (matches.length > 1) return { state: "ambiguous", snapshot: null };
    if (matches.length === 1) {
      snapshot = matches[0]!;
      break;
    }
  }
  if (snapshot === null) {
    return { state: incompleteCoverage ?? "unmatched", snapshot: null };
  }
  if (usage.timestamp === null) {
    return { state: "unmatched", snapshot: null };
  }
  if (Math.abs(Date.parse(snapshot.timestamp) - Date.parse(usage.timestamp)) > ORCA_MAX_AGE_MS) {
    return { state: "stale", snapshot };
  }
  if (snapshot.status === "partial" || snapshot.provenance.completeness === "partial") {
    return { state: "partial", snapshot };
  }
  if (snapshot.status === "unavailable" || snapshot.provenance.completeness === "unavailable") {
    return { state: "unavailable", snapshot };
  }
  return { state: "matched", snapshot };
}

function allOllaSourcesUnavailable(olla: OllaTelemetryCollection): boolean {
  return olla.sources.length > 0 && olla.sources.every((source) => source.state === "unavailable");
}

function aggregateMeasurement(
  snapshot: FleetOperationalSnapshot,
  names: string[],
  unit: FleetMeasurement["unit"],
): FleetMeasurement | null {
  for (const name of names) {
    const value = snapshot.counters[name];
    if (typeof value === "number") return { value, unit, scope: "aggregate" };
  }
  return null;
}

function requestMeasurement(
  value: number | null | undefined,
  unit: FleetMeasurement["unit"],
): FleetMeasurement | null {
  return typeof value === "number" ? { value, unit, scope: "request" } : null;
}

function routeFor(
  event: ProviderEvent,
  usage: FleetUsageEvent,
  olla: OllaTelemetryCollection | null,
  collectedAt: string,
): {
  state: FleetJoinState;
  snapshot: FleetOperationalSnapshot | null;
} {
  if (event.billingRoute !== "local") return { state: "provider", snapshot: null };
  if (olla === null) return { state: "unavailable", snapshot: null };
  if (allOllaSourcesUnavailable(olla)) return { state: "unavailable", snapshot: null };
  const joined = correlateOllaRoute(olla, {
    requestId: usage.request_id ?? undefined,
    runId: usage.run_id ?? undefined,
    sessionId: usage.session_id ?? undefined,
    model: usage.model ?? undefined,
    timestamp: canonicalTimestamp(event.ts) ?? undefined,
  });
  if (joined.state === "ambiguous") return { state: "ambiguous", snapshot: null };
  if (joined.state === "unmatched") {
    const correlatedButIncomplete = joined.key !== null
      && olla.sources.some((source) => source.state === "partial" || source.state === "unavailable");
    return { state: correlatedButIncomplete ? "partial" : "unmatched", snapshot: null };
  }
  if (classifySnapshotFreshness(joined.snapshot, collectedAt) === "stale") {
    return { state: "stale", snapshot: joined.snapshot };
  }
  if (joined.snapshot.status === "partial" || joined.snapshot.provenance.completeness === "partial") {
    return { state: "partial", snapshot: joined.snapshot };
  }
  if (joined.snapshot.status === "unavailable" || joined.snapshot.provenance.completeness === "unavailable") {
    return { state: "unavailable", snapshot: joined.snapshot };
  }
  return { state: "matched", snapshot: joined.snapshot };
}

function sourceStates(collections: FleetCollections): FleetSourceState[] {
  const states: FleetSourceState[] = [];
  for (const source of collections.providers.unavailable) {
    states.push({ source: `provider-${source}`, state: "unavailable", reason: "unreadable" });
  }
  for (const [source, affected] of Object.entries(collections.providers.partial)) {
    states.push({ source: `provider-${source}`, state: "partial", reason: `${affected} affected file(s)` });
  }
  for (const source of collections.providers.unsupported ?? []) {
    states.push({ source: `provider-${source}`, state: "unsupported", reason: null });
  }
  for (const source of collections.orca.sources) {
    states.push({ source: source.command, state: source.state, reason: source.reason });
  }
  if (collections.olla === null) {
    states.push(collections.ollaState);
  } else {
    for (const source of collections.olla.sources) {
      states.push({ source: source.provenance.source, state: source.state, reason: source.reason });
    }
  }
  return states
    .map((state) => ({
      ...state,
      source: privateSafeProviderIdentity(state.source) ?? "unknown",
      reason: privateSafeProviderIdentity(state.reason),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

export function fleetReportJson(
  collections: FleetCollections,
  options: {
    window: string;
    sinceMs: number;
    collectedAt: string;
    promptOriginHost: string | null;
  },
): FleetReportJson {
  const rows = collections.providers.events
    .filter((event) => {
      const timestamp = tsMs(event);
      return timestamp !== null && timestamp >= options.sinceMs;
    })
    .map((event): FleetReportRow => {
      const usage = usageRecord(event, options.collectedAt, options.promptOriginHost);
      const placement = placementFor(usage, collections.orca);
      const route = routeFor(event, usage, collections.olla, options.collectedAt);
      const routeSnapshot = route.snapshot;
      const provenance: FleetReportRow["provenance"] = [
        { ...usage.provenance, scope: "usage" },
      ];
      if (placement.snapshot !== null) {
        provenance.push({ ...placement.snapshot.provenance, scope: "placement" });
      }
      if (routeSnapshot !== null) {
        provenance.push({ ...routeSnapshot.provenance, scope: "aggregate" });
      }
      return {
        event_id: fleetEventId(event),
        timestamp: usage.timestamp,
        prompt_origin_host: usage.prompt_origin_host,
        execution_host: placement.snapshot?.execution_host ?? null,
        router_host: routeSnapshot?.router_host ?? null,
        backend_host: routeSnapshot?.backend_host ?? null,
        backend: routeSnapshot?.backend ?? null,
        harness: usage.harness ?? "unknown",
        provider: usage.provider ?? "unknown",
        model: usage.model,
        billing_route: event.billingRoute,
        request_id: usage.request_id,
        run_id: usage.run_id,
        session_id: usage.session_id,
        status: usage.status as ProviderEvent["status"],
        input_tokens: usage.usage.input_tokens,
        output_tokens: usage.usage.output_tokens,
        cash_charge_usd: usage.usage.cash_charge_usd,
        placement_state: placement.state,
        route_state: route.state,
        ttft: requestMeasurement(event.ttftMs, "ms")
          ?? (routeSnapshot === null ? null : aggregateMeasurement(routeSnapshot, ["avg_ttft_ms", "ttft_ms"], "ms")),
        decode_tps: requestMeasurement(event.decodeTps, "tokens/s")
          ?? (routeSnapshot === null ? null : aggregateMeasurement(routeSnapshot, ["avg_decode_tps", "decode_tps"], "tokens/s")),
        total_latency: requestMeasurement(event.totalLatencyMs, "ms")
          ?? (routeSnapshot === null ? null : aggregateMeasurement(routeSnapshot, ["avg_latency_ms", "latency_ms"], "ms")),
        provenance,
      };
    })
    .sort((a, b) => a.event_id.localeCompare(b.event_id));
  return {
    schema_version: FLEET_SCHEMA_VERSION,
    window: options.window,
    rows,
    sources: sourceStates(collections),
  };
}

function readOllaRoutes(path: string | undefined): OllaRouteObservation[] {
  if (path === undefined) return [];
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new Error("TOKEN_SCOPE_OLLA_ROUTES must contain a JSON array");
  return value as OllaRouteObservation[];
}

export async function collectFleetReport(options: {
  window: string;
  sinceMs: number;
  collectedAt: string;
}): Promise<FleetReportJson> {
  const collectedAt = canonicalTimestamp(options.collectedAt);
  if (collectedAt === null) throw new Error("collectedAt must be a valid timestamp");
  const promptOriginHost = process.env.TOKEN_SCOPE_PROMPT_ORIGIN_HOST || null;
  const providers = collectProviderEvents({ sinceMs: options.sinceMs });
  const orcaPromise = collectOrcaPlacement({ collectedAt });
  const ollaUrl = process.env.TOKEN_SCOPE_OLLA_URL;
  let ollaState: FleetSourceState = {
    source: "olla",
    state: "unavailable",
    reason: "TOKEN_SCOPE_OLLA_URL not configured",
  };
  let olla: OllaTelemetryCollection | null = null;
  if (ollaUrl) {
    try {
      olla = await collectOllaTelemetry({
        baseUrl: ollaUrl,
        collectedAt,
        observedRoutes: readOllaRoutes(process.env.TOKEN_SCOPE_OLLA_ROUTES),
      });
      ollaState = { source: "olla", state: "available", reason: null };
    } catch (error) {
      ollaState = {
        source: "olla",
        state: "unavailable",
        reason: "collection failed",
      };
    }
  }
  const orca = await orcaPromise;
  return fleetReportJson(
    { providers, orca, olla, ollaState },
    { ...options, collectedAt, promptOriginHost },
  );
}

function show(value: string | number | null): string {
  return value === null ? "unknown" : String(value);
}

function measurement(value: FleetMeasurement | null): string {
  if (value === null) return "unknown";
  return `${value.value}${value.unit === "tokens/s" ? " tok/s" : value.unit} ${value.scope}`;
}

export function renderFleetReport(report: FleetReportJson): string {
  const lines = [
    "fleet usage / placement / route",
    `window: ${report.window}`,
  ];
  for (const row of report.rows) {
    lines.push(
      "",
      `event: ${row.event_id}`,
      `  timestamp: ${show(row.timestamp)}`,
      `  prompt origin: ${show(row.prompt_origin_host)}`,
      `  agent execution host: ${show(row.execution_host)}`,
      `  router host: ${show(row.router_host)}`,
      `  backend host: ${show(row.backend_host)}`,
      `  backend: ${show(row.backend)}`,
      `  harness: ${row.harness}`,
      `  provider: ${row.provider}`,
      `  model: ${show(row.model)}`,
      `  request identity: ${show(row.request_id)}`,
      `  run identity: ${show(row.run_id)}`,
      `  session identity: ${show(row.session_id)}`,
      `  status: ${row.status}`,
      `  billing route: ${row.billing_route}`,
      `  cash charge USD: ${show(row.cash_charge_usd)}`,
      `  input tokens: ${show(row.input_tokens)}`,
      `  output tokens: ${show(row.output_tokens)}`,
      `  TTFT: ${measurement(row.ttft)}`,
      `  decode TPS: ${measurement(row.decode_tps)}`,
      `  total latency: ${measurement(row.total_latency)}`,
      `  placement state: ${row.placement_state}`,
      `  route state: ${row.route_state}`,
      `  provenance: ${row.provenance.length === 0 ? "unknown" : row.provenance.map((item) => [
        item.scope,
        item.source,
        `locator=${show(item.locator)}`,
        `collected_at=${item.collected_at}`,
        `completeness=${item.completeness}`,
      ].join(" ")).join("; ")}`,
    );
  }
  if (report.rows.length === 0) lines.push("", "(no timestamped provider events in range)");
  lines.push("", "Olla latency/throughput snapshots are labeled aggregate; text unknown and JSON null mean unavailable, never zero.");
  const nonAvailable = report.sources.filter((source) => source.state !== "available");
  if (nonAvailable.length > 0) {
    lines.push(`source states: ${nonAvailable.map((source) => `${source.source}=${source.state}${source.reason ? ` (${source.reason})` : ""}`).join(", ")}`);
  }
  return lines.join("\n");
}
