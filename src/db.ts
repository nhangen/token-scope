import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DbPathResult {
  path: string;
  source: "flag" | "env" | "xdg" | "default";
}

export interface SummaryTotals {
  totalOutputTokens: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number | null;
  sessionCount: number;
  turnCount: number;
  avgCostPerSession: number | null;
  avgCostPerTurn: number | null;
}

export interface ToolRow {
  tool: string;
  turns: number;
  outputTokens: number;
  outputPct: number;
  avgOutputPerTurn: number;
  totalCostUsd: number | null;
  costPct: number | null;
}

export interface ProjectRow {
  cwd: string;
  sessions: number;
  turns: number;
  outputTokens: number;
  totalCostUsd: number | null;
  avgSessionCost: number | null;
}

export interface SessionRow {
  sessionId: string;
  cwd: string | null;
  startedAt: number;
  durationMs: number | null;
  turnCount: number;
  outputTokens: number;
  cacheHitPct: number | null;
  totalCostUsd: number | null;
}

export interface TurnRow {
  uuid: string;
  timestamp: number;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  model: string | null;
  stopReason: string | null;
  message: string;
}

export interface WeekRow {
  weekLabel: string;
  sessions: number;
  turns: number;
  outputTokens: number;
  totalCostUsd: number | null;
}

export interface ThinkingTurnRow {
  uuid: string;
  sessionId: string;
  cwd: string | null;
  timestamp: number;
  outputTokens: number;
  costUsd: number | null;
  thinkingChars: number;
  textChars: number;
  message: string;
}

export interface ProjectMatch { cwd: string; }

export interface BashCommandRow {
  command: string;
  outputTokens: number;
  costUsd: number | null;
  uuid: string;
  timestamp: number;
  sessionId: string;
}

export interface RawTurnForTool {
  uuid: string;
  sessionId: string;
  cwd: string | null;
  outputTokens: number;
  costUsd: number | null;
  message: string;
}

export interface ContextStatRow {
  sessionId: string;
  cwd: string | null;
  turnCount: number;
  avgEarlyInput: number;
  avgLateInput: number;
  bloatRatio: number | null;
}

export interface CacheStatRow {
  cwd: string;
  sessions: number;
  turns: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  cacheHitPct: number | null;
  estimatedSavingsUsd: number | null;
}

// ─── DB Path Resolution ───────────────────────────────────────────────────────

export function resolveDbPath(flagPath?: string): DbPathResult {
  if (flagPath) return { path: flagPath, source: "flag" };
  const envPath = process.env["TOKEN_SCOPE_DB"];
  if (envPath) return { path: envPath, source: "env" };
  const xdgConfig = process.env["XDG_CONFIG_HOME"];
  if (xdgConfig) {
    const xdgPath = join(xdgConfig, "claude", "__store.db");
    if (existsSync(xdgPath)) return { path: xdgPath, source: "xdg" };
  }
  const defaultPath = join(process.env["HOME"] ?? "~", ".claude", "__store.db");
  return { path: defaultPath, source: "default" };
}

// ─── DB Open ─────────────────────────────────────────────────────────────────

export function openDb(path: string): Database {
  if (!existsSync(path)) {
    process.stderr.write(`Database not found at "${path}". Set TOKEN_SCOPE_DB to override.\n`);
    process.exit(1);
  }
  try {
    return new Database(path, { readonly: true });
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) {
      process.stderr.write(`Database is locked ("${path}"). Wait for other processes to finish, then retry.\n`);
    } else if (msg.includes("SQLITE_CORRUPT") || msg.includes("malformed")) {
      process.stderr.write(`Database at "${path}" appears corrupted. Try pointing to a backup copy via TOKEN_SCOPE_DB.\n`);
    } else if (msg.includes("EACCES") || msg.includes("permission denied")) {
      process.stderr.write(`Cannot read "${path}": permission denied. Check file permissions or set TOKEN_SCOPE_DB.\n`);
    } else {
      process.stderr.write(`Failed to open database at "${path}": ${msg}\n`);
    }
    process.exit(1);
  }
}

