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
      eventId: stableId("claude", rec.sessionId ?? provenance, index),
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
      provenance,
    });
  }
  return events;
}

export function claudeEvents(root: string): ProviderEvent[] {
  const projectsDir = join(root, "projects");
  if (!existsSync(projectsDir)) return [];
  const out: ProviderEvent[] = [];
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
        continue; // unreadable file: never fabricate
      }
    }
  }
  return out;
}
