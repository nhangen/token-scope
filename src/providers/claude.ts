/**
 * Adapter: Claude Code native transcripts (~/.claude/projects JSONL transcripts).
 * Assistant messages carry per-message usage with cache read/write classes.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { stableId, type ProviderEvent } from "./types";

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function claudeEventsFromTranscript(
  text: string,
  provenance: string,
): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  let index = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn tail line: skip, never fabricate
    }
    index += 1;
    if (rec.type !== "assistant") continue;
    const msg = rec.message ?? {};
    const usage: ClaudeUsage | undefined = msg.usage;
    if (!usage) continue;
    events.push({
      // File-anchored, not sessionId-anchored: resumed/forked sessions write
      // fresh transcripts sharing one sessionId, so sessionId keys collide and
      // dedup silently drops real usage. Re-scans of the same file are stable.
      eventId: stableId("claude", provenance, index),
      harness: "claude",
      billingRoute: "subscription",
      modelProvider: "anthropic",
      model: msg.model ?? "unknown",
      ts: rec.timestamp ?? null,
      status: "ok",
      retryOf: null,
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      cacheReadTokens: usage.cache_read_input_tokens ?? null,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
      reasoningTokens: null,
      cashChargeUsd: null,
      provenance,
    });
  }
  return events;
}

export function claudeEvents(
  root: string,
): { events: ProviderEvent[]; skipped: number } {
  const projectsDir = join(root, "projects");
  if (!existsSync(projectsDir)) return { events: [], skipped: 0 };
  const out: ProviderEvent[] = [];
  let skipped = 0;
  for (const proj of readdirSync(projectsDir)) {
    const dir = join(projectsDir, proj);
    // Stray files (.DS_Store) live alongside project dirs; stat, don't assume.
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue; // vanished mid-scan: skip, never fabricate
    }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      try {
        out.push(...claudeEventsFromTranscript(readFileSync(p, "utf8"), p));
      } catch {
        skipped += 1; // unreadable file: volume unknown, surfaced not swallowed
      }
    }
  }
  return { events: out, skipped };
}