// ─── Time Helpers ─────────────────────────────────────────────────────────────

export function parseSince(since: string): number {
  const now = Math.floor(Date.now() / 1000);
  const match = /^(\d+)(h|d|w)$/.exec(since);
  if (!match) throw new Error(`Invalid --since format: "${since}". Use Nh, Nd, or Nw.`);
  const n = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = { h: 3_600, d: 86_400, w: 604_800 };
  return now - n * multipliers[unit]!;
}

// ─── Base join fragment ───────────────────────────────────────────────────────

const JOIN = `
FROM assistant_messages am
JOIN base_messages bm ON am.uuid = bm.uuid
WHERE bm.timestamp > ?
  AND json_valid(am.message) = 1
`;

// ─── Summary Totals ───────────────────────────────────────────────────────────

export function querySummaryTotals(db: Database, since: number): SummaryTotals {
  const row = db.query<{
    totalOutputTokens: number; totalInputTokens: number;
    totalCacheReadTokens: number; totalCacheWriteTokens: number;
    totalCostUsd: number | null; sessionCount: number; turnCount: number;
  }, [number]>(`
    SELECT
      SUM(CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER)) AS totalOutputTokens,
      SUM(CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER)) AS totalInputTokens,
      SUM(CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER)) AS totalCacheReadTokens,
      SUM(CAST(json_extract(am.message, '$.usage.cache_creation_input_tokens') AS INTEGER)) AS totalCacheWriteTokens,
      SUM(am.cost_usd) AS totalCostUsd,
      COUNT(DISTINCT bm.session_id) AS sessionCount,
      COUNT(*) AS turnCount
    ${JOIN}
  `).get(since);

  if (!row) return { totalOutputTokens: 0, totalInputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCostUsd: null, sessionCount: 0, turnCount: 0, avgCostPerSession: null, avgCostPerTurn: null };

  return {
    ...row,
    avgCostPerSession: row.totalCostUsd != null && row.sessionCount > 0 ? row.totalCostUsd / row.sessionCount : null,
    avgCostPerTurn: row.totalCostUsd != null && row.turnCount > 0 ? row.totalCostUsd / row.turnCount : null,
  };
}

// ─── Raw Turns (for dominant-tool grouping in JS) ─────────────────────────────

export function queryRawTurnsForTool(db: Database, since: number): RawTurnForTool[] {
  return db.query<RawTurnForTool, [number]>(`
    SELECT am.uuid, bm.session_id AS sessionId, bm.cwd,
      CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER) AS outputTokens,
      am.cost_usd AS costUsd, am.message
    ${JOIN}
  `).all(since);
}

// ─── By-Tool (dominant tool resolved via parse.ts) ────────────────────────────

export function queryByTool(db: Database, since: number, limit: number): ToolRow[] {
  const { parseContentBlocks, resolveDominantTool } = require("./parse") as typeof import("./parse");
  const turns = queryRawTurnsForTool(db, since);
  const totalOutput = turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalCost = turns.reduce((s, t) => s + (t.costUsd ?? 0), 0);

  const byTool = new Map<string, { turns: number; outputTokens: number; costUsd: number }>();
  for (const turn of turns) {
    const tool = resolveDominantTool(parseContentBlocks(turn.message));
    const e = byTool.get(tool) ?? { turns: 0, outputTokens: 0, costUsd: 0 };
    byTool.set(tool, { turns: e.turns + 1, outputTokens: e.outputTokens + turn.outputTokens, costUsd: e.costUsd + (turn.costUsd ?? 0) });
  }

  return Array.from(byTool.entries())
    .map(([tool, d]) => ({
      tool, turns: d.turns, outputTokens: d.outputTokens,
      outputPct: totalOutput > 0 ? (d.outputTokens / totalOutput) * 100 : 0,
      avgOutputPerTurn: d.turns > 0 ? d.outputTokens / d.turns : 0,
      totalCostUsd: d.costUsd > 0 ? d.costUsd : null,
      costPct: totalCost > 0 ? (d.costUsd / totalCost) * 100 : null,
    }))
    .sort((a, b) => b.outputTokens - a.outputTokens)
    .slice(0, limit);
}

