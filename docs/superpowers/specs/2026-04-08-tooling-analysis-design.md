# Phase 3: Tooling Analysis Report

## Purpose

New `--tools` report that answers four questions about Claude Code's tooling ecosystem:
1. Are tools helping?
2. How much?
3. Should I tweak tools?
4. Are tools costing me?

Single sectioned report with summary, then one section per tooling layer.

## Architecture

**Approach B** — new analyzer module wrapping the Reader. Does NOT add methods to the Reader interface.

```
cli.ts --tools → reports/tools.ts → tools.ts (analyzer) → reader.queryRawTurnsForTool()
```

- `src/tools.ts` — classifier + analyzer: `classifyTool()`, `analyzeTooling()`
- `src/reports/tools.ts` — `renderToolingReport()` — sectioned terminal/JSON output

## Data Layer Changes

### Enrich `RawTurnForTool`

Add `sessionId` and `cwd` to the interface and both backend implementations:

```typescript
interface RawTurnForTool {
  uuid: string;
  sessionId: string;    // new
  cwd: string | null;   // new
  outputTokens: number;
  costUsd: number | null;
  message: string;
}
```

**SQLite** (`db.ts` line 216): add `bm.session_id AS sessionId, bm.cwd` to the SELECT.

**JSONL** (`jsonl.ts` line 117-123): include `sessionId: t.sessionId, cwd: t.cwd` in the mapped return.

### Fix `loadTurns` re-serialization

`loadTurns` currently does `messageJson: JSON.stringify(msg)` which re-serializes the parsed `message` sub-object. Instead, extract and store the raw message JSON without round-tripping:

```typescript
// Before (line 75)
messageJson: JSON.stringify(msg),

// After — keep the parsed message reference, stringify only once
messageJson: JSON.stringify(msg),  // KEEP as-is for now — the overhead is acceptable
                                    // and changing to raw substring extraction risks
                                    // breaking the boundary (parse.ts expects message JSON)
```

**Decision**: Defer this optimization. The re-serialization produces valid JSON that `parseContentBlocks` expects. Changing to raw line slicing is fragile and the memory savings don't justify the risk for a CLI tool.

### Fix `queryContextStats` cwd resolution

Standardize JSONL `queryContextStats` to use dominant-cwd (same as `querySessions`). SQLite version uses `MAX(cwd)` which is alphabetical — acceptable difference documented.

**Note on per-turn cwd for tools report**: The tooling analyzer uses per-turn `cwd` (not dominant-cwd), which is intentionally correct — you want to know what project a tool was invoked FROM, not what session it was aggregated under.

## Tool Classification

```typescript
type ToolLayer = "plugin" | "mcp" | "skill" | "meta" | "builtin";

interface ToolCall {
  name: string;          // full name from tool_use block
  layer: ToolLayer;
  server?: string;       // MCP/plugin: extracted server or plugin name
  shortName?: string;    // MCP/plugin: tool name without prefix
  inputSize: number;     // JSON.stringify(input).length for cost proportioning
}
```

### Classification rules (applied in order)

1. **Plugin** — name starts with `mcp__plugin_`. Plugin identifier is derived from the second `__`-delimited segment after removing the `plugin_` prefix: `mcp__plugin_serena_serena__find_symbol` → plugin `serena`, tool `find_symbol`
2. **MCP** — name starts with `mcp__` (not plugin). Server from second segment: `mcp__zenhub__getSprint` → server `zenhub`, tool `getSprint`. Includes `mcp__claude_ai_*` integrations.
3. **Skill** — name is exactly `Skill`. Skill name extracted from `input.skill` field if present.
4. **Meta** — name in: `TaskCreate, TaskUpdate, TaskList, TaskGet, TaskOutput, TaskStop, Task, TodoWrite, EnterPlanMode, ExitPlanMode, ToolSearch`
5. **Built-in** — everything else: Bash, Read, Edit, Write, Grep, Glob, Agent, MultiEdit, WebFetch, WebSearch, etc.

Rule 5 is a catch-all — `unclassified` is structurally empty by design. If a new tool category emerges that shouldn't be `builtin`, add a new rule.

Hooks (e.g. obsidian commit capture) are shell commands triggered by events, not tool_use blocks. They are invisible to this report. Noted in footer.

### Validated tool inventory (26 tools, 0 unclassified)

| Tool | Layer | Server/Plugin |
|---|---|---|
| `mcp__plugin_figma_figma__get_design_context` | plugin | figma |
| `mcp__plugin_figma_figma__get_metadata` | plugin | figma |
| `mcp__plugin_figma_figma__get_screenshot` | plugin | figma |
| `mcp__claude_ai_Figma__authenticate` | mcp | claude_ai_Figma |
| `mcp__zenhub__getSprint` | mcp | zenhub |
| `mcp__zenhub__getUpcomingSprint` | mcp | zenhub |
| `Skill` | skill | — |
| `TaskCreate` | meta | — |
| `TaskUpdate` | meta | — |
| `TaskList` | meta | — |
| `TaskOutput` | meta | — |
| `TaskStop` | meta | — |
| `Task` | meta | — |
| `TodoWrite` | meta | — |
| `EnterPlanMode` | meta | — |
| `ExitPlanMode` | meta | — |
| `ToolSearch` | meta | — |
| `Bash` | builtin | — |
| `Read` | builtin | — |
| `Edit` | builtin | — |
| `Write` | builtin | — |
| `Grep` | builtin | — |
| `Glob` | builtin | — |
| `Agent` | builtin | — |
| `MultiEdit` | builtin | — |
| `WebFetch` | builtin | — |
| `WebSearch` | builtin | — |

