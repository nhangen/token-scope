/**
 * Adapter: Codex CLI/Desktop session rollouts (~/.codex/sessions JSONL rollouts).
 *
 * token_count events carry both per-response and cumulative totals. Each
 * nonzero per-response usage object becomes one event; cumulative totals are
 * used only to discard unchanged repeated snapshots.
 *
 * Event ids are file-anchored: resumed/forked rollouts can inherit a prior
 * session_meta id, and an id-only key would make dedup silently drop one of
 * two distinct files (#37 post-merge audit). The file path keeps re-scans
 * deterministic while guaranteeing distinct rollouts stay distinct.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { stableId, type ProviderEvent } from "./types";

interface CodexTotals {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
}

type CodexThread = NonNullable<ProviderEvent["codexThread"]>;

const TOKEN_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;

function unknownThread(threadId: string, claimedParent?: string): CodexThread {
  return {
    threadId,
    role: "unknown",
    parentThreadId: "unknown",
    depth: "unknown",
    agentPath: "unknown",
    ...(claimedParent ? { claimedParentThreadId: claimedParent } : {}),
  };
}

/** Codex writes agent_path as null, absent, or "/root/<name>/..."; arrays are
 * accepted for older fixtures. Returns null when the value contradicts depth. */
function spawnAgentPath(value: unknown, depth: number): string[] | "unknown" | null {
  if (value === null || value === undefined) return "unknown";
  let parts: unknown[];
  if (typeof value === "string") {
    const segments = value.split("/").filter((part) => part.length > 0);
    if (segments[0] !== "root") return null;
    parts = segments.slice(1);
  } else if (Array.isArray(value)) {
    parts = value;
  } else {
    return null;
  }
  if (!parts.every((part) => typeof part === "string" && part.length > 0)) return null;
  return parts.length === depth ? parts as string[] : null;
}

function codexThread(meta: any): CodexThread {
  const threadId = typeof meta?.id === "string" && meta.id ? meta.id : "unknown";
  const source = meta?.source;
  if (typeof source === "string" && source.trim()) {
    return { threadId, role: "root", parentThreadId: null, depth: 0, agentPath: [] };
  }
  const spawn = source?.subagent?.thread_spawn;
  if (spawn && typeof spawn === "object") {
    const parent = typeof spawn.parent_thread_id === "string" && spawn.parent_thread_id
      ? spawn.parent_thread_id : null;
    const depth = Number.isInteger(spawn.depth) && spawn.depth >= 1 ? spawn.depth as number : null;
    if (parent === null) return unknownThread(threadId);
    if (depth === null) return unknownThread(threadId, parent);
    const path = spawnAgentPath(spawn.agent_path, depth);
    if (path === null) return unknownThread(threadId, parent);
    return { threadId, role: "subagent", parentThreadId: parent, depth, agentPath: path };
  }
  const claimed = typeof meta?.parent_thread_id === "string" && meta.parent_thread_id
    ? meta.parent_thread_id : undefined;
  return unknownThread(threadId, claimed);
}

function finiteToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value : null;
}

function disjointUsage(value: unknown): {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  malformed: string[];
  partial: string[];
} {
  const malformed: string[] = [];
  const partial: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
      malformed: ["token_usage"],
      partial,
    };
  }
  const raw = value as CodexTotals;
  const present = (key: typeof TOKEN_KEYS[number]) => Object.hasOwn(raw, key);
  const input = finiteToken(raw.input_tokens);
  const cacheRead = finiteToken(raw.cached_input_tokens);
  const cacheWrite = finiteToken(raw.cache_write_input_tokens);
  const output = finiteToken(raw.output_tokens);
  const reasoning = finiteToken(raw.reasoning_output_tokens);

  for (const key of TOKEN_KEYS) {
    if (present(key) && finiteToken(raw[key]) === null) malformed.push(key);
  }
  if (!TOKEN_KEYS.some(present)) malformed.push("token_usage");

  const hasAnyKnownToken = TOKEN_KEYS.some(present);
  let uncachedInput: number | null = null;
  if (input !== null && cacheRead !== null && cacheWrite !== null) {
    if (cacheRead + cacheWrite > input) {
      malformed.push("input_token_classes");
    } else {
      uncachedInput = input - cacheRead - cacheWrite;
    }
  } else if (hasAnyKnownToken) {
    partial.push("input_token_classes");
  }

  let visibleOutput: number | null = null;
  if (output !== null && reasoning !== null) {
    if (reasoning > output) {
      malformed.push("output_token_classes");
      visibleOutput = null;
    } else {
      visibleOutput = output - reasoning;
    }
  } else if (hasAnyKnownToken) {
    partial.push("output_token_classes");
  }

  return {
    input: uncachedInput,
    output: visibleOutput,
    cacheRead,
    cacheWrite,
    reasoning,
    malformed: [...new Set(malformed)].sort(),
    partial: [...new Set(partial)].sort(),
  };
}

