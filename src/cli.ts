import { resolveDbPath, openDb, parseSince } from "@/db";

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

SHARED FLAGS
  --since <duration>      Time window: Nh hours, Nd days, Nw weeks (default: 30d)
  --limit <n>             Cap rows in tables (default: 20)
  --json                  Machine-readable JSON output
  --db <path>             Override database path (overrides TOKEN_SCOPE_DB)
  --version               Print version and exit
  --help                  Show this help

ENVIRONMENT
  TOKEN_SCOPE_DB           Override database path
  TOKEN_SCOPE_PRICING_FILE Override pricing constants JSON file
  NO_COLOR                 Disable ANSI color output

EXAMPLES
  token-scope
  token-scope --tool bash --since 7d
  token-scope --project wp-content
  token-scope --session abc123def --json
  token-scope --thinking --since 90d
  token-scope --sessions --limit 50
`.trim();

interface CliArgs {
  mode: "summary" | "tool" | "project" | "session" | "thinking" | "sessions";
  toolName?: string;
  projectFragment?: string;
  sessionId?: string;
  since: string;
  limit: number;
  json: boolean;
  dbPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "summary", since: "30d", limit: 20, json: false };
  let modeSet = false;

  const setMode = (mode: CliArgs["mode"]) => {
    if (modeSet) {
      process.stderr.write("Error: --tool, --project, --session, --thinking, and --sessions are mutually exclusive.\n");
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
  const { path: dbPath } = resolveDbPath(args.dbPath);
  const db = openDb(dbPath);

  let since: number;
  try {
    since = parseSince(args.since);
  } catch (e) {
    process.stderr.write(`${String(e)}\n`);
    process.exit(1);
  }

  if (args.mode === "session") {
    // @ts-ignore (reports/session not yet created)
    const { renderSessionView } = await import("@/reports/session");
    await renderSessionView(db, args.sessionId!, args.json, args.since);
    db.close();
    return;
  }

  const options = { since, limit: args.limit, json: args.json };

  switch (args.mode) {
    case "summary": {
      // @ts-ignore (reports/summary not yet created)
      const { renderSummary } = await import("@/reports/summary");
      renderSummary(db, options); break;
    }
    case "tool": {
      // @ts-ignore (reports/tool not yet created)
      const { renderToolDrillDown } = await import("@/reports/tool");
      renderToolDrillDown(db, args.toolName!, options); break;
    }
    case "project": {
      // @ts-ignore (reports/project not yet created)
      const { renderProjectDrillDown } = await import("@/reports/project");
      renderProjectDrillDown(db, args.projectFragment!, options); break;
    }
    case "sessions": {
      // @ts-ignore (reports/session not yet created)
      const { renderSessionsList } = await import("@/reports/session");
      renderSessionsList(db, options); break;
    }
    case "thinking": {
      // @ts-ignore (reports/thinking not yet created)
      const { renderThinkingReport } = await import("@/reports/thinking");
      renderThinkingReport(db, options); break;
    }
  }

  db.close();
}

main().catch((e) => {
  process.stderr.write(`Unexpected error: ${String(e)}\n`);
  process.exit(1);
});
