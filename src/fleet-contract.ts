import { PrivacyError, privateOpaqueId, privateSafeLabel } from "@/private-values";

export const FLEET_SCHEMA_VERSION = "1.0" as const;

export type FleetRecordStatus =
  | "ok"
  | "error"
  | "incomplete"
  | "partial"
  | "unavailable"
  | "unknown";

export interface FleetProvenance {
  source: string;
  locator: string | null;
  collected_at: string;
  completeness: "complete" | "partial" | "unavailable";
}

interface FleetRecordFields {
  schema_version: typeof FLEET_SCHEMA_VERSION;
  record_id: string;
  run_id: string | null;
  session_id: string | null;
  request_id: string | null;
  prompt_origin_host: string | null;
  execution_host: string | null;
  router_host: string | null;
  backend_host: string | null;
  harness: string | null;
  provider: string | null;
  backend: string | null;
  model: string | null;
  status: FleetRecordStatus;
  provenance: FleetProvenance;
}

export interface FleetUsageEvent extends FleetRecordFields {
  record_type: "usage_event";
  timestamp: string | null;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    reasoning_tokens: number | null;
    cash_charge_usd: number | null;
  };
}

export interface FleetOperationalSnapshot extends FleetRecordFields {
  record_type: "operational_snapshot";
  timestamp: string;
  window: {
    start: string;
    end: string;
  };
  process_id: string | null;
  stale_after_ms: number | null;
  counters: Record<string, number | null>;
}

export type FleetRecord = FleetUsageEvent | FleetOperationalSnapshot;

const RECORD_STATUSES = new Set<FleetRecordStatus>([
  "ok",
  "error",
  "incomplete",
  "partial",
  "unavailable",
  "unknown",
]);

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

const COMMON_KEYS = [
  "schema_version",
  "record_type",
  "record_id",
  "run_id",
  "session_id",
  "request_id",
  "prompt_origin_host",
  "execution_host",
  "router_host",
  "backend_host",
  "harness",
  "provider",
  "backend",
  "model",
  "timestamp",
  "status",
  "provenance",
] as const;

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unsupported or missing fields`);
  }
}

function assertPrivacyBoundary(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertPrivacyBoundary(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (PRIVATE_KEYS.has(normalized)) {
      throw new Error(`fleet records cannot contain private field ${key}`);
    }
    assertPrivacyBoundary(child);
  }
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return stringValue(value, name);
}

interface SanitizedValue<T> {
  value: T;
  redacted: boolean;
}

function privateSafeNullableString(value: unknown, name: string): SanitizedValue<string | null> {
  const label = nullableString(value, name);
  if (label === null) return { value: null, redacted: false };
  try {
    return { value: privateSafeLabel(label), redacted: false };
  } catch (error) {
    if (error instanceof PrivacyError) return { value: null, redacted: true };
    throw error;
  }
}

function privateSafeRequiredString(value: unknown, name: string): SanitizedValue<string> {
  const label = stringValue(value, name);
  try {
    return { value: privateSafeLabel(label), redacted: false };
  } catch (error) {
    if (error instanceof PrivacyError) return { value: "unknown", redacted: true };
    throw error;
  }
}

function privateSafeRecordId(value: unknown): string {
  const recordId = stringValue(value, "record_id");
  try {
    return privateSafeLabel(recordId);
  } catch (error) {
    if (error instanceof PrivacyError) return privateOpaqueId("record", recordId);
    throw error;
  }
}

function qualifiedId(value: unknown, name: string): SanitizedValue<string | null> {
  const id = nullableString(value, name);
  if (id === null) return { value: null, redacted: false };
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) {
    throw new Error(`${name} must be source-qualified`);
  }
  try {
    return { value: privateSafeLabel(id), redacted: false };
  } catch (error) {
    if (error instanceof PrivacyError) return { value: null, redacted: true };
    throw error;
  }
}

function timestampValue(value: unknown, name: string): string {
  const timestamp = stringValue(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) {
    throw new Error(`${name} must be an RFC 3339 UTC timestamp`);
  }
  const milliseconds = Date.parse(timestamp);
  const canonical = timestamp.includes(".") ? timestamp : timestamp.replace("Z", ".000Z");
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== canonical) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return timestamp;
}

export function canonicalFleetTimestamp(value: unknown, name: string): string {
  return timestampValue(value, name);
}

function nullableMeasurement(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number or null`);
  }
  return value;
}

