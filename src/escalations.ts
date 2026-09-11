import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { strOrNull } from "@/ledger";

/**
 * One escalation record, as written by llm-tools'
 * `~/.claude/scripts/ollama-record-escalation.sh`.
 *
 * The record exists because `ollama-delegate` no longer stops when the wrapper
 * refuses a third attempt on a spec that hit the turn cap twice: it hands the
 * same spec to a higher-tier author. The local attempts it replaced are then
 * work that Claude (or Codex) went on to do, so pricing them as "what Claude
 * would have cost" counts the same job twice.
 *
 * `supersededRunId` is the ledger `run_id` of the attempts — `author:<label>`.
 * That is a label, not a unique run, which is why `cwd` is on the record too:
 * a ticket number is reused, and the worktree is what pins the record to the
 * attempts it actually replaced.
 */
export interface Escalation {
  ts: string | null;
  /** Unix seconds at which the escalation was recorded. A record without one is
   *  skipped — the window below cannot be placed without it, and the recorder
   *  always writes it. */
  epoch: number;
  label: string | null;
  spec: string | null;
  /** The author the spec went to (e.g. "claude-sonnet-5", "gpt-5.6-terra"). */
  to: string | null;
  /** The worktree the escalated run edits. An empty string is read as null: the
   *  recorder refuses to write one and its README calls such a record not
   *  discountable at all, and read as a real value it matches a legacy ledger row
   *  whose own `cwd` is "", excluding spend nothing replaced. */
  cwd: string | null;
  supersededRunId: string;
}

/**
 * What one read of the sidecar found.
 *
 * The records alone are not enough, and that is the whole reason this type
 * exists. `[]` from a missing file and `[]` from a permission error are the same
 * value, and both make the report say "nothing was superseded" — silently
 * restoring the double-count #81 removed, in the direction that over-states
 * savings. `readLedger` has the same never-throw contract and its consumer
 * (`providers/index.ts`) adds exactly this back; this is that half, at the source.
 */
export interface EscalationRead {
  records: Escalation[];
  /** The path actually read, so the report never names a path it did not consult. */
  path: string;
  /** false when there is no file at `path` at all. */
  exists: boolean;
  /** Non-null when the file is there and could not be read — permission, a
   *  directory at the path, a decoding failure. */
  readError: string | null;
  /** Non-empty lines that yielded no record. Counted rather than dropped, so a
   *  format change upstream is visible instead of quietly halving the exclusions. */
  skippedLines: number;
}

/** The recorder's default look-back for "this label already burned two
 *  attempts", in seconds. It honours `OLLAMA_ATTEMPT_GAP`, so this reader does
 *  too — a widened gap on the recording side would otherwise leave the earlier
 *  attempts priced as savings. */
export const DEFAULT_ATTEMPT_GAP_SECONDS = 14400;

/** Resolves the gap the recorder used. A value that is not a positive integer
 *  falls back to the default, mirroring the recorder's own warn-and-default
 *  rather than failing the whole report over an env typo. */
export function resolveAttemptGapSeconds(): number {
  const raw = process.env["OLLAMA_ATTEMPT_GAP"];
  if (raw === undefined) return DEFAULT_ATTEMPT_GAP_SECONDS;
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  process.stderr.write(
    `warn: OLLAMA_ATTEMPT_GAP=${JSON.stringify(raw)} is not a positive integer — using ${DEFAULT_ATTEMPT_GAP_SECONDS}\n`,
  );
  return DEFAULT_ATTEMPT_GAP_SECONDS;
}

/**
 * Resolves the escalations path, mirroring the recorder's precedence:
 * explicit override > OLLAMA_AGENT_ESCALATIONS > $XDG_STATE_HOME/ollama-agent/
 * escalations.jsonl > ~/.local/state/ollama-agent/escalations.jsonl.
 *
 * It is a sibling of `runs.jsonl` rather than a field on it: that file is
 * written by claude-ceo's bridge, and a new field there risks the parsing this
 * report depends on.
 */
export function resolveEscalationsPath(override?: string): string {
  if (override) return override;
  const env = process.env["OLLAMA_AGENT_ESCALATIONS"];
  if (env) return env;
  const base = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  return join(base, "ollama-agent", "escalations.jsonl");
}

/**
 * Reads and parses the escalations sidecar. A missing file yields [] — the
 * common case, since nothing forces the recorder to run — and malformed lines
 * are skipped, matching the ledger reader so one bad append cannot blind the
 * report.
 */
export function readEscalations(path?: string): EscalationRead {
  const p = resolveEscalationsPath(path);
  if (!existsSync(p)) {
    return { records: [], path: p, exists: false, readError: null, skippedLines: 0 };
  }
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    return {
      records: [], path: p, exists: true, skippedLines: 0,
      readError: e instanceof Error ? e.message : String(e),
    };
  }

  const out: Escalation[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: unknown;
    try { o = JSON.parse(trimmed); } catch { skipped++; continue; }
    if (o === null || typeof o !== "object" || Array.isArray(o)) { skipped++; continue; }
    const r = o as Record<string, unknown>;
    const runId = r["superseded_run_id"];
    const epoch = r["epoch"];
    // Both are required to exclude anything. A record missing either names no
    // run or sits at no point in time, so it can only be skipped — never
    // widened into "supersedes every run with this label".
    if (typeof runId !== "string" || runId === "") { skipped++; continue; }
    if (typeof epoch !== "number" || !isFinite(epoch)) { skipped++; continue; }
    const cwd = strOrNull(r["cwd"]);
    out.push({
      ts: strOrNull(r["ts"]),
      epoch,
      label: strOrNull(r["label"]),
      spec: strOrNull(r["spec"]),
      to: strOrNull(r["to"]),
      cwd: cwd === "" ? null : cwd,
      supersededRunId: runId,
    });
  }
  return { records: out, path: p, exists: true, readError: null, skippedLines: skipped };
}
