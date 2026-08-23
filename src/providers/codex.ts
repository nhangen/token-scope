/**
 * Adapter: Codex CLI/Desktop session rollouts (~/.codex/sessions JSONL rollouts).
 * token_count events carry cumulative totals; we emit one aggregate event per
 * session (final totals), so per-turn deltas are never double-counted.
 */
import { readFileSync, existsSync } from "fs";
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
    const info = p?.info?.total_token_usage ?? p?.total_token_usage ?? null;
    if (info) last = info as CodexTotals;
    if ((p?.type ?? "") === "turn_aborted") sawTurnCap = true;
  }
  if (!last && !meta) return [];
  const provider = meta?.model_provider ?? "openai";
  return [
    {
      eventId: stableId("codex", meta?.id ?? provenance),
      harness: "codex",
      billingRoute: "unknown",
      modelProvider: provider,
      model: meta?.model_provider ? (meta.cli_version ? `${provider}` : provider) : "unknown",
      ts: meta?.timestamp ?? null,
      status: sawTurnCap ? "incomplete" : "ok",
      retryOf: null,
      inputTokens: last?.input_tokens ?? null,
      outputTokens: last?.output_tokens ?? null,
      cacheReadTokens: last?.cached_input_tokens ?? null,
      cacheWriteTokens: null,
      reasoningTokens: last?.reasoning_output_tokens ?? null,
      provenance,
    },
  ];
}

export function codexEvents(root: string): ProviderEvent[] {
  const sessionsDir = join(root, ".codex", "sessions");
  if (!existsSync(sessionsDir)) return [];
  const out: ProviderEvent[] = [];
  const walk = (dir: string) => {
    for (const e of require("fs").readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        try {
          out.push(...codexEventsFromRollout(readFileSync(p, "utf8"), p));
        } catch {
          continue;
        }
      }
    }
  };
  walk(sessionsDir);
  return out;
}
