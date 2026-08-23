/**
 * Adapter: Claude-over-Ollama delegations (ledger runs.jsonl, ground-truth
 * counts from ollama's eval_count/prompt_eval_count). No cache/reasoning
 * classes exist in this source — they stay null (#37).
 */
import { stableId, type ProviderEvent } from "./types";
import { readLedger, type LedgerRun } from "@/ledger";

export function ollamaEventsFromRuns(runs: LedgerRun[], provenance: string): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (const run of runs) {
    // Legacy rows (pre-reason logging, nhangen/claude-ceo#327) carry no run_id.
    // Fall back to run content, not a positional index: indices shift when rows
    // rotate or any earlier line goes unparseable, and a shifting id defeats
    // dedup — the same physical run would double-count on the next scan.
    const id = run.runId ??
      `${run.sessionId ?? ""}:${run.model ?? ""}:${run.ts ?? ""}:${run.taskName ?? ""}:${run.ollamaInputTokens}:${run.ollamaOutputTokens}`;
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
