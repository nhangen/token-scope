import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Allowlisted subset of the status-line `prompt_cache` object; every field except `scope` is optional (unknown, never zero). */
export interface PromptCacheSnapshot {
  sessionId: string;
  /** Epoch seconds when the collector saw the payload. */
  capturedAt: number;
  /** The status line only reports the main conversation; subagent requests are never counted. */
  scope: "main";
  clientVersion?: string;
  warm?: boolean;
  cachingObserved?: boolean;
  ttl?: "5m" | "1h";
  expiresAt?: number | null;
  requests?: number;
  misses?: number;
  expectedRebuilds?: number;
  /** Session-wide, cumulative. Not the last-request ratio shown elsewhere. */
  sessionHitRatio?: number | null;
  cacheWriteTokens?: number;
  missRecacheTokens?: number;
  lastMissAt?: number | null;
  lastMissCause?: LastMissCause | null;
  missCauses?: Record<string, number>;
  recacheTokensIfCold?: number | null;
}

export interface LastMissCause {
  causes: string[];
  toolsAdded?: number;
  toolsRemoved?: number;
  systemCharDelta?: number;
}

const MAX_CAUSES = 16;
const CAUSE_NAME = /^[a-z0-9_]{1,48}$/;

function num(v: unknown, opts: { int?: boolean; min?: number } = {}): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  if (opts.int && !Number.isInteger(v)) return undefined;
  if (opts.min !== undefined && v < opts.min) return undefined;
  return v;
}

function nullableNum(v: unknown, opts: { int?: boolean; min?: number } = {}): number | null | undefined {
  return v === null ? null : num(v, opts);
}

function parseLastMissCause(v: unknown): LastMissCause | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || v === undefined || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o["causes"])) return undefined;
  const causes = o["causes"].filter((c): c is string => typeof c === "string" && CAUSE_NAME.test(c)).slice(0, MAX_CAUSES);
  if (causes.length === 0) return undefined;
  const out: LastMissCause = { causes };
  const added = num(o["tools_added"], { int: true, min: 0 });
  const removed = num(o["tools_removed"], { int: true, min: 0 });
  const delta = num(o["system_char_delta"], { int: true });
  if (added !== undefined) out.toolsAdded = added;
  if (removed !== undefined) out.toolsRemoved = removed;
  if (delta !== undefined) out.systemCharDelta = delta;
  return out;
}

function parseMissCauses(v: unknown): Record<string, number> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const count = num(n, { int: true, min: 0 });
    if (CAUSE_NAME.test(k) && count !== undefined && Object.keys(out).length < MAX_CAUSES) out[k] = count;
  }
  return out;
}

/**
 * Extracts the allowlisted fields from a status-line payload. Returns null when there is no
 * session id or no `prompt_cache` object (older clients, or before the first API response).
 * Anything outside the allowlist, including prompts, paths, and cost, is dropped here.
 */
