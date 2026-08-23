/**
 * Provider event collection across harnesses (#37).
 *
 * Sources can be overridden per call OR via environment variables so the
 * production CLI path (`token-scope --providers`) is testable end to end:
 *   TOKEN_SCOPE_CLAUDE_ROOT, TOKEN_SCOPE_LEDGER,
 *   TOKEN_SCOPE_CODEX_HOME, TOKEN_SCOPE_OPENCODE_DB
 */
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { claudeEvents } from "./claude";
import { ollamaEvents } from "./ollama";
import { codexEvents } from "./codex";
import { opencodeEvents } from "./opencode";
import type { ProviderEvent } from "./types";
export type { ProviderEvent } from "./types";

export interface Collected {
  events: ProviderEvent[];
  /** Sources that could not be read. Their volume is unknown, never zero. */
  unavailable: string[];
  /** Sources read partially: files that existed but failed to parse/read,
   * by harness. Partial volume must not masquerade as complete (#38 panel). */
  partial: Record<string, number>;
}

export function dedupeEvents(events: ProviderEvent[]): ProviderEvent[] {
  // Deterministic dedup: stable sort by id, keep first occurrence.
  const seen = new Set<string>();
  events.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
  return events.filter((e) => {
    if (seen.has(e.eventId)) return false;
    seen.add(e.eventId);
    return true;
  });
}

export function collectProviderEvents(opts?: {
  claudeRoot?: string;
  ledgerPath?: string;
  codexHome?: string;
  opencodeDb?: string;
  sinceMs?: number;
}): Collected {
  const unavailable: string[] = [];
  const partial: Record<string, number> = {};
  const claudeRoot =
    opts?.claudeRoot ?? process.env.TOKEN_SCOPE_CLAUDE_ROOT ?? join(homedir(), ".claude");
  const ledgerPath = opts?.ledgerPath ?? process.env.TOKEN_SCOPE_LEDGER;
  const codexHome = opts?.codexHome ?? process.env.TOKEN_SCOPE_CODEX_HOME ?? homedir();
  const dataRoot = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const opencodeDb =
    opts?.opencodeDb ?? process.env.TOKEN_SCOPE_OPENCODE_DB ?? join(dataRoot, "opencode", "opencode.db");
  const sinceMs = opts?.sinceMs;
  let events: ProviderEvent[] = [];

  try {
    const c = claudeEvents(claudeRoot, sinceMs);
    events.push(...c.events);
    if (c.skipped > 0) partial["claude"] = c.skipped;
  } catch {
    unavailable.push("claude");
  }
  try {
    // readLedger's contract is "never throw", so an unreadable or fully
    // corrupt ledger is indistinguishable from an empty one downstream.
    // Absent file = legitimately zero (a machine that never delegated).
    // Present but producing no events from real content = volume unknown:
    // surface it in `partial` instead of reporting silent zero (#37 audit).
    const resolved = ledgerPath ?? join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "ollama-agent", "runs.jsonl",
    );
    const evs = ollamaEvents(ledgerPath);
    events.push(...evs);
    if (existsSync(resolved) && evs.length === 0) {
      const raw = readFileSync(resolved, "utf8");
      if (raw.split("\n").some((l) => l.trim())) {
        partial["ollama-claude"] = raw.split("\n").filter((l) => l.trim()).length;
      }
    }
  } catch {
    unavailable.push("ollama-claude");
  }
  try {
    const cx = codexEvents(codexHome, sinceMs);
    events.push(...cx.events);
    if (cx.skipped > 0) partial["codex"] = cx.skipped;
  } catch {
    unavailable.push("codex");
  }
  try {
    const oc = opencodeEvents(opencodeDb, sinceMs);
    if (oc === null) unavailable.push("opencode");
    else events.push(...oc);
  } catch {
    unavailable.push("opencode");
  }

  return { events: dedupeEvents(events), unavailable, partial };
}
