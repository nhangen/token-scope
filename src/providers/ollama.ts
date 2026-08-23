/**
 * Adapter: Claude-over-Ollama delegations (ledger runs.jsonl, ground-truth
 * counts from ollama's eval_count/prompt_eval_count). No cache/reasoning
 * classes exist in this source — they stay null (#37).
 *
 * Event ids are content-composite: ledger run_ids like "author:234" or
 * "review:446:p1of3" identify a TASK, not a run — the live ledger holds
 * multiple legitimate rows per run_id with different token totals and
 * timestamps. Keying on run_id alone made dedup silently delete real runs
 * (#37 post-merge audit); keying on positional index broke dedup whenever
 * rows rotated. The composite collapses true re-scan duplicates (identical
 * row content) while keeping every distinct observation.
 */
import { stableId, type ProviderEvent } from "./types";
import { readLedger, type LedgerRun } from "@/ledger";

export function ollamaEventsFromRuns(runs: LedgerRun[], provenance: string): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (const run of runs) {
    const id = [
      run.runId ?? "",
      run.ts ?? "",
      run.model ?? "",
      run.taskName ?? "",
      run.sessionId ?? "",
      String(run.ollamaInputTokens),
      String(run.ollamaOutputTokens),
    ].join("|");
    events.push({
      eventId: stableId("ollama-claude", id),
      harness: "ollama-claude",
      billingRoute: "local",
      modelProvider: "ollama",
      model: run.model ?? "unknown",
      ts: run.ts ?? null,
      status: run.completed ? "ok" : run.verified === false ? "error" : "incomplete",
      retryOf: null,
      inputTokens: run.ollamaInputTokens ?? null,
      outputTokens: run.ollamaOutputTokens ?? null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      cashChargeUsd: null,
      provenance,
    });
  }
  return events;
}

export function ollamaEvents(override?: string): ProviderEvent[] {
  // The house reader maps the ledger's snake_case fields to LedgerRun.
  return ollamaEventsFromRuns(readLedger(override), override ?? "ledger");
}
