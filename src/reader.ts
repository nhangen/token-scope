import type {
  SummaryTotals, ToolRow, ProjectRow, SessionRow, TurnRow, WeekRow,
  ThinkingTurnRow, BashCommandRow, ProjectMatch, RawTurnForTool,
  ContextStatRow, CacheStatRow,
} from "@/db";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

export type { SummaryTotals, ToolRow, ProjectRow, SessionRow, TurnRow, WeekRow, ThinkingTurnRow, BashCommandRow, ProjectMatch, RawTurnForTool, ContextStatRow, CacheStatRow };

export interface Reader {
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

export interface ReaderOptions {
  source?: "jsonl" | "sqlite" | "auto";
  dbPath?: string;
  projectsDirs?: string[];
}

function resolveProjectsDirs(override?: string[]): string[] {
  if (override && override.length > 0) return override;
  const env = process.env["TOKEN_SCOPE_PROJECTS_DIR"];
  if (env) return env.split(":").filter(Boolean);
  const home = process.env["HOME"] ?? "~";
  const candidates = [
    join(home, ".claude", "projects"),
    join(home, "Library", "Application Support", "Claude", "projects"),
  ];
  return candidates.filter(existsSync);
}

function hasJsonlData(dirs: string[]): boolean {
  return dirs.some((dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory());
    } catch {
      return false;
    }
  });
}

export function createReader(opts: ReaderOptions = {}): Reader {
  const source = opts.source ?? "auto";
  const projectsDirs = resolveProjectsDirs(opts.projectsDirs);

  const useJsonl = source === "jsonl" || (source === "auto" && hasJsonlData(projectsDirs));

  if (useJsonl) {
    const { JsonlReader } = require("./jsonl") as typeof import("./jsonl");
    return new JsonlReader(projectsDirs);
  }

  // @ts-ignore - createSqliteReader will be added in a subsequent task
  const { resolveDbPath, openDb, createSqliteReader } = require("./db") as typeof import("./db");
  const { path } = resolveDbPath(opts.dbPath);
  const db = openDb(path);
  return createSqliteReader(db);
}
