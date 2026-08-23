/**
 * Adapter: Claude Code native transcripts (~/.claude/projects JSONL transcripts).
 *
 * Accounting rules (#37 post-merge audit):
 * - One event per unique billed response. Claude Code writes the same
 *   message.id on multiple transcript lines (streaming updates, sidechain
 *   copies); every copy carries identical usage, so counting lines
 *   overcounts real spend — measured at ~107M double-counted output tokens
 *   on one machine. Dedup by message.id; first occurrence wins so re-scans
 *   stay deterministic.
 * - Model decides the billing route: a non-Anthropic model inside a Claude
 *   transcript (proxy delegation) is NOT Anthropic subscription usage.
 * - Project directories are walked recursively (subagent transcripts live in
 *   subdirectories), and --since prefilters by file mtime instead of parsing
 *   the whole multi-GB store.
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

/** Anthropic models are subscription-routed; anything else is a proxy route
 * this adapter cannot honestly label. */
function isAnthropicModel(model: string | undefined): boolean {
  return !!model && /^claude/i.test(model);
}

export function claudeEventsFromTranscript(
  text: string,
  provenance: string,
): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const seenMessageIds = new Set<string>();
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
    const messageId: string | undefined = msg.id;
    if (messageId) {
      // One billed response, however many transcript lines carry it.
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    const model = msg.model ?? "unknown";
    const subscription = isAnthropicModel(model);
    events.push({
      eventId: stableId("claude", provenance, index),
      harness: "claude",
      billingRoute: subscription ? "subscription" : "unknown",
      modelProvider: subscription ? "anthropic" : "unknown",
      model,
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

/** Recursively collect *.jsonl paths under dir (subagent transcripts nest). */
function walkJsonl(dir: string, out: string[], sinceMs?: number): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subdir: skip it here; the caller counts misses
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out, sinceMs);
    else if (e.name.endsWith(".jsonl")) {
      if (sinceMs !== undefined) {
        // mtime prefilter: a file never touched inside the window cannot hold
        // in-window records, and stat is orders cheaper than parse (#37 P2).
        try {
          if (statSync(p).mtimeMs < sinceMs) continue;
        } catch {
          continue; // vanished mid-scan
        }
      }
      out.push(p);
    }
  }
}

export function claudeEvents(
  root: string,
  sinceMs?: number,
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
    const files: string[] = [];
    walkJsonl(dir, files, sinceMs);
    for (const p of files) {
      try {
        out.push(...claudeEventsFromTranscript(readFileSync(p, "utf8"), p));
      } catch {
        skipped += 1; // unreadable file: volume unknown, surfaced not swallowed
      }
    }
  }
  return { events: out, skipped };
}
