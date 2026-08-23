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
  harness: "claude" | "ollama-claude" | "codex" | "opencode";
  /** How the request was paid for: subscription | metered | local | unknown. */
  billingRoute: "subscription" | "metered" | "local" | "unknown";
  modelProvider: string;
  model: string;
  ts: string | null;
  status: "ok" | "error" | "incomplete";
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
}

export function stableId(...parts: Array<string | number>): string {
  return parts.join(":");
}