## Cost Attribution

For each turn, parse ALL `tool_use` blocks. Apportion the turn's `costUsd` proportionally by input payload size:

```
turn cost = $0.50
tool A input size = 800 chars (80%)
tool B input size = 200 chars (20%)

tool A attributed cost = $0.40
tool B attributed cost = $0.10
```

**Edge cases:**
- **No tool_use blocks** (text-only turn): full cost → `(no tool)` bucket. Guard runs BEFORE any division to prevent NaN.
- **costUsd is null** (unknown model): tool still counted by call volume, attributed cost is null.
- **tool_use with empty/missing input**: inputSize = 2 (empty object `{}`). Gets minimal share.
- **Single tool_use block**: gets 100% of turn cost. No division needed.

## Report Output

### Terminal mode (`--tools`)

```
token-scope — Tooling Analysis
────────────────────────────────────────────────────────────
  Total Tool Calls             4,716
  Distinct Tools               23
  Layers Active                4 of 5
  Unclassified Tools           0

  Cost by Layer
Layer     │ Calls  │ Attributed Cost │ Cost % │ Avg/Call
──────────┼────────┼─────────────────┼────────┼─────────
Built-in  │  3,890 │        $342.18  │  85.2% │  $0.088
MCP       │     61 │         $12.40  │   3.1% │  $0.203
Plugin    │     17 │          $4.80  │   1.2% │  $0.282
Skill     │     67 │          $3.42  │   0.9% │  $0.051
Meta      │    241 │          $5.26  │   1.3% │  $0.022
(no tool) │    440 │         $33.57  │   8.4% │  $0.076

  ── Built-in Tools ──────────────────────────────────
  <table: tool, calls, attributed cost, avg/call>

  ── MCP Servers ─────────────────────────────────────
  <table: server, tool, calls, attributed cost>

  ── Plugins ─────────────────────────────────────────
  <table: plugin, tool, calls, attributed cost>

  ── Skills ──────────────────────────────────────────
  <table: skill name, calls, attributed cost>

  ── Meta / Orchestration ────────────────────────────
  <table: tool, calls, attributed cost>

  * Hooks run as shell commands, not tool_use blocks — invisible here.
  * Cost attributed proportionally by input payload size per turn.
```

### JSON mode (`--tools --json`)

```json
{
  "meta": { "generated_at": "...", "since": 0, "limit": 20, "token_scope_version": "1.0.0" },
  "report": "tools",
  "summary": {
    "totalCalls": 4716,
    "distinctTools": 23,
    "activeLayers": 4,
    "unclassifiedCount": 0
  },
  "layers": [
    { "layer": "builtin", "calls": 3890, "attributedCost": 342.18, "costPct": 85.2, "avgCostPerCall": 0.088 }
  ],
  "byTool": [
    { "name": "Bash", "layer": "builtin", "server": null, "calls": 2495, "attributedCost": 210.30, "avgCostPerCall": 0.084 }
  ],
  "unclassified": []
}
```

## Files

| Action | File | What |
|---|---|---|
| Create | `src/tools.ts` | `classifyTool()`, `ToolCall`, `ToolAnalysis` types, `analyzeTooling(reader, since)` |
| Create | `src/reports/tools.ts` | `renderToolingReport(reader, opts)` |
| Create | `tests/tools.test.ts` | Classification, cost attribution, discovery validation |
| Modify | `src/db.ts` | Add `sessionId`, `cwd` to `RawTurnForTool` type and SQL SELECT |
| Modify | `src/jsonl.ts` | Add `sessionId`, `cwd` to `queryRawTurnsForTool` return. Fix `queryContextStats` dominant-cwd. |
| Modify | `src/reader.ts` | Re-export updated `RawTurnForTool` (automatic via type re-export) |
| Modify | `src/cli.ts` | Add `--tools` to `CliArgs.mode`, parseArgs switch, main dispatch |
| Modify | `README.md` | Add `--tools` section with sample output, update roadmap |
| Modify | `tests/reports.test.ts` | Tooling report smoke tests |
| Modify | `tests/fixtures/projects/*/sess-j1.jsonl` | Add MCP/plugin/skill/meta tool_use blocks to fixture |

No changes to `format.ts`, `parse.ts`, `pricing.ts`, or existing report files.

## Testing

1. **Classification unit tests** — verify each rule against all 26 known tools plus edge cases (empty name, unknown prefix)
2. **Cost proportioning tests** — 2-tool turn with known sizes, verify exact split. Zero-tool turn → `(no tool)`. Null cost → counts but no dollar attribution.
3. **Discovery validation** — scan fixture JSONL, assert zero unclassified. Runnable against live data: `token-scope --tools --json | jq '.unclassified'`
4. **Fixture expansion** — add representative tool_use blocks: MCP (`mcp__zenhub__getSprint`), plugin (`mcp__plugin_figma_figma__get_design_context`), skill (`Skill` with `input.skill`), meta (`TaskCreate`)
5. **Report smoke tests** — `renderToolingReport` doesn't throw, JSON has expected keys (`layers`, `byTool`, `unclassified`)

## Deferred

- Export to Markdown / Obsidian (Phase 5)
- loadTurns re-serialization optimization (acceptable overhead for CLI)
- SQLite dominant-cwd standardization (MAX(cwd) is documented difference)
