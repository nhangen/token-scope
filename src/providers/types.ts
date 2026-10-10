import { createHash } from "crypto";
import { assertSafeLabelValue, PrivacyError } from "@/fleet-contract";

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
  harness: "claude" | "ollama-claude" | "ollama-route" | "codex" | "opencode" | "gemini-cli";
  /** How the request was paid for: subscription | metered | local | unknown. */
  billingRoute: "subscription" | "metered" | "local" | "unknown";
  modelProvider: string;
  model: string | null;
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
  /** Codex turn metadata, when the source records it. */
  reasoningEffort?: string;
  /** Codex thread metadata. Older rollouts keep every ancestry field unknown. */
  codexThread?: {
    threadId: string;
    role: "root" | "subagent" | "unknown";
    parentThreadId: string | null | "unknown";
    depth: number | "unknown";
    agentPath: string[] | "unknown";
    /** Parent named by a spawn record whose ancestry failed validation. */
    claimedParentThreadId?: string;
  };
  /** Source contradictions that prevent a disjoint token value. */
  malformed?: string[];
  /** Source omissions that prevent complete attribution or token classes. */
  partial?: string[];
  /** Codex usage schema used for this event. */
  usageSource?: "response" | "legacy-cumulative";
  /** Source-owned correlation identities for the fleet report. */
  requestId?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  endpointName?: string | null;
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
    assertSafeLabelValue(value);
    return value;
  } catch (error) {
    if (error instanceof PrivacyError) return null;
    throw error;
  }
}

export function qualifiedProviderId(namespace: string, value: unknown): string | null {
  const identity = privateSafeProviderIdentity(value);
  if (identity === null) return null;
  try {
    assertSafeLabelValue(namespace);
    const qualified = `${namespace}:${encodeURIComponent(identity)}`;
    assertSafeLabelValue(qualified);
    return qualified;
  } catch (error) {
    if (error instanceof PrivacyError) return null;
    throw error;
  }
}

export function providerIdRejected(raw: unknown, qualified: string | null): boolean {
  return typeof raw === "string" && raw.length > 0 && qualified === null;
}

export function privateSafeEventId(
  namespace: string,
  ...parts: Array<string | number | null | undefined>
): string {
  assertSafeLabelValue(namespace);
  const completeParts = parts.map((part) => {
    if (part === null) return ["null"];
    if (part === undefined) return ["undefined"];
    if (typeof part === "string") return ["string", part];
    if (Number.isNaN(part)) return ["number", "NaN"];
    if (Object.is(part, -0)) return ["number", "-0"];
    return ["number", String(part)];
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(completeParts))
    .digest("hex");
  return `${namespace}:opaque:${digest}`;
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