// ─── By-Project ───────────────────────────────────────────────────────────────

export function queryByProject(db: Database, since: number, limit: number): ProjectRow[] {
  return db.query<ProjectRow, [number, number]>(`
    SELECT bm.cwd,
      COUNT(DISTINCT bm.session_id) AS sessions,
      COUNT(*) AS turns,
      SUM(CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER)) AS outputTokens,
      SUM(am.cost_usd) AS totalCostUsd,
      CASE WHEN COUNT(DISTINCT bm.session_id) > 0 THEN SUM(am.cost_usd) / COUNT(DISTINCT bm.session_id) ELSE NULL END AS avgSessionCost
    ${JOIN}
    GROUP BY bm.cwd ORDER BY totalCostUsd DESC NULLS LAST LIMIT ?
  `).all(since, limit);
}

// ─── Sessions List ────────────────────────────────────────────────────────────

export function querySessions(db: Database, since: number, limit: number): SessionRow[] {
  return db.query<SessionRow, [number, number]>(`
    SELECT bm.session_id AS sessionId, bm.cwd,
      MIN(bm.timestamp) * 1000 AS startedAt,
      CASE WHEN COUNT(*) > 1 THEN (MAX(bm.timestamp) - MIN(bm.timestamp)) * 1000 ELSE NULL END AS durationMs,
      COUNT(*) AS turnCount,
      SUM(CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER)) AS outputTokens,
      CASE WHEN SUM(CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER) +
                   CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER)) > 0
           THEN CAST(SUM(CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER)) AS REAL) /
                SUM(CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER) +
                    CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER)) * 100
           ELSE NULL END AS cacheHitPct,
      SUM(am.cost_usd) AS totalCostUsd
    ${JOIN}
    GROUP BY bm.session_id ORDER BY totalCostUsd DESC NULLS LAST LIMIT ?
  `).all(since, limit);
}

// ─── Session Turns ────────────────────────────────────────────────────────────

export function querySessionTurns(db: Database, sessionId: string): TurnRow[] {
  return db.query<TurnRow, [string]>(`
    SELECT am.uuid, bm.timestamp * 1000 AS timestamp,
      CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER) AS outputTokens,
      CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER) AS inputTokens,
      CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER) AS cacheReadTokens,
      CAST(json_extract(am.message, '$.usage.cache_creation_input_tokens') AS INTEGER) AS cacheWriteTokens,
      am.cost_usd AS costUsd, am.duration_ms AS durationMs, am.model,
      json_extract(am.message, '$.stop_reason') AS stopReason, am.message
    FROM assistant_messages am
    JOIN base_messages bm ON am.uuid = bm.uuid
    WHERE bm.session_id = ? AND json_valid(am.message) = 1
    ORDER BY bm.timestamp ASC
  `).all(sessionId);
}

// ─── Weekly Trend ─────────────────────────────────────────────────────────────

export function queryWeeklyTrend(db: Database, since: number): WeekRow[] {
  return db.query<WeekRow, [number]>(`
    SELECT
      strftime('%Y-W%W', datetime(bm.timestamp, 'unixepoch')) AS weekLabel,
      COUNT(DISTINCT bm.session_id) AS sessions, COUNT(*) AS turns,
      SUM(CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER)) AS outputTokens,
      SUM(am.cost_usd) AS totalCostUsd
    ${JOIN}
    GROUP BY weekLabel ORDER BY weekLabel DESC LIMIT 5
  `).all(since);
}

// ─── Thinking Turns ───────────────────────────────────────────────────────────