function hasUsage(value: unknown, usage: ReturnType<typeof disjointUsage>): boolean {
  if (usage.malformed.length > 0) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as CodexTotals;
  return TOKEN_KEYS.some((key) => finiteToken(raw[key]) !== null && finiteToken(raw[key]) !== 0);
}

function canonicalCompleteTokenTuple(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as CodexTotals;
  const tuple = TOKEN_KEYS.map((key) => finiteToken(raw[key]));
  if (tuple.some((token) => token === null)) return null;
  const usage = disjointUsage(value);
  return usage.malformed.length === 0 && usage.partial.length === 0
    ? JSON.stringify(tuple)
    : null;
}

function validOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

interface ParsedRollout {
  events: ProviderEvent[];
  threadId: string | null;
  forkedFrom: string | null;
  /** Raw (last, total) usage pair of every token_count record in the file. */
  usageKeys: Set<string>;
  eventUsageKeys: Map<ProviderEvent, string>;
}

function usageRecordKey(info: any): string {
  const tuple = (value: any) => TOKEN_KEYS.map((key) => value?.[key] ?? null);
  return JSON.stringify([tuple(info?.last_token_usage), tuple(info?.total_token_usage)]);
}

/** Single-rollout parse. A forked child's replayed parent history is only
 * removed by codexEvents, which can see the parent's rollout. */
export function codexEventsFromRollout(
  text: string,
  provenance: string,
): ProviderEvent[] {
  return parseRollout(text, provenance).events;
}

function parseRollout(text: string, provenance: string): ParsedRollout {
  let meta: any = null;
  const usageKeys = new Set<string>();
  const eventUsageKeys = new Map<ProviderEvent, string>();
  let model: string | null = null;
  let effort: string | null = null;
  let previousCumulative: string | null = null;
  let sawLastUsage = false;
  let legacyCandidate: ProviderEvent | null = null;
  const seenOrdinals = new Set<number>();
  const events: ProviderEvent[] = [];
  const lines = text.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const useOrdinal = validOrdinal(rec.ordinal) && !seenOrdinals.has(rec.ordinal);
    if (validOrdinal(rec.ordinal)) seenOrdinals.add(rec.ordinal);
    const recordKey = useOrdinal ? `ordinal-${rec.ordinal}` : `line-${lineIndex}`;
    // Forked children also carry the parent's session_meta after their own;
    // the first one identifies this rollout.
    if (rec.type === "session_meta" && meta === null) meta = rec.payload ?? null;
    const p = rec.payload ?? rec;
    if (rec.type === "turn_context" || p?.type === "turn_context") {
      model = typeof p?.model === "string" && p.model ? p.model : null;
      effort = typeof p?.effort === "string" && p.effort ? p.effort : null;
    }
    if (p?.type === "turn_aborted") {
      const last = events[events.length - 1] ?? legacyCandidate;
      if (last) {
        last.status = "incomplete";
        last.partial = [...new Set([...(last.partial ?? []), "turn_aborted"])].sort();
      }
      continue;
    }
    const info = p?.info;
    if (p?.type !== "token_count" || !info || typeof info !== "object") continue;

    const usageKey = usageRecordKey(info);
    usageKeys.add(usageKey);
    const cumulative = info?.total_token_usage;
    const cumulativeKey = canonicalCompleteTokenTuple(cumulative);
    const repeatedSnapshot = cumulativeKey !== null && cumulativeKey === previousCumulative;
    previousCumulative = cumulativeKey;
    const hasLastUsage = Object.hasOwn(info, "last_token_usage");
    if (hasLastUsage && !sawLastUsage) {
      sawLastUsage = true;
      if (legacyCandidate) {
        events.push(legacyCandidate);
        legacyCandidate = null;
      }
    }
    const raw = hasLastUsage ? info.last_token_usage : cumulative;
    if (raw === undefined) continue;
    const usage = disjointUsage(raw);
    if (repeatedSnapshot && usage.malformed.length === 0) continue;
    if (!hasUsage(raw, usage)) continue;

    const event: ProviderEvent = {
      eventId: stableId("codex", provenance, recordKey),
      harness: "codex",
      billingRoute: "unknown",
      modelProvider: typeof meta?.model_provider === "string" && meta.model_provider ? meta.model_provider : "unknown",
      model: model ?? "unknown",
      reasoningEffort: effort ?? "unknown",
      ts: typeof rec.timestamp === "string" ? rec.timestamp : meta?.timestamp ?? null,
      status: "ok",
      retryOf: null,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      reasoningTokens: usage.reasoning,
      cashChargeUsd: null,
      provenance,
      codexThread: codexThread(meta),
      malformed: usage.malformed,
      partial: [...new Set([
        ...usage.partial,
        ...(hasLastUsage && cumulativeKey === null ? ["cumulative_token_usage"] : []),
        ...(!hasLastUsage || model === null || effort === null ? ["response_attribution"] : []),
      ])].sort(),
      usageSource: hasLastUsage ? "response" : "legacy-cumulative",
    };
    eventUsageKeys.set(event, usageKey);
    if (hasLastUsage) events.push(event);
    else if (sawLastUsage) {
      // A cumulative total after per-response records overlaps usage already
      // counted, so none of its classes can be attributed to this response.
      event.inputTokens = null;
      event.outputTokens = null;
      event.cacheReadTokens = null;
      event.cacheWriteTokens = null;
      event.reasoningTokens = null;
      event.partial = [...new Set([...(event.partial ?? []), "mixed_schema"])].sort();
      events.push(event);
    } else {
      event.model = "unknown";
      event.reasoningEffort = "unknown";
      legacyCandidate = event;
    }
  }
  if (!sawLastUsage && legacyCandidate) events.push(legacyCandidate);
  const threadId = typeof meta?.id === "string" && meta.id ? meta.id : null;
  const forkedFrom = typeof meta?.forked_from_id === "string" && meta.forked_from_id
    ? meta.forked_from_id : null;
  return { events, threadId, forkedFrom, usageKeys, eventUsageKeys };
}

