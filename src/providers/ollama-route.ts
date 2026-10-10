/**
 * Adapter for the low-risk Olla route telemetry JSONL written by llm-tools.
 * It contains measured request usage and sanitized route metadata, never the
 * task payload. Refusals are routing observations, not usage events.
 */
import { existsSync, readFileSync } from "fs";
import {
  privateSafeEventId,
  privateSafeProviderIdentity,
  qualifiedProviderId,
  type ProviderEvent,
} from "./types";

interface RouteRead {
  events: ProviderEvent[];
  path: string;
  exists: boolean;
  readError: string | null;
  skippedLines: number;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function readRecord(value: unknown, provenance: string, line: number): ProviderEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.event !== "result") return null;
  const rawRequestId = typeof record.olla_request_id === "string"
    ? record.olla_request_id
    : typeof record.request_id === "string" ? record.request_id : null;
  const wrapperRequestId = typeof record.request_id === "string" ? record.request_id : null;
  const rawTimestamp = typeof record.timestamp === "string" ? record.timestamp : null;
  const requestId = qualifiedProviderId("olla", rawRequestId);
  const model = privateSafeProviderIdentity(
    typeof record.model_served === "string" ? record.model_served : record.model,
  );
  const safeProvider = privateSafeProviderIdentity(record.provider);
  const providerRejected = record.provider !== undefined && record.provider !== null && safeProvider === null;
  const provider = safeProvider ?? (providerRejected ? "unknown" : "olla");
  const endpointName = privateSafeProviderIdentity(record.endpoint_served);
  const inputTokens = nonNegativeInteger(record.prompt_tokens);
  const outputTokens = nonNegativeInteger(record.output_tokens);
  const promptDurationNs = nonNegativeInteger(record.prompt_duration_ns);
  const decodeDurationNs = nonNegativeInteger(record.output_duration_ns);
  const totalDurationNs = nonNegativeInteger(record.total_duration_ns);
  const totalLatencyMs = nonNegativeNumber(record.response_time_ms)
    ?? (totalDurationNs === null ? null : totalDurationNs / 1_000_000);
  const decodeTps = outputTokens !== null && decodeDurationNs !== null && decodeDurationNs > 0
    ? outputTokens / (decodeDurationNs / 1_000_000_000)
    : null;
  const exitCode = nonNegativeInteger(record.exit_code);
  const decision = record.decision;
  const status: ProviderEvent["status"] =
    decision === "failed" || (exitCode !== null && exitCode !== 0) ? "error" : "ok";
  const partial = requestId === null || model === null || endpointName === null
    || inputTokens === null || outputTokens === null || providerRejected;
  return {
    eventId: privateSafeEventId("ollama-route", wrapperRequestId, rawTimestamp, line),
    harness: "ollama-route",
    billingRoute: "local",
    modelProvider: provider,
    model,
    ts: timestamp(rawTimestamp),
    status: partial && status === "ok" ? "incomplete" : status,
    partial: partial ? ["incomplete_route_record"] : undefined,
    retryOf: null,
    inputTokens,
    outputTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    cashChargeUsd: null,
    provenance,
    requestId,
    runId: null,
    sessionId: null,
    endpointName,
    ttftMs: promptDurationNs === null ? null : promptDurationNs / 1_000_000,
    totalLatencyMs,
    decodeTps,
  };
}

export function readOllaRouteTelemetry(path: string): RouteRead {
  if (!existsSync(path)) return { events: [], path, exists: false, readError: null, skippedLines: 0 };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      events: [], path, exists: true,
      readError: error instanceof Error ? error.message : String(error),
      skippedLines: 0,
    };
  }
  const events: ProviderEvent[] = [];
  let skippedLines = 0;
  raw.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const event = readRecord(JSON.parse(line), path, index + 1);
      if (event !== null) events.push(event);
    } catch {
      skippedLines += 1;
    }
  });
  return { events, path, exists: true, readError: null, skippedLines };
}

export function ollamaRouteEvents(path: string, sinceMs?: number): RouteRead {
  const result = readOllaRouteTelemetry(path);
  if (sinceMs === undefined) return result;
  return {
    ...result,
    events: result.events.filter((event) => event.ts !== null && Date.parse(event.ts) >= sinceMs),
  };
}