export function queryThinkingTurns(db: Database, since: number): ThinkingTurnRow[] {
  return db.query<ThinkingTurnRow, [number]>(`
    SELECT am.uuid, bm.session_id AS sessionId, bm.cwd, bm.timestamp * 1000 AS timestamp,
      CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER) AS outputTokens,
      am.cost_usd AS costUsd,
      SUM(CASE WHEN json_extract(block.value, '$.type') = 'thinking'
               THEN LENGTH(COALESCE(json_extract(block.value, '$.thinking'), '')) ELSE 0 END) AS thinkingChars,
      SUM(CASE WHEN json_extract(block.value, '$.type') = 'text'
               THEN LENGTH(COALESCE(json_extract(block.value, '$.text'), '')) ELSE 0 END) AS textChars,
      am.message
    FROM assistant_messages am
    JOIN base_messages bm ON am.uuid = bm.uuid
    CROSS JOIN json_each(am.message, '$.content') AS block
    WHERE bm.timestamp > ? AND json_valid(am.message) = 1
    GROUP BY am.uuid HAVING thinkingChars > 0
  `).all(since);
}

// ─── Project Lookup ───────────────────────────────────────────────────────────

export function queryProjectMatches(db: Database, fragment: string): ProjectMatch[] {
  return db.query<ProjectMatch, [string]>(`
    SELECT DISTINCT bm.cwd FROM base_messages bm
    WHERE LOWER(bm.cwd) LIKE LOWER(?) AND bm.cwd IS NOT NULL ORDER BY bm.cwd
  `).all(`%${fragment}%`);
}

// ─── Bash Command Rows ────────────────────────────────────────────────────────

export function queryBashTurns(db: Database, since: number): BashCommandRow[] {
  return db.query<BashCommandRow, [number]>(`
    SELECT json_extract(block.value, '$.input.command') AS command,
      CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER) AS outputTokens,
      am.cost_usd AS costUsd, am.uuid, bm.timestamp, bm.session_id AS sessionId
    FROM assistant_messages am
    JOIN base_messages bm ON am.uuid = bm.uuid
    CROSS JOIN json_each(am.message, '$.content') AS block
    WHERE bm.timestamp > ? AND json_valid(am.message) = 1
      AND json_extract(block.value, '$.type') = 'tool_use'
      AND LOWER(json_extract(block.value, '$.name')) = 'bash'
  `).all(since);
}

// ─── Context Stats ────────────────────────────────────────────────────────────

export function queryContextStats(db: Database, since: number, limit: number): ContextStatRow[] {
  return db.query<ContextStatRow, [number, number]>(`
    WITH ordered AS (
      SELECT
        bm.session_id,
        bm.cwd,
        CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER) AS inp,
        ROW_NUMBER() OVER (PARTITION BY bm.session_id ORDER BY bm.timestamp) AS rn,
        COUNT(*) OVER (PARTITION BY bm.session_id) AS turn_total
      FROM assistant_messages am
      JOIN base_messages bm ON am.uuid = bm.uuid
      WHERE bm.timestamp > ? AND json_valid(am.message) = 1
    )
    SELECT
      session_id AS sessionId,
      MAX(cwd) AS cwd,
      COUNT(*) AS turnCount,
      AVG(CASE WHEN rn <= 3 THEN CAST(inp AS REAL) END) AS avgEarlyInput,
      AVG(CASE WHEN rn > turn_total - 3 THEN CAST(inp AS REAL) END) AS avgLateInput,
      (AVG(CASE WHEN rn > turn_total - 3 THEN CAST(inp AS REAL) END) /
       NULLIF(AVG(CASE WHEN rn <= 3 THEN CAST(inp AS REAL) END), 0)) AS bloatRatio
    FROM ordered
    GROUP BY session_id
    HAVING COUNT(*) >= 6
    ORDER BY bloatRatio DESC NULLS LAST
    LIMIT ?
  `).all(since, limit);
}

// ─── Cache Stats ──────────────────────────────────────────────────────────────

