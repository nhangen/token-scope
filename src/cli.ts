#!/usr/bin/env bun
import { parseSince } from "@/db";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";

const VERSION = "1.0.0";

const HELP = `
token-scope — Claude Code output token analytics

USAGE
  token-scope [flags]

REPORT MODES (mutually exclusive)
  (default)               Summary: totals, by-tool, by-project, weekly trend
  --tool <name>           Drill into a specific tool (bash, read, edit, agent, ...)
  --project <fragment>    Filter to sessions whose cwd contains <fragment>
  --session <id>          Turn-by-turn breakdown of one session (min 6-char prefix)
  --thinking              Thinking token analysis
  --sessions              List recent sessions with stats
  --context               Context bloat analysis (sessions with 6+ turns)
  --cache                 Cache efficiency by project
  --efficiency            Session efficiency (per-turn cost by session length)
  --tools                 Tooling analysis by layer (plugin, MCP, skill, meta, built-in)
  --contributors          Context contributors: which tools add most to context window
  --base-load             Base load analysis (system prompt tax per project)

SHARED FLAGS
  --source <jsonl|sqlite> Data source (default: auto-detect)
  --since <duration>      Time window: Nh hours, Nd days, Nw weeks (default: 30d)
  --limit <n>             Cap rows in tables (default: 20)
  --json                  Machine-readable JSON output
  --db <path>             Override SQLite database path (overrides TOKEN_SCOPE_DB)
  --projects-dir <path>   JSONL projects dir; repeat or colon-separate for multiple
  --version               Print version and exit
  --help                  Show this help

ENVIRONMENT
  TOKEN_SCOPE_DB           Override SQLite database path
  TOKEN_SCOPE_PROJECTS_DIR Colon-separated JSONL project dirs (auto-detects if unset)
  TOKEN_SCOPE_PRICING_FILE Override pricing constants JSON file
  NO_COLOR                 Disable ANSI color output

EXAMPLES
  token-scope
  token-scope --tool bash --since 7d
  token-scope --project wp-content
  token-scope --session abc123def --json
  token-scope --thinking --since 90d
  token-scope --sessions --limit 50
  token-scope --source sqlite
  token-scope --projects-dir ~/.claude/projects --projects-dir ~/Library/Application\\ Support/Claude/projects
`.trim();