export function sanitizePayload(payload: unknown, capturedAt: number): PromptCacheSnapshot | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const sessionId = p["session_id"];
  const pc = p["prompt_cache"];
  if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > 128) return null;
  if (typeof pc !== "object" || pc === null || Array.isArray(pc)) return null;
  const c = pc as Record<string, unknown>;

  const snap: PromptCacheSnapshot = { sessionId, capturedAt, scope: "main" };
  const version = p["version"];
  if (typeof version === "string" && /^[0-9A-Za-z.\-+]{1,32}$/.test(version)) snap.clientVersion = version;
  if (typeof c["warm"] === "boolean") snap.warm = c["warm"];
  if (typeof c["caching_observed"] === "boolean") snap.cachingObserved = c["caching_observed"];
  if (c["ttl"] === "5m" || c["ttl"] === "1h") snap.ttl = c["ttl"];
  const expiresAt = nullableNum(c["expires_at"], { min: 0 });
  if (expiresAt !== undefined) snap.expiresAt = expiresAt;
  const requests = num(c["requests"], { int: true, min: 0 });
  if (requests !== undefined) snap.requests = requests;
  const misses = num(c["misses"], { int: true, min: 0 });
  if (misses !== undefined) snap.misses = misses;
  const rebuilds = num(c["expected_rebuilds"], { int: true, min: 0 });
  if (rebuilds !== undefined) snap.expectedRebuilds = rebuilds;
  const ratio = nullableNum(c["hit_ratio"]);
  if (ratio === null || (ratio !== undefined && ratio >= 0 && ratio <= 1)) snap.sessionHitRatio = ratio;
  const writes = num(c["cache_write_tokens"], { int: true, min: 0 });
  if (writes !== undefined) snap.cacheWriteTokens = writes;
  const recached = num(c["miss_recache_tokens"], { int: true, min: 0 });
  if (recached !== undefined) snap.missRecacheTokens = recached;
  const lastMissAt = nullableNum(c["last_miss_at"], { min: 0 });
  if (lastMissAt !== undefined) snap.lastMissAt = lastMissAt;
  const lastCause = parseLastMissCause(c["last_miss_cause"]);
  if (lastCause !== undefined) snap.lastMissCause = lastCause;
  const missCauses = parseMissCauses(c["miss_causes"]);
  if (missCauses !== undefined) snap.missCauses = missCauses;
  const cold = nullableNum(c["recache_tokens_if_cold"], { int: true, min: 0 });
  if (cold !== undefined) snap.recacheTokensIfCold = cold;
  return snap;
}

export function promptCacheLogPath(env: Record<string, string | undefined> = process.env): string {
  const override = env["TOKEN_SCOPE_PROMPT_CACHE_LOG"];
  if (override) return override;
  const base = env["XDG_STATE_HOME"] || join(env["HOME"] ?? "~", ".local", "state");
  return join(base, "token-scope", "prompt-cache.jsonl");
}

function sameCounters(a: PromptCacheSnapshot, b: PromptCacheSnapshot): boolean {
  const { capturedAt: _a, ...ra } = a;
  const { capturedAt: _b, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
}

/** Appends a snapshot unless it repeats the session's previous one (the status line re-fires on timers). */
export function appendSnapshot(path: string, snap: PromptCacheSnapshot): boolean {
  const last = readSnapshots(path).filter((s) => s.sessionId === snap.sessionId).at(-1);
  if (last && sameCounters(last, snap)) return false;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(snap) + "\n", { mode: 0o600 });
  return true;
}

/** Reads the log, skipping malformed lines. */
export function readSnapshots(path: string): PromptCacheSnapshot[] {
  if (!existsSync(path)) return [];
  const out: PromptCacheSnapshot[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as PromptCacheSnapshot;
      if (typeof rec.sessionId === "string" && typeof rec.capturedAt === "number") out.push(rec);
    } catch {
      continue;
    }
  }
  return out;
}

export interface NativeSessionCache {
  sessionId: string;
  scope: "main";
  /** Counter resets or resumes detected within the session; each segment is counted once. */
  segments: number;
  lastCapturedAt: number;
  clientVersion?: string;
  requests?: number;
  misses?: number;
  expectedRebuilds?: number;
  /** Session-wide ratio of the latest snapshot; null across a multi-segment session since ratios cannot be merged. */
  sessionHitRatio: number | null;
  cacheWriteTokens?: number;
  missRecacheTokens?: number;
  recacheTokensIfCold: number | null;
  lastMissAt: number | null;
  lastMissCause: LastMissCause | null;
  missCauses: Record<string, number>;
  ttl?: "5m" | "1h";
  warm?: boolean;
}

export interface NativeCacheSummary {
  provenance: "reported";
  scope: "main";
  sessions: number;
  requests: number | null;
  misses: number | null;
  expectedRebuilds: number | null;
  cacheWriteTokens: number | null;
  missRecacheTokens: number | null;
  missCauses: Record<string, number>;
  rows: NativeSessionCache[];
}

const COUNTERS = ["requests", "misses", "expectedRebuilds", "cacheWriteTokens", "missRecacheTokens"] as const;

