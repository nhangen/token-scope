import { PrivacyError, privateOpaqueId, privateSafeLabel } from "@/private-values";

/**
 * Provider-neutral usage event (#37).
 *
 * One normalized record per source observation. Token classes a source does
 * not expose stay null — never coerced to zero (#37 acceptance criteria).
 * Cash charge, metered value, counterfactual value, and subscription
 * utilization are deliberately separate concerns; this schema carries only
 * what each source actually measures plus the routing label needed to
 * interpret it downstream.
 */
export interface ProviderEvent {
  /** Source-qualified and deterministic: "<harness>:<stable local id>". */
  eventId: string;
  harness: "claude" | "ollama-claude" | "codex" | "opencode" | "gemini-cli";
  /** How the request was paid for: subscription | metered | local | unknown. */
  billingRoute: "subscription" | "metered" | "local" | "unknown";
  modelProvider: string;
  model: string | null;
  ts: string | null;
  status: "ok" | "error" | "incomplete";
  /** True when source telemetry was retained after privacy-safe redaction. */
  partial?: boolean;
  /** Set when this event is a retry of an earlier attempt. */
  retryOf: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** Cash actually charged for this request. Null unless the source meters
   * per request — never manufactured from subscription utilization (#37). */
  cashChargeUsd: number | null;
  /** Source file (or db) the record came from. */
  provenance: string;
  /** Source-owned correlation identities for the fleet report. */
  requestId?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  /** Request-level measurements only. Aggregate telemetry stays on snapshots. */
  ttftMs?: number | null;
  decodeTps?: number | null;
  totalLatencyMs?: number | null;
}

export function stableId(...parts: Array<string | number>): string {
  return parts.join(":");
}

export function privateSafeProviderIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return privateSafeLabel(value);
  } catch (error) {
    if (error instanceof PrivacyError) return null;
    throw error;
  }
}

export function qualifiedProviderId(namespace: string, value: unknown): string | null {
  const identity = privateSafeProviderIdentity(value);
  if (identity === null) return null;
  try {
    return privateSafeLabel(`${privateSafeLabel(namespace)}:${encodeURIComponent(identity)}`);
  } catch (error) {
    if (error instanceof PrivacyError) return null;
    throw error;
  }
}

export function privateSafeEventId(
  namespace: string,
  ...parts: Array<string | number | null | undefined>
): string {
  return privateOpaqueId(namespace, ...parts);
}

/** Milliseconds for a record's timestamp, or null when it cannot be dated
 * (absent or unparseable). Single source of truth for "cannot be placed in
 * the window" — the --since filter and any excluded-run counter must call
 * this, not re-derive the check (#42, #50). */
export function tsMs(e: { ts?: string | null }): number | null {
  if (!e.ts) return null;
  const ms = Date.parse(e.ts);
  return Number.isNaN(ms) ? null : ms;
}