interface CliArgs {
  mode: "summary" | "tool" | "project" | "session" | "thinking" | "sessions" | "context" | "cache" | "efficiency" | "tools" | "contributors" | "base-load";
  toolName?: string;
  projectFragment?: string;
  sessionId?: string;
  since: string;
  limit: number;
  json: boolean;
  dbPath?: string;
  source?: "jsonl" | "sqlite" | "auto";
  projectsDirs: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "summary", since: "30d", limit: 20, json: false, projectsDirs: [] };
  let modeSet = false;

  const setMode = (mode: CliArgs["mode"]) => {
    if (modeSet) {
      process.stderr.write("Error: --tool, --project, --session, --thinking, --sessions, --context, --cache, --efficiency, --tools, --contributors, and --base-load are mutually exclusive.\n");
      process.exit(1);
    }
    args.mode = mode;
    modeSet = true;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--help": case "-h": console.log(HELP); process.exit(0); break;
      case "--version": case "-v": console.log(`token-scope ${VERSION}`); process.exit(0); break;
      case "--json": args.json = true; break;
      case "--thinking": setMode("thinking"); break;
      case "--sessions": setMode("sessions"); break;
      case "--context": setMode("context"); break;
      case "--cache": setMode("cache"); break;
      case "--efficiency": setMode("efficiency"); break;
      case "--tools": setMode("tools"); break;
      case "--contributors": setMode("contributors"); break;
      case "--base-load": setMode("base-load"); break;
      case "--tool":
        setMode("tool");
        args.toolName = argv[++i];
        if (!args.toolName) { process.stderr.write("Error: --tool requires a name argument.\n"); process.exit(1); }
        break;
      case "--project":
        setMode("project");
        args.projectFragment = argv[++i];
        if (!args.projectFragment) { process.stderr.write("Error: --project requires a fragment argument.\n"); process.exit(1); }
        break;
      case "--session":
        setMode("session");
        args.sessionId = argv[++i];
        if (!args.sessionId) { process.stderr.write("Error: --session requires a session ID argument.\n"); process.exit(1); }
        if (args.sessionId.length < 6) { process.stderr.write("Error: --session ID must be at least 6 characters.\n"); process.exit(1); }
        break;
      case "--since":
        args.since = argv[++i] ?? "30d";
        if (!/^\d+(h|d|w)$/.test(args.since)) {
          process.stderr.write(`Error: Invalid --since format "${args.since}". Use Nh, Nd, or Nw.\n`);
          process.exit(1);
        }
        break;
      case "--limit": {
        const val = argv[++i];
        const n = parseInt(val ?? "", 10);
        if (isNaN(n) || n < 1) { process.stderr.write("Error: --limit must be a positive integer.\n"); process.exit(1); }
        args.limit = n;
        break;
      }
      case "--db":
        args.dbPath = argv[++i];
        if (!args.dbPath) { process.stderr.write("Error: --db requires a path argument.\n"); process.exit(1); }
        break;
      case "--projects-dir": {
        const d = argv[++i];
        if (!d) { process.stderr.write("Error: --projects-dir requires a path argument.\n"); process.exit(1); }
        args.projectsDirs.push(...d.split(":").filter(Boolean));
        break;
      }
      case "--source": {
        const s = argv[++i];
        if (s !== "jsonl" && s !== "sqlite" && s !== "auto") {
          process.stderr.write(`Error: --source must be jsonl, sqlite, or auto.\n`);
          process.exit(1);
        }
        args.source = s;
        break;
      }
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`Error: Unknown flag "${arg}". Run token-scope --help for usage.\n`);
          process.exit(1);
        }
    }
  }

  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const reader = createReader({
    source: args.source ?? "auto",
    dbPath: args.dbPath,
    projectsDirs: args.projectsDirs.length > 0 ? args.projectsDirs : undefined,
  });

  let since: number;
  try {
    since = parseSince(args.since);
  } catch (e) {
    process.stderr.write(`${String(e)}\n`);
    process.exit(1);
  }

  if (args.mode === "session") {
    const { renderSessionView } = await import("@/reports/session");
    await renderSessionView(reader, args.sessionId!, args.json, args.since);
    reader.close();
    return;
  }

  const options = { since, sinceStr: args.since, limit: args.limit, json: args.json };

  switch (args.mode) {
    case "summary": {
      const { renderSummary } = await import("@/reports/summary");
      renderSummary(reader, options); break;
    }
    case "tool": {
      const { renderToolDrillDown } = await import("@/reports/tool");
      renderToolDrillDown(reader, args.toolName!, options); break;
    }
    case "project": {
      const { renderProjectDrillDown } = await import("@/reports/project");
      renderProjectDrillDown(reader, args.projectFragment!, options); break;
    }
    case "sessions": {
      const { renderSessionsList } = await import("@/reports/session");
      renderSessionsList(reader, options); break;
    }
    case "thinking": {
      const { renderThinkingReport } = await import("@/reports/thinking");
      renderThinkingReport(reader, options); break;
    }
    case "context": {
      const { renderContextReport } = await import("@/reports/context");
      renderContextReport(reader, options); break;
    }
    case "cache": {
      const { renderCacheReport } = await import("@/reports/cache");
      renderCacheReport(reader, options); break;
    }
    case "efficiency": {
      const { renderEfficiencyReport } = await import("@/reports/efficiency");
      renderEfficiencyReport(reader, options); break;
    }
    case "tools": {
      const { renderToolingReport } = await import("@/reports/tools");
      renderToolingReport(reader, options); break;
    }
    case "contributors": {
      const { renderContributorsReport } = await import("@/reports/context-contributors");
      renderContributorsReport(reader, options); break;
    }
    case "base-load": {
      const { renderBaseLoadReport } = await import("@/reports/base-load");
      renderBaseLoadReport(reader, options); break;
    }
  }

  reader.close();
}

main().catch((e) => {
  process.stderr.write(`Unexpected error: ${String(e)}\n`);
  process.exit(1);
});