/**
 * Collapses cumulative snapshots to one value per counter segment. A snapshot whose `requests`
 * (or any cumulative counter) drops below the previous one starts a new segment, which is how a
 * resumed or restarted session shows up. Totals sum each segment's final snapshot, so repeated
 * snapshots never inflate them.
 */
export function reduceSession(snaps: PromptCacheSnapshot[]): NativeSessionCache {
  const sorted = [...snaps].sort((a, b) => a.capturedAt - b.capturedAt);
  const finals: PromptCacheSnapshot[] = [];
  for (const s of sorted) {
    const prev = finals.at(-1);
    const reset = prev !== undefined && COUNTERS.some((k) => s[k] !== undefined && prev[k] !== undefined && s[k]! < prev[k]!);
    if (prev === undefined || reset) finals.push(s);
    else finals[finals.length - 1] = mergeLatest(prev, s);
  }
  const latest = finals.at(-1)!;
  const row: NativeSessionCache = {
    sessionId: latest.sessionId,
    scope: "main",
    segments: finals.length,
    lastCapturedAt: latest.capturedAt,
    sessionHitRatio: finals.length === 1 ? (latest.sessionHitRatio ?? null) : null,
    recacheTokensIfCold: latest.recacheTokensIfCold ?? null,
    lastMissAt: latest.lastMissAt ?? null,
    lastMissCause: latest.lastMissCause ?? null,
    missCauses: {},
  };
  if (latest.clientVersion) row.clientVersion = latest.clientVersion;
  if (latest.ttl) row.ttl = latest.ttl;
  if (latest.warm !== undefined) row.warm = latest.warm;
  for (const k of COUNTERS) {
    const seen = finals.filter((f) => f[k] !== undefined);
    if (seen.length > 0) row[k] = seen.reduce((n, f) => n + f[k]!, 0);
  }
  for (const f of finals) {
    for (const [cause, n] of Object.entries(f.missCauses ?? {})) row.missCauses[cause] = (row.missCauses[cause] ?? 0) + n;
  }
  return row;
}

/** Later snapshots win field by field, but an absent field never erases a value already reported. */
function mergeLatest(prev: PromptCacheSnapshot, next: PromptCacheSnapshot): PromptCacheSnapshot {
  const merged: PromptCacheSnapshot = { ...prev };
  for (const [k, v] of Object.entries(next)) if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  return merged;
}

function sumOrNull(rows: NativeSessionCache[], k: (typeof COUNTERS)[number]): number | null {
  const seen = rows.filter((r) => r[k] !== undefined);
  return seen.length === 0 ? null : seen.reduce((n, r) => n + r[k]!, 0);
}

/** Sessions are included whole when their latest snapshot falls in the window; counters are session-cumulative. */
export function summarizeNative(snaps: PromptCacheSnapshot[], sinceSec: number): NativeCacheSummary {
  const bySession = new Map<string, PromptCacheSnapshot[]>();
  for (const s of snaps) {
    if (s.scope !== "main") continue;
    const list = bySession.get(s.sessionId) ?? [];
    list.push(s);
    bySession.set(s.sessionId, list);
  }
  const rows = [...bySession.values()]
    .map(reduceSession)
    .filter((r) => r.lastCapturedAt >= sinceSec)
    .sort((a, b) => b.lastCapturedAt - a.lastCapturedAt);
  const missCauses: Record<string, number> = {};
  for (const r of rows) for (const [c, n] of Object.entries(r.missCauses)) missCauses[c] = (missCauses[c] ?? 0) + n;
  return {
    provenance: "reported",
    scope: "main",
    sessions: rows.length,
    requests: sumOrNull(rows, "requests"),
    misses: sumOrNull(rows, "misses"),
    expectedRebuilds: sumOrNull(rows, "expectedRebuilds"),
    cacheWriteTokens: sumOrNull(rows, "cacheWriteTokens"),
    missRecacheTokens: sumOrNull(rows, "missRecacheTokens"),
    missCauses,
    rows,
  };
}
