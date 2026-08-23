/**
 * Adapter: Codex CLI/Desktop session rollouts (~/.codex/sessions JSONL rollouts).
 * token_count events carry cumulative totals; we emit one aggregate event per
 * session (final totals), so per-turn deltas are never double-counted.
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { stableId, type ProviderEvent } from "./types";

interface CodexTotals {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export function codexEventsFromRollout(
  text: string,
  provenance: string,
): ProviderEvent[] {
  let meta: any = null;
  let last: CodexTotals | null = null;
  let lastTs: string | null = null;
  let model: string | null = null;
  let sawTurnCap = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "session_meta") meta = rec.payload ?? null;
    const p = rec.payload ?? rec;
    if (typeof p?.model === "string" && p.model) model = p.model;
    const info = p?.info?.total_token_usage ?? p?.total_token_usage ?? null;
    if (info) {
      last = info as CodexTotals;
      lastTs = typeof rec.timestamp === "string" ? rec.timestamp : lastTs;
    }
    if ((p?.type ?? "") === "turn_aborted") sawTurnCap = true;
  }
  if (!last && !meta) return [];
  const provider = meta?.model_provider ?? "unknown";
  // OpenAI-style input_tokens INCLUDES cached_input_tokens; Anthropic classes
  // are disjoint. Emit uncached input so every source sums the same way.
  const rawInput = last?.input_tokens ?? null;
  const cached = last?.cached_input_tokens ?? null;
  const inputDisjoint =
    rawInput !== null && cached !== null ? Math.max(0, rawInput - cached) : rawInput;
  return [
    {
      eventId: stableId("codex", meta?.id ?? provenance),
      harness: "codex",
      billingRoute: "unknown",
      modelProvider: provider === "unknown" ? "unknown" : provider,
      model: model ?? "unknown", // session_meta carries the provider, not the model
      ts: lastTs ?? meta?.timestamp ?? null,
      status: sawTurnCap ? "incomplete" : "ok",
      retryOf: null,
      inputTokens: inputDisjoint,
      outputTokens: last?.output_tokens ?? null,
      cacheReadTokens: last?.cached_input_tokens ?? null,
      cacheWriteTokens: null,
      reasoningTokens: last?.reasoning_output_tokens ?? null,
      cashChargeUsd: null,
      provenance,
    },
  ];
}

export function codexEvents(
  root: string,
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
