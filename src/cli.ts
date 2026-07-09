#!/usr/bin/env bun
import { parseSince } from "@/db";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import type { ArtifactFormat } from "@/artifacts";
import { KNOWN_ARTIFACT_FORMATS } from "@/artifacts";
import { VERSION } from "@/version";

const ARTIFACT_FORMAT_SET = new Set<string>(KNOWN_ARTIFACT_FORMATS);
const ARTIFACT_MODES = new Set(["artifacts", "artifact-show", "artifact-compare"]);

const HELP = `
token-scope — Claude Code output token analytics

USAGE
  token-scope [flags]

REPORT MODES (mutually exclusive)
  (default)               Summary: totals, by-tool, by-project, weekly trend
  --tool <name>           Drill into a specific tool (bash, read, edit, agent, ...)
  --project <fragment>    Filter to sessions whose cwd contains <fragment>
  --session <id>          Turn-by-turn breakdown of one session (min 6-char prefix)
  --spend                 Per-turn + per-range Claude (billed) token spend for one
                          session; rolls up subagent (Task/Agent) overhead
  --savings               Estimated ollama delegation savings: reads the
                          ollama-agent ledger, values its token volume at Claude
                          prices, subtracts actual PM overhead, headlines the net
  --thinking              Thinking token analysis
  --sessions              List recent sessions with stats
  --context               Context bloat analysis (sessions with 6+ turns)
  --cache                 Cache efficiency by project
  --efficiency            Session efficiency (per-turn cost by session length)
  --tools                 Tooling analysis by layer (plugin, MCP, skill, meta, built-in)
  --contributors          Context contributors: which tools add most to context window
  --base-load             Base load analysis (system prompt tax per project)
  --cache-growth <id>    Turn-by-turn cache growth waterfall for one session
  --budget               Session budget analysis (optimal session length)
  --context-loop          Savings + ROI analytics for the context-loop plugin
  --tuning                (with --context-loop) threshold curve, acted/ignored, time-to-action
  --reclamation           (with --context-loop) per-cwd ROI, what got reclaimed, no-fire baseline
  --patterns              (with --context-loop) n-th-fire returns, quality proxy, terminal-state, subagent
  --artifacts             Per-file Write/Edit cost: which artifacts cost the most to produce
  --artifact-format <ext> (with --artifacts) filter to one format: md, html, ts, py, ...
  --artifact-path <frag>  (with --artifacts) filter paths containing fragment
  --artifact-show <path>  Per-edit lifecycle for one artifact (full path, not fragment)
  --artifact-compare <md> MD vs sibling HTML cost (looks for &lt;dir&gt;/artifacts/&lt;slug&gt;.html)

SPEND FLAGS (with --spend)
  --turns <N..M>          Isolate a task: 1-indexed inclusive turn slice within the
                          session (N, N.., ..M, or N..M). --session picks the session
                          (default: most recent); --since acts as a turn timestamp floor.

SAVINGS FLAGS (with --savings)
  --ledger <path>         Ledger file to read (default: OLLAMA_AGENT_LEDGER env, else
                          $XDG_STATE_HOME/ollama-agent/runs.jsonl).
  --counterfactual-model <id>  Claude model to price the counterfactual against
                          (default: claude-opus-4-8). --session scopes to one
                          delegation session; --since floors by ledger timestamp.

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
  mode: "summary" | "tool" | "project" | "session" | "thinking" | "sessions" | "context" | "cache" | "efficiency" | "tools" | "contributors" | "base-load" | "cache-growth" | "budget" | "context-loop" | "artifacts" | "artifact-show" | "artifact-compare" | "spend" | "savings";
  toolName?: string;
  projectFragment?: string;
  sessionId?: string;
  since: string;
  limit: number;
  json: boolean;
  dbPath?: string;
  source?: "jsonl" | "sqlite" | "auto";
  projectsDirs: string[];
  contextLoopSections: Array<"tuning" | "reclamation" | "patterns" | "roi" | "all">;
  artifactFormat?: ArtifactFormat;
  artifactPathFragment?: string;
  artifactPath?: string;
  turnRange?: { from?: number; to?: number };
  ledgerPath?: string;
  counterfactualModel?: string;
}

/** Parses a --turns value: "N", "N..M", "N..", "..M" (1-indexed, inclusive). */
export function parseTurnRange(raw: string): { from?: number; to?: number } {
  const single = /^(\d+)$/.exec(raw);
  if (single) {
    const n = parseInt(single[1]!, 10);
    if (n < 1) throw new Error(`--turns value must be >= 1 (got "${raw}").`);
    return { from: n, to: n };
  }
  const range = /^(\d*)\.\.(\d*)$/.exec(raw);
  if (!range) throw new Error(`Invalid --turns "${raw}". Use N, N.., ..M, or N..M.`);
  const [, g1, g2] = range;
  if (g1 === "" && g2 === "") throw new Error(`--turns needs at least one bound (got "${raw}").`);
  const from = g1 === "" ? undefined : parseInt(g1!, 10);
  const to = g2 === "" ? undefined : parseInt(g2!, 10);
  if (from !== undefined && from < 1) throw new Error(`--turns start must be >= 1 (got "${raw}").`);
  if (to !== undefined && to < 1) throw new Error(`--turns end must be >= 1 (got "${raw}").`);
  if (from !== undefined && to !== undefined && from > to) throw new Error(`--turns start must be <= end (got "${raw}").`);
  return { from, to };
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "summary", since: "30d", limit: 20, json: false, projectsDirs: [], contextLoopSections: [] };
  let modeSet = false;

  const setMode = (mode: CliArgs["mode"]) => {
    if (modeSet) {
      process.stderr.write("Error: --tool, --project, --session, --thinking, --sessions, --context, --cache, --efficiency, --tools, --contributors, --base-load, --cache-growth, and --budget are mutually exclusive.\n");
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
      case "--spend":
        // --session is normally its own mode; --spend consumes it as a scoping
        // arg instead, so allow the combo regardless of flag order.
        if (modeSet && args.mode === "session") args.mode = "spend";
        else setMode("spend");
        break;
      case "--savings":
        // Like --spend, --savings consumes --session as a scoping arg rather
        // than letting it claim its own mode, regardless of flag order.
        if (modeSet && args.mode === "session") args.mode = "savings";
        else setMode("savings");
        break;
      case "--ledger": {
        const v = argv[++i];
        if (!v) { process.stderr.write("Error: --ledger requires a path argument.\n"); process.exit(1); }
        args.ledgerPath = v;
        break;
      }
      case "--counterfactual-model": {
        const v = argv[++i];
        if (!v) { process.stderr.write("Error: --counterfactual-model requires a model id.\n"); process.exit(1); }
        args.counterfactualModel = v;
        break;
      }
      case "--turns": {
        const v = argv[++i];
        if (!v) { process.stderr.write("Error: --turns requires a value (N, N.., ..M, or N..M).\n"); process.exit(1); }
        try { args.turnRange = parseTurnRange(v); }
        catch (e) { process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); }
        break;
      }
      case "--sessions": setMode("sessions"); break;
      case "--context": setMode("context"); break;
      case "--cache": setMode("cache"); break;
      case "--efficiency": setMode("efficiency"); break;
      case "--tools": setMode("tools"); break;
      case "--contributors": setMode("contributors"); break;
      case "--base-load": setMode("base-load"); break;
      case "--budget": setMode("budget"); break;
      case "--context-loop": setMode("context-loop"); break;
      case "--artifacts": setMode("artifacts"); break;
      case "--artifact-format": {
        const v = argv[++i];
        if (!v) { process.stderr.write("Error: --artifact-format requires a value (e.g. md, html, ts).\n"); process.exit(1); }
        if (!ARTIFACT_FORMAT_SET.has(v)) {
          process.stderr.write(`Error: --artifact-format must be one of: ${KNOWN_ARTIFACT_FORMATS.join(", ")}.\n`);
          process.exit(1);
        }
        args.artifactFormat = v as ArtifactFormat;
        if (!modeSet) setMode("artifacts");
        break;
      }
      case "--artifact-path": {
        const v = argv[++i];
        if (!v) { process.stderr.write("Error: --artifact-path requires a fragment.\n"); process.exit(1); }
        args.artifactPathFragment = v;
        if (!modeSet) setMode("artifacts");
        break;
      }
      case "--artifact-show": {
        setMode("artifact-show");
        args.artifactPath = argv[++i];
        if (!args.artifactPath) { process.stderr.write("Error: --artifact-show requires a file path.\n"); process.exit(1); }
        break;
      }
      case "--artifact-compare": {
        setMode("artifact-compare");
        args.artifactPath = argv[++i];
        if (!args.artifactPath) { process.stderr.write("Error: --artifact-compare requires an .md file path.\n"); process.exit(1); }
        break;
      }
      case "--tuning":
      case "--reclamation":
      case "--patterns":
      case "--roi": {
        if (args.mode !== "context-loop") setMode("context-loop");
        const section = arg.slice(2) as "tuning" | "reclamation" | "patterns" | "roi";
        if (!args.contextLoopSections.includes(section)) args.contextLoopSections.push(section);
        break;
      }
      case "--cache-growth":
        setMode("cache-growth");
        args.sessionId = argv[++i];
        if (!args.sessionId) { process.stderr.write("Error: --cache-growth requires a session ID argument.\n"); process.exit(1); }
        if (args.sessionId.length < 6) { process.stderr.write("Error: --cache-growth ID must be at least 6 characters.\n"); process.exit(1); }
        break;
      case "--tool":
        setMode("tool");
        args.toolName = argv[++i];
        if (!args.toolName) { process.stderr.write("Error: --tool requires a name argument.\n"); process.exit(1); }
        break;
      case "--project": {
        const frag = argv[++i];
        if (!frag) { process.stderr.write("Error: --project requires a fragment argument.\n"); process.exit(1); }
        if (modeSet && args.mode === "contributors") {
          args.projectFragment = frag;
        } else {
          setMode("project");
          args.projectFragment = frag;
        }
        break;
      }
      case "--session": {
        const id = argv[++i];
        if (!id) { process.stderr.write("Error: --session requires a session ID argument.\n"); process.exit(1); }
        if (id!.length < 6) { process.stderr.write("Error: --session ID must be at least 6 characters.\n"); process.exit(1); }
        // When --spend/--savings is the active mode, --session scopes it rather
        // than claiming its own (mutually-exclusive) mode.
        if (modeSet && (args.mode === "spend" || args.mode === "savings")) args.sessionId = id;
        else { setMode("session"); args.sessionId = id; }
        break;
      }
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

  if ((args.artifactFormat || args.artifactPathFragment) && !ARTIFACT_MODES.has(args.mode)) {
    process.stderr.write("Error: --artifact-format/--artifact-path are only valid with --artifacts, --artifact-show, or --artifact-compare.\n");
    process.exit(1);
  }

  if (args.turnRange && args.mode !== "spend") {
    process.stderr.write("Error: --turns is only valid with --spend.\n");
    process.exit(1);
  }

  if ((args.ledgerPath || args.counterfactualModel) && args.mode !== "savings") {
    process.stderr.write("Error: --ledger/--counterfactual-model are only valid with --savings.\n");
    process.exit(1);
  }

  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  let since: number;
  try {
    since = parseSince(args.since);
  } catch (e) {
    process.stderr.write(`${String(e)}\n`);
    process.exit(1);
  }

  // Session-scoped modes pick a specific session_id; the mtime prefilter
  // would drop the target file if its mtime predates --since, silently
  // returning empty. Skip the prefilter for those modes.
  const sessionScopedModes = new Set(["session", "cache-growth"]);
  // --spend with an explicit --session targets one file whose mtime may predate
  // --since; skip the prefilter so it isn't silently dropped (as for --session).
  // --savings resolves sessions from the ledger (any age), so it also skips the
  // prefilter to keep PM-overhead attribution working for older sessions.
  const prefilterSince = (sessionScopedModes.has(args.mode) || (args.mode === "spend" && args.sessionId) || args.mode === "savings")
    ? undefined : since;

  const reader = createReader({
    source: args.source ?? "auto",
    dbPath: args.dbPath,
    projectsDirs: args.projectsDirs.length > 0 ? args.projectsDirs : undefined,
    since: prefilterSince,
  });

  if (args.mode === "session") {
    const { renderSessionView } = await import("@/reports/session");
    await renderSessionView(reader, args.sessionId!, args.json, args.since);
    reader.close();
    return;
  }

  if (args.mode === "cache-growth") {
    const { renderCacheGrowthReport } = await import("@/reports/cache-growth");
    renderCacheGrowthReport(reader, args.sessionId!, args.json, args.since);
    reader.close();
    return;
  }

  if (args.mode === "spend") {
    const { renderSpendReport } = await import("@/reports/spend");
    renderSpendReport(reader, {
      sessionId: args.sessionId, turnRange: args.turnRange,
      since, sinceStr: args.since, json: args.json,
    });
    reader.close();
    return;
  }

  if (args.mode === "savings") {
    const { renderSavingsReport, DEFAULT_COUNTERFACTUAL_MODEL } = await import("@/reports/savings");
    renderSavingsReport(reader, {
      sessionId: args.sessionId, since, sinceStr: args.since, json: args.json,
      ledgerPath: args.ledgerPath,
      counterfactualModel: args.counterfactualModel ?? DEFAULT_COUNTERFACTUAL_MODEL,
    });
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
      renderContributorsReport(reader, options, args.projectFragment); break;
    }
    case "base-load": {
      const { renderBaseLoadReport } = await import("@/reports/base-load");
      renderBaseLoadReport(reader, options); break;
    }
    case "budget": {
      const { renderSessionBudgetReport } = await import("@/reports/session-budget");
      renderSessionBudgetReport(reader, options); break;
    }
    case "context-loop": {
      const { renderContextLoopReport } = await import("@/reports/context-loop");
      const sections = args.contextLoopSections.length > 0 && !args.contextLoopSections.includes("all")
        ? args.contextLoopSections.filter((s) => s !== "roi")
        : ["all" as const];
      renderContextLoopReport({ ...options, sections: sections as Array<"tuning" | "reclamation" | "patterns" | "roi" | "all"> });
      break;
    }
    case "artifacts": {
      const { renderArtifactsReport } = await import("@/reports/artifacts");
      renderArtifactsReport(reader, {
        ...options,
        format: args.artifactFormat,
        pathFragment: args.artifactPathFragment,
      });
      break;
    }
    case "artifact-show": {
      const { renderArtifactShowReport } = await import("@/reports/artifacts");
      renderArtifactShowReport(reader, args.artifactPath!, options);
      break;
    }
    case "artifact-compare": {
      const { renderArtifactCompareReport } = await import("@/reports/artifacts");
      renderArtifactCompareReport(reader, args.artifactPath!, options);
      break;
    }
  }

  reader.close();
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`Unexpected error: ${String(e)}\n`);
    process.exit(1);
  });
}
