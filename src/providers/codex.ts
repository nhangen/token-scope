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

function unknownThread(threadId: string): CodexThread {
  return {
    threadId,
    role: "unknown",
    parentThreadId: "unknown",
    depth: "unknown",
    agentPath: "unknown",
  };
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
      ? spawn.parent_thread_id : "unknown";
    const depth = Number.isInteger(spawn.depth) && spawn.depth >= 1
      ? spawn.depth : "unknown";
    const path = Array.isArray(spawn.agent_path)
      && spawn.agent_path.every((part: unknown) => typeof part === "string" && part.length > 0)
      ? spawn.agent_path : "unknown";
    if (parent === "unknown" || depth === "unknown" || path === "unknown" || path.length !== depth) {
      return unknownThread(threadId);
    }
    return { threadId, role: "subagent", parentThreadId: parent, depth, agentPath: path };
  }
  return unknownThread(threadId);
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

export function codexEventsFromRollout(
  text: string,
  provenance: string,
): ProviderEvent[] {
  let meta: any = null;
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
    if (rec.type === "session_meta") meta = rec.payload ?? null;
    const p = rec.payload ?? rec;
    if (rec.type === "turn_context" || p?.type === "turn_context") {
      model = typeof p?.model === "string" && p.model ? p.model : null;
      effort = typeof p?.effort === "string" && p.effort ? p.effort : null;
    }
    if (p?.type === "turn_aborted") {
      const last = events[events.length - 1] ?? legacyCandidate;
      if (last) last.status = "incomplete";
      continue;
    }
    const info = p?.info;
    if (p?.type !== "token_count" || !info || typeof info !== "object") continue;

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
      modelProvider: meta?.model_provider ?? "unknown",
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
      partial: hasLastUsage
        ? [...new Set([...usage.partial, ...(cumulativeKey === null ? ["cumulative_token_usage"] : [])])].sort()
        : [...new Set([...usage.partial, "response_attribution"])].sort(),
      usageSource: hasLastUsage ? "response" : "legacy-cumulative",
    };
    if (hasLastUsage) events.push(event);
    else if (!sawLastUsage) {
      event.model = "unknown";
      event.reasoningEffort = "unknown";
      legacyCandidate = event;
    }
  }
  if (!sawLastUsage && legacyCandidate) events.push(legacyCandidate);
  return events;
}

export function codexEvents(
  root: string,
  sinceMs?: number,
): { events: ProviderEvent[]; skipped: number } {
  const sessionsDir = join(root, ".codex", "sessions");
  if (!existsSync(sessionsDir)) return { events: [], skipped: 0 };
  const out: ProviderEvent[] = [];
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
          out.push(...codexEventsFromRollout(readFileSync(p, "utf8"), p));
        } catch {
          skipped += 1;
        }
      }
    }
  };
  walk(sessionsDir);
  return { events: out, skipped };
}
