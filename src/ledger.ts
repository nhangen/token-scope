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
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * Reads and parses the ledger. A missing file yields []; malformed lines are
 * skipped (best-effort, matching the writer's never-fail contract) so one bad
 * append can't blind the whole report.
 */
export function readLedger(path?: string): LedgerRun[] {
  const p = resolveLedgerPath(path);
  if (!existsSync(p)) return [];
  let raw: string;
  try { raw = readFileSync(p, "utf8"); } catch { return []; }

  const runs: LedgerRun[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: unknown;
    try { o = JSON.parse(trimmed); } catch { continue; }
    if (o === null || typeof o !== "object" || Array.isArray(o)) continue;
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
    });
  }
  return runs;
}
