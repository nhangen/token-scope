/**
 * Provider event collection across harnesses (#37).
 *
 * Sources can be overridden per call OR via environment variables so the
 * production CLI path (`token-scope --providers`) is testable end to end:
 *   TOKEN_SCOPE_CLAUDE_ROOT, TOKEN_SCOPE_LEDGER,
 *   TOKEN_SCOPE_CODEX_HOME, TOKEN_SCOPE_OPENCODE_DB,
 *   TOKEN_SCOPE_GEMINI_ROOT
 */
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { claudeEvents } from "./claude";
import { ollamaEvents } from "./ollama";
import { codexEvents } from "./codex";
import { opencodeEvents } from "./opencode";
import { geminiCliEvents, UNSUPPORTED_GOOGLE_SURFACES } from "./gemini-cli";
import { ollamaRouteEvents } from "./ollama-route";
import type { CollectorError, PartialReason, ProviderEvent, UnavailableReason } from "./types";
import { sanitizeErrorClass } from "./types";
export type { CollectorError, PartialReason, ProviderEvent, UnavailableReason } from "./types";
export { sanitizeErrorClass } from "./types";

export interface Collected {
  events: ProviderEvent[];
  /** Sources that could not be read. Their volume is unknown, never zero. */
  unavailable: string[];
  /** Why each unavailable source could not be read, by harness (#174). */
  unavailableReasons?: Record<string, UnavailableReason[]>;
  /** Captured error details when a collector throws unexpectedly (#174). */
  collectorErrors?: Record<string, CollectorError>;
  /** Sources read partially: affected files by harness. Partial volume must
   * not masquerade as complete (#38 panel). */
  partial: Record<string, number>;
  /** Why each partially-read source is partial, by harness (#125).
   * Distinct from the count in `partial` — a file that was unreadable
   * is a different cause than one whose records are incomplete. Optional
   * so callers that only consume `partial` do not need to know the
   * cause. Populated by `collectProviderEvents`. */
  partialReasons?: Record<string, PartialReason[]>;
  /** Source surfaces intentionally not ingested by this version. */
  unsupported?: string[];
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
  geminiRoot?: string;
  ollamaRoutingTelemetry?: string;
  sinceMs?: number;
}): Collected {
  const unavailable: string[] = [];
  const unavailableReasons: Record<string, UnavailableReason[]> = {};
  const collectorErrors: Record<string, CollectorError> = {};
  const addUnavailableReason = (h: string, r: UnavailableReason): void => {
    (unavailableReasons[h] ??= []).push(r);
  };
  const recordCollectorCrash = (h: string, err: unknown): void => {
    unavailable.push(h);
    addUnavailableReason(h, "collector_error");
    collectorErrors[h] = { errorClass: sanitizeErrorClass(err) };
  };
  const partial: Record<string, number> = {};
  const partialReasons: Record<string, PartialReason[]> = {};
  const addReason = (h: string, r: PartialReason): void => {
    (partialReasons[h] ??= []).push(r);
  };
  const claudeRoot =
    opts?.claudeRoot ?? process.env.TOKEN_SCOPE_CLAUDE_ROOT ?? join(homedir(), ".claude");
  const ledgerPath = opts?.ledgerPath ?? process.env.TOKEN_SCOPE_LEDGER;
  const codexHome = opts?.codexHome ?? process.env.TOKEN_SCOPE_CODEX_HOME ?? homedir();
  const dataRoot = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const opencodeDb =
    opts?.opencodeDb ?? process.env.TOKEN_SCOPE_OPENCODE_DB ?? join(dataRoot, "opencode", "opencode.db");
  const geminiRoot =
    opts?.geminiRoot ?? process.env.TOKEN_SCOPE_GEMINI_ROOT ?? join(homedir(), ".gemini");
  const ollamaRoutingTelemetry = opts?.ollamaRoutingTelemetry
    ?? process.env.TOKEN_SCOPE_OLLAMA_ROUTING_TELEMETRY;
  const sinceMs = opts?.sinceMs;
  let events: ProviderEvent[] = [];

  try {
    const c = claudeEvents(claudeRoot, sinceMs);
    events.push(...c.events);
    if (c.skipped > 0) {
      partial["claude"] = c.skipped;
      for (const r of c.reasons) addReason("claude", r);
    }
  } catch (err) {
    recordCollectorCrash("claude", err);
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
        addReason("ollama-claude", "corrupt_store");
      }
    }
  } catch (err) {
    recordCollectorCrash("ollama-claude", err);
  }
  try {
    const cx = codexEvents(codexHome, sinceMs);
    events.push(...cx.events);
    if (cx.skipped > 0) {
      partial["codex"] = cx.skipped;
      for (const r of cx.reasons) addReason("codex", r);
    }
  } catch (err) {
    recordCollectorCrash("codex", err);
  }
  try {
    const oc = opencodeEvents(opencodeDb, sinceMs);
    if (oc === null) {
      unavailable.push("opencode");
      addUnavailableReason("opencode", "unreadable");
    } else {
      events.push(...oc);
    }
  } catch (err) {
    recordCollectorCrash("opencode", err);
  }

  try {
    const gemini = geminiCliEvents(geminiRoot, sinceMs);
    events.push(...gemini.events);
    if (gemini.source.state === "unavailable") {
      unavailable.push("gemini-cli");
      const r = gemini.source.reason === "unsafe_path" ? "unsafe_path" : "unreadable";
      addUnavailableReason("gemini-cli", r);
    }
    if (gemini.source.state === "partial") {
      partial["gemini-cli"] = gemini.affectedFiles;
      for (const r of gemini.reasons) addReason("gemini-cli", r);
    }
  } catch (err) {
    recordCollectorCrash("gemini-cli", err);
  }

  if (ollamaRoutingTelemetry !== undefined) {
    try {
      const route = ollamaRouteEvents(ollamaRoutingTelemetry, sinceMs);
      events.push(...route.events);
      if (route.readError !== null) {
        unavailable.push("ollama-route");
        addUnavailableReason("ollama-route", "unreadable");
      }
      if (route.skippedLines > 0) {
        partial["ollama-route"] = route.skippedLines;
        addReason("ollama-route", "malformed");
      }
    } catch (err) {
      recordCollectorCrash("ollama-route", err);
    }
  }

  for (const h of Object.keys(unavailableReasons)) {
    unavailableReasons[h]!.sort();
  }

  return {
    events: dedupeEvents(events),
    unavailable,
    unavailableReasons,
    collectorErrors,
    partial,
    partialReasons,
    unsupported: [...UNSUPPORTED_GOOGLE_SURFACES],
  };
}
