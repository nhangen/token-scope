import type {
  SummaryTotals, ToolRow, ProjectRow, SessionRow, TurnRow, WeekRow,
  ThinkingTurnRow, BashCommandRow, ProjectMatch, RawTurnForTool,
} from "@/db";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

export type { SummaryTotals, ToolRow, ProjectRow, SessionRow, TurnRow, WeekRow, ThinkingTurnRow, BashCommandRow, ProjectMatch, RawTurnForTool };

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
  close(): void;
}

export interface ReaderOptions {
  source?: "jsonl" | "sqlite" | "auto";
  dbPath?: string;
  projectsDir?: string;
}

function resolveProjectsDir(override?: string): string {
  if (override) return override;
  const env = process.env["TOKEN_SCOPE_PROJECTS_DIR"];
  if (env) return env;
  return join(process.env["HOME"] ?? "~", ".claude", "projects");
}

function hasJsonlData(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

export function createReader(opts: ReaderOptions = {}): Reader {
  const source = opts.source ?? "auto";
  const projectsDir = resolveProjectsDir(opts.projectsDir);

  const useJsonl = source === "jsonl" || (source === "auto" && hasJsonlData(projectsDir));

  if (useJsonl) {
    // @ts-ignore - JsonlReader will be added in a subsequent task
    const { JsonlReader } = require("./jsonl") as typeof import("./jsonl");
    // @ts-ignore
    return new JsonlReader(projectsDir);
  }

  // @ts-ignore - createSqliteReader will be added in a subsequent task
  const { resolveDbPath, openDb, createSqliteReader } = require("./db") as typeof import("./db");
  const { path } = resolveDbPath(opts.dbPath);
  const db = openDb(path);
  // @ts-ignore - createSqliteReader will be added in a subsequent task
  return createSqliteReader(db);
}
