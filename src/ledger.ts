import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * One ollama-agent delegation run, as written by the bridge's ledger.py.
 * Token counts are ground truth from ollama's eval_count/prompt_eval_count.
 */
export interface LedgerRun {
  ts: string | null;
  runId: string | null;
  sessionId: string | null;
  model: string | null;
  taskName: string | null;
  cwd: string | null;
  ollamaInputTokens: number;
  ollamaOutputTokens: number;
  turns: number | null;
  completed: boolean | null;
  verified: boolean | null;
  /** Why the run ended: "ok" | "turn-cap" | "verify-failed", or null on any row
   *  written before the bridge recorded it (nhangen/claude-ceo#327). null means
   *  "not recorded" — never a claim about the run. */
  reason: string | null;
}

/**
 * Resolves the ledger path, mirroring the bridge writer's precedence exactly:
 * explicit override > OLLAMA_AGENT_LEDGER > $XDG_STATE_HOME/ollama-agent/runs.jsonl
 * > ~/.local/state/ollama-agent/runs.jsonl.
 */
export function resolveLedgerPath(override?: string): string {
  if (override) return override;
  const env = process.env["OLLAMA_AGENT_LEDGER"];
  if (env) return env;
  const base = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  return join(base, "ollama-agent", "runs.jsonl");
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}
/** Exported so the escalations reader shares one definition rather than inlining
 *  the same `typeof` narrowing at each field. */
export function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * What one read of the ledger found.
 *
 * Same shape and same reason as `EscalationRead`: `[]` from a missing ledger and
 * `[]` from a permission error are one value, and the report renders both as a
 * confident, complete-looking zero. That is worse here than on the sidecar, since
 * this is the primary source — a savings report that discloses the sidecar's load
 * status and not the ledger's advertises an integrity it does not have.
 */
export interface LedgerRead {
  runs: LedgerRun[];
  /** The path actually read, so no caller reports a file it did not consult. */
  path: string;
  exists: boolean;
  /** Non-null when the file is there and could not be read. */
  readError: string | null;
  /** Non-empty lines that yielded no run. */
  skippedLines: number;
}

/**
 * Reads and parses the ledger. A missing file yields []; malformed lines are
 * skipped (best-effort, matching the writer's never-fail contract) so one bad
 * append can't blind the whole report.
 *
 * Callers that render a figure derived from the result should use
 * `readLedgerWithStatus` instead and disclose what it found.
 */
export function readLedger(path?: string): LedgerRun[] {
  return readLedgerWithStatus(path).runs;
}

/** `readLedger` plus what the read itself found. See `LedgerRead`. */
export function readLedgerWithStatus(path?: string): LedgerRead {
  const p = resolveLedgerPath(path);
  if (!existsSync(p)) {
    return { runs: [], path: p, exists: false, readError: null, skippedLines: 0 };
  }
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    return {
      runs: [], path: p, exists: true, skippedLines: 0,
      readError: e instanceof Error ? e.message : String(e),
    };
  }

  let skipped = 0;
  const runs: LedgerRun[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: unknown;
    try { o = JSON.parse(trimmed); } catch { skipped++; continue; }
    if (o === null || typeof o !== "object" || Array.isArray(o)) { skipped++; continue; }
    const r = o as Record<string, unknown>;
    runs.push({
      ts: strOrNull(r["ts"]),
      runId: strOrNull(r["run_id"]),
      sessionId: strOrNull(r["session_id"]),
      model: strOrNull(r["model"]),
      taskName: strOrNull(r["task_name"]),
      cwd: strOrNull(r["cwd"]),
      ollamaInputTokens: num(r["ollama_input_tokens"]),
      ollamaOutputTokens: num(r["ollama_output_tokens"]),
      turns: numOrNull(r["turns"]),
      completed: boolOrNull(r["completed"]),
      verified: boolOrNull(r["verified"]),
      reason: strOrNull(r["reason"]),
    });
  }
  return { runs, path: p, exists: true, readError: null, skippedLines: skipped };
}
