/**
 * Aggregation + deterministic dedup (#37).
 *
 * Dedup key is the source-qualified eventId. Re-reading a source yields the
 * same ids, so re-scans collapse; genuine retries keep their own rows (the
 * source emits distinct observations for them) and stay visible via status.
 */
import { homedir } from "os";
import { join } from "path";
import { claudeEvents } from "./claude";
import { ollamaEvents } from "./ollama";
import { codexEvents } from "./codex";
import { opencodeEvents } from "./opencode";
import type { ProviderEvent } from "./types";

export type { ProviderEvent } from "./types";

/** Deterministic: stable sort by source-qualified id, first occurrence wins.
 *  Re-scans collapse; genuine retries carry distinct observations. */
export function dedupeEvents(events: ProviderEvent[]): ProviderEvent[] {
  const sorted = [...events].sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  const seen = new Set<string>();
  return sorted.filter((e) => {
    if (seen.has(e.eventId)) return false;
    seen.add(e.eventId);
    return true;
  });
}

export interface Collected {
  events: ProviderEvent[];
  /** Sources that could not be read. Their volume is unknown, never zero. */
  unavailable: string[];
}

export function collectProviderEvents(opts?: {
  claudeRoot?: string;
  ledgerPath?: string;
  codexHome?: string;
  opencodeDb?: string;
}): Collected {
  const unavailable: string[] = [];
  const claudeRoot = opts?.claudeRoot ?? join(homedir(), ".claude");
  let events: ProviderEvent[] = [];

  try {
    events.push(...claudeEvents(claudeRoot));
  } catch {
    unavailable.push("claude");
  }
  try {
    events.push(...ollamaEvents(opts?.ledgerPath));
  } catch {
    unavailable.push("ollama-claude");
  }
  try {
    events.push(...codexEvents(opts?.codexHome ?? homedir()));
  } catch {
    unavailable.push("codex");
  }
  try {
    const oc = opencodeEvents(
      opts?.opencodeDb ?? join(homedir(), ".local", "share", "opencode", "opencode.db"),
    );
    if (oc === null) unavailable.push("opencode");
    else events.push(...oc);
  } catch {
    unavailable.push("opencode");
  }

  // Deterministic dedup: stable sort by id, keep first occurrence.
  const seen = new Set<string>();
  events.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  const deduped = events.filter((e) => {
    if (seen.has(e.eventId)) return false;
    seen.add(e.eventId);
    return true;
  });
  return { events: deduped, unavailable };
}