/** A forked child copies its parent's records, with new timestamps, before
 * its own work. A copied record carries the parent's exact (last, total)
 * usage pair; that usage is counted in the parent's rollout, not here. When
 * the parent rollout is absent the copy cannot be told apart, so the child's
 * events are marked partial. */
function removeForkReplays(rollouts: ParsedRollout[]): ProviderEvent[] {
  const keysByThread = new Map<string, Set<string>>();
  for (const rollout of rollouts) {
    if (rollout.threadId === null) continue;
    const keys = keysByThread.get(rollout.threadId) ?? new Set<string>();
    for (const key of rollout.usageKeys) keys.add(key);
    keysByThread.set(rollout.threadId, keys);
  }
  const out: ProviderEvent[] = [];
  for (const rollout of rollouts) {
    if (rollout.forkedFrom === null) {
      out.push(...rollout.events);
      continue;
    }
    const parentKeys = keysByThread.get(rollout.forkedFrom);
    for (const event of rollout.events) {
      if (parentKeys === undefined) {
        event.partial = [...new Set([...(event.partial ?? []), "fork_history_unverified"])].sort();
        out.push(event);
      } else if (!parentKeys.has(rollout.eventUsageKeys.get(event)!)) {
        out.push(event);
      }
    }
  }
  return out;
}

export function codexEvents(
  root: string,
  sinceMs?: number,
): { events: ProviderEvent[]; skipped: number } {
  const sessionsDir = join(root, ".codex", "sessions");
  if (!existsSync(sessionsDir)) return { events: [], skipped: 0 };
  const rollouts: ParsedRollout[] = [];
  let skipped = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped += 1; // unreadable subdir: skip it, don't lose the whole source
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        if (sinceMs !== undefined) {
          try {
            if (statSync(p).mtimeMs < sinceMs) continue;
          } catch {
            continue;
          }
        }
        try {
          rollouts.push(parseRollout(readFileSync(p, "utf8"), p));
        } catch {
          skipped += 1;
        }
      }
    }
  };
  walk(sessionsDir);
  return { events: removeForkReplays(rollouts), skipped };
}