function nullableTokenCount(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer or null`);
  }
  return value;
}

function provenanceValue(value: unknown): SanitizedValue<FleetProvenance> {
  const provenance = objectValue(value, "provenance");
  assertExactKeys(provenance, ["source", "locator", "collected_at", "completeness"], "provenance");
  const completeness = provenance.completeness;
  if (completeness !== "complete" && completeness !== "partial" && completeness !== "unavailable") {
    throw new Error("provenance.completeness is invalid");
  }
  const source = privateSafeRequiredString(provenance.source, "provenance.source");
  const locator = privateSafeNullableString(provenance.locator, "provenance.locator");
  return { value: {
    source: source.value,
    locator: locator.value,
    collected_at: timestampValue(provenance.collected_at, "provenance.collected_at"),
    completeness,
  }, redacted: source.redacted || locator.redacted };
}

function commonFields(
  record: Record<string, unknown>,
  redactedStatus: "incomplete" | "partial",
): FleetRecordFields {
  if (record.schema_version !== FLEET_SCHEMA_VERSION) {
    throw new Error(`unsupported fleet schema version ${String(record.schema_version)}`);
  }
  if (!RECORD_STATUSES.has(record.status as FleetRecordStatus)) {
    throw new Error("status is invalid");
  }
  const runId = qualifiedId(record.run_id, "run_id");
  const sessionId = qualifiedId(record.session_id, "session_id");
  const requestId = qualifiedId(record.request_id, "request_id");
  const promptOriginHost = privateSafeNullableString(record.prompt_origin_host, "prompt_origin_host");
  const executionHost = privateSafeNullableString(record.execution_host, "execution_host");
  const routerHost = privateSafeNullableString(record.router_host, "router_host");
  const backendHost = privateSafeNullableString(record.backend_host, "backend_host");
  const harness = privateSafeNullableString(record.harness, "harness");
  const provider = privateSafeNullableString(record.provider, "provider");
  const backend = privateSafeNullableString(record.backend, "backend");
  const model = privateSafeNullableString(record.model, "model");
  const provenance = provenanceValue(record.provenance);
  const redacted = [
    runId,
    sessionId,
    requestId,
    promptOriginHost,
    executionHost,
    routerHost,
    backendHost,
    harness,
    provider,
    backend,
    model,
    provenance,
  ].some((field) => field.redacted);
  const status = record.status as FleetRecordStatus;
  return {
    schema_version: FLEET_SCHEMA_VERSION,
    record_id: privateSafeRecordId(record.record_id),
    run_id: runId.value,
    session_id: sessionId.value,
    request_id: requestId.value,
    prompt_origin_host: promptOriginHost.value,
    execution_host: executionHost.value,
    router_host: routerHost.value,
    backend_host: backendHost.value,
    harness: harness.value,
    provider: provider.value,
    backend: backend.value,
    model: model.value,
    status: redacted && status === "ok" ? redactedStatus : status,
    provenance: redacted && provenance.value.completeness === "complete"
      ? { ...provenance.value, completeness: "partial" }
      : provenance.value,
  };
}

export function parseFleetRecord(value: unknown): FleetRecord {
  assertPrivacyBoundary(value);
  const record = objectValue(value, "fleet record");
  if (record.record_type === "usage_event") {
    assertExactKeys(record, [...COMMON_KEYS, "usage"], "usage event");
    const usage = objectValue(record.usage, "usage");
    assertExactKeys(usage, [
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "reasoning_tokens",
      "cash_charge_usd",
    ], "usage");
    return {
      ...commonFields(record, "incomplete"),
      record_type: "usage_event",
      timestamp: record.timestamp === null ? null : timestampValue(record.timestamp, "timestamp"),
      usage: {
        input_tokens: nullableTokenCount(usage.input_tokens, "usage.input_tokens"),
        output_tokens: nullableTokenCount(usage.output_tokens, "usage.output_tokens"),
        cache_read_tokens: nullableTokenCount(usage.cache_read_tokens, "usage.cache_read_tokens"),
        cache_write_tokens: nullableTokenCount(usage.cache_write_tokens, "usage.cache_write_tokens"),
        reasoning_tokens: nullableTokenCount(usage.reasoning_tokens, "usage.reasoning_tokens"),
        cash_charge_usd: nullableMeasurement(usage.cash_charge_usd, "usage.cash_charge_usd"),
      },
    };
  }
  if (record.record_type === "operational_snapshot") {
    assertExactKeys(
      record,
      [...COMMON_KEYS, "window", "process_id", "stale_after_ms", "counters"],
      "operational snapshot",
    );
    const timestamp = timestampValue(record.timestamp, "timestamp");
    const window = objectValue(record.window, "window");
    assertExactKeys(window, ["start", "end"], "window");
    const start = timestampValue(window.start, "window.start");
    const end = timestampValue(window.end, "window.end");
    if (Date.parse(start) >= Date.parse(end) || Date.parse(end) > Date.parse(timestamp)) {
      throw new Error("snapshot window must be non-empty and end no later than timestamp");
    }
    const counters = objectValue(record.counters, "counters");
    const parsedCounters: Record<string, number | null> = {};
    let countersRedacted = false;
    for (const [name, counter] of Object.entries(counters).sort(([a], [b]) => a.localeCompare(b))) {
      if (!name) throw new Error("counter names cannot be empty");
      try {
        parsedCounters[privateSafeLabel(name)] = nullableMeasurement(counter, `counters.${name}`);
      } catch (error) {
        if (!(error instanceof PrivacyError)) throw error;
        countersRedacted = true;
      }
    }
    const processId = qualifiedId(record.process_id, "process_id");
    let common = commonFields(record, "partial");
    if ((processId.redacted || countersRedacted) && common.provenance.completeness === "complete") {
      common = {
        ...common,
        status: common.status === "ok" ? "partial" : common.status,
        provenance: { ...common.provenance, completeness: "partial" },
      };
    }
    const expectedCompleteness =
      common.status === "partial" || common.status === "unavailable"
        ? common.status
        : "complete";
    if (common.provenance.completeness !== expectedCompleteness) {
      throw new Error("snapshot status and provenance completeness must agree");
    }
    return {
      ...common,
      record_type: "operational_snapshot",
      timestamp,
      window: { start, end },
      process_id: processId.value,
      stale_after_ms: nullableMeasurement(record.stale_after_ms, "stale_after_ms"),
      counters: parsedCounters,
    };
  }
  throw new Error(`unsupported fleet record type ${String(record.record_type)}`);
}

const CORRELATION_FIELDS = ["request_id", "run_id", "session_id"] as const;
type CorrelationField = (typeof CORRELATION_FIELDS)[number];

function correlationKey(field: CorrelationField, value: string): string {
  return `${field}=${value}`;
}

export function correlationKeys(record: FleetRecord): string[] {
  const keys: string[] = [];
  for (const field of CORRELATION_FIELDS) {
    const value = record[field];
    if (value !== null) keys.push(correlationKey(field, value));
  }
  return keys;
}

export function usageFallsInSnapshotWindow(
  usage: FleetUsageEvent,
  snapshot: FleetOperationalSnapshot,
): boolean | null {
  if (usage.timestamp === null) return null;
  const timestamp = Date.parse(usage.timestamp);
  return timestamp >= Date.parse(snapshot.window.start) && timestamp < Date.parse(snapshot.window.end);
}

export type FleetJoinResult =
  | { state: "matched"; key: string; snapshot: FleetOperationalSnapshot }
  | { state: "unmatched"; key: null; snapshot: null }
  | { state: "ambiguous"; key: string; snapshot: null };

export function joinUsageToSnapshots(
  usage: FleetUsageEvent,
  snapshots: FleetOperationalSnapshot[],
): FleetJoinResult {
  for (const field of CORRELATION_FIELDS) {
    const value = usage[field];
    if (value === null) continue;
    const matches = snapshots.filter(
      (snapshot) => snapshot[field] === value && usageFallsInSnapshotWindow(usage, snapshot) === true,
    );
    if (matches.length === 1) {
      return { state: "matched", key: correlationKey(field, value), snapshot: matches[0]! };
    }
    if (matches.length > 1) {
      return { state: "ambiguous", key: correlationKey(field, value), snapshot: null };
    }
  }
  return { state: "unmatched", key: null, snapshot: null };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function dedupeFleetRecords(records: FleetRecord[]): {
  records: FleetRecord[];
  conflicts: string[];
} {
  const byId = new Map<string, Map<string, FleetRecord>>();
  for (const record of records) {
    const variants = byId.get(record.record_id) ?? new Map<string, FleetRecord>();
    variants.set(canonicalJson(record), record);
    byId.set(record.record_id, variants);
  }
  const deduped: FleetRecord[] = [];
  const conflicts: string[] = [];
  for (const id of [...byId.keys()].sort()) {
    const variants = byId.get(id)!;
    if (variants.size === 1) deduped.push(variants.values().next().value!);
    else conflicts.push(id);
  }
  return { records: deduped, conflicts };
}

export function classifySnapshotFreshness(
  snapshot: FleetOperationalSnapshot,
  evaluatedAt: string,
): "current" | "stale" | "unknown" {
  if (snapshot.stale_after_ms === null) return "unknown";
  const evaluatedMs = Date.parse(timestampValue(evaluatedAt, "evaluatedAt"));
  const age = evaluatedMs - Date.parse(snapshot.timestamp);
  if (age < 0) return "unknown";
  return age <= snapshot.stale_after_ms ? "current" : "stale";
}

export function snapshotCounterDelta(
  previous: FleetOperationalSnapshot,
  current: FleetOperationalSnapshot,
  counter: string,
): { state: "continuous" | "restart" | "reset" | "unavailable"; value: number | null } {
  const before = previous.counters[counter];
  const after = current.counters[counter];
  if (before === null || before === undefined || after === null || after === undefined) {
    return { state: "unavailable", value: null };
  }
  if (previous.process_id === null || current.process_id === null) {
    return { state: "unavailable", value: null };
  }
  if (previous.process_id !== current.process_id) {
    return { state: "restart", value: null };
  }
  if (after < before) return { state: "reset", value: null };
  return { state: "continuous", value: after - before };
}