export function queryCacheStats(db: Database, since: number, limit: number): CacheStatRow[] {
  const rows = db.query<{
    cwd: string; sessions: number; turns: number;
    totalInputTokens: number; totalCacheReadTokens: number; totalCacheWriteTokens: number;
    topModel: string | null;
  }, [number]>(`
    WITH raw AS (
      SELECT
        bm.cwd,
        bm.session_id,
        am.model,
        CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER) AS inp,
        CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER) AS cacheRead,
        CAST(json_extract(am.message, '$.usage.cache_creation_input_tokens') AS INTEGER) AS cacheWrite
      FROM assistant_messages am
      JOIN base_messages bm ON am.uuid = bm.uuid
      WHERE bm.timestamp > ? AND json_valid(am.message) = 1 AND bm.cwd IS NOT NULL
    ),
    top_model AS (
      SELECT cwd, model,
        ROW_NUMBER() OVER (PARTITION BY cwd ORDER BY COUNT(*) DESC) AS rk
      FROM raw WHERE model IS NOT NULL
      GROUP BY cwd, model
    )
    SELECT
      r.cwd,
      COUNT(DISTINCT r.session_id) AS sessions,
      COUNT(*) AS turns,
      SUM(r.inp) AS totalInputTokens,
      SUM(r.cacheRead) AS totalCacheReadTokens,
      SUM(r.cacheWrite) AS totalCacheWriteTokens,
      -- topModel is the most-used model per project; savings are approximated using it
      -- (the JSONL reader computes savings per-turn per-model for higher accuracy)
      tm.model AS topModel
    FROM raw r
    LEFT JOIN top_model tm ON tm.cwd = r.cwd AND tm.rk = 1
    GROUP BY r.cwd
    ORDER BY totalCacheReadTokens DESC
  `).all(since);

  const { computeCacheSavings } = require("./pricing") as typeof import("./pricing");
  return rows.map((r) => ({
    cwd: r.cwd,
    sessions: r.sessions,
    turns: r.turns,
    totalInputTokens: r.totalInputTokens,
    totalCacheReadTokens: r.totalCacheReadTokens,
    totalCacheWriteTokens: r.totalCacheWriteTokens,
    cacheHitPct: r.totalInputTokens + r.totalCacheReadTokens > 0
      ? (r.totalCacheReadTokens / (r.totalInputTokens + r.totalCacheReadTokens)) * 100 : null,
    estimatedSavingsUsd: r.topModel ? computeCacheSavings(r.topModel, r.totalCacheReadTokens) : null,
  }))
  .sort((a, b) => (b.estimatedSavingsUsd ?? 0) - (a.estimatedSavingsUsd ?? 0))
  .slice(0, limit);
}

// ─── SQLite Reader Adapter ────────────────────────────────────────────────────

interface SqliteReaderInterface {
  querySummaryTotals(since: number): SummaryTotals;
  queryRawTurnsForTool(since: number): RawTurnForTool[];
  queryByTool(since: number, limit: number): ToolRow[];
  queryByProject(since: number, limit: number): ProjectRow[];
  queryWeeklyTrend(since: number): WeekRow[];
  querySessions(since: number, limit: number): SessionRow[];
  querySessionTurns(sessionId: string): TurnRow[];
  queryThinkingTurns(since: number): ThinkingTurnRow[];
  queryBashTurns(since: number): BashCommandRow[];
  queryProjectMatches(fragment: string): ProjectMatch[];
  queryContextStats(since: number, limit: number): ContextStatRow[];
  queryCacheStats(since: number, limit: number): CacheStatRow[];
  close(): void;
}

export function createSqliteReader(db: Database): SqliteReaderInterface {
  return {
    querySummaryTotals: (since) => querySummaryTotals(db, since),
    queryRawTurnsForTool: (since) => queryRawTurnsForTool(db, since),
    queryByTool: (since, limit) => queryByTool(db, since, limit),
    queryByProject: (since, limit) => queryByProject(db, since, limit),
    queryWeeklyTrend: (since) => queryWeeklyTrend(db, since),
    querySessions: (since, limit) => querySessions(db, since, limit),
    querySessionTurns: (sessionId) => querySessionTurns(db, sessionId),
    queryThinkingTurns: (since) => queryThinkingTurns(db, since),
    queryBashTurns: (since) => queryBashTurns(db, since),
    queryProjectMatches: (fragment) => queryProjectMatches(db, fragment),
    queryContextStats: (since, limit) => queryContextStats(db, since, limit),
    queryCacheStats: (since, limit) => queryCacheStats(db, since, limit),
    close: () => db.close(),
  };
}
