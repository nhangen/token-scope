# Tooling Analysis Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--tools` report that classifies every tool call by layer (plugin, mcp, skill, meta, builtin), proportionally attributes cost, and renders a sectioned terminal/JSON report.

**Architecture:** New `src/tools.ts` analyzer wraps the Reader without extending its interface. Uses `reader.queryRawTurnsForTool()` (enriched with `sessionId` + `cwd`) to get raw turn data, parses all `tool_use` blocks, classifies each, and apportions cost by input payload size. `src/reports/tools.ts` renders the sectioned output.

**Tech Stack:** TypeScript, Bun, bun:test

---

### Task 1: Enrich `RawTurnForTool` with `sessionId` and `cwd`

**Files:**
- Modify: `src/db.ts:99-104` (interface) and `src/db.ts:216-223` (SQL query)
- Modify: `src/jsonl.ts:117-123` (JSONL return mapping)
- Modify: `tests/db.test.ts` (add assertion for new fields)
- Modify: `tests/jsonl.test.ts` (add assertion for new fields)

- [ ] **Step 1: Write failing test for SQLite `queryRawTurnsForTool` new fields**

In `tests/db.test.ts`, add inside the existing `describe("queryByTool")` block (or create a new describe):

```typescript
describe("queryRawTurnsForTool", () => {
  it("each row has sessionId and cwd fields", () => {
    const rows = queryRawTurnsForTool(db, 0);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveProperty("sessionId");
      expect(row).toHaveProperty("cwd");
      expect(typeof row.sessionId).toBe("string");
    }
  });
});
```

Also add `queryRawTurnsForTool` to the import on line 2 of `tests/db.test.ts`.

- [ ] **Step 2: Write failing test for JSONL `queryRawTurnsForTool` new fields**

In `tests/jsonl.test.ts`, add a new describe block:

```typescript
describe("JsonlReader — raw turns for tool", () => {
  it("each row has sessionId and cwd fields", () => {
    const rows = reader.queryRawTurnsForTool(0);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveProperty("sessionId");
      expect(row).toHaveProperty("cwd");
      expect(typeof row.sessionId).toBe("string");
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/db.test.ts tests/jsonl.test.ts`
Expected: FAIL — `sessionId` and `cwd` not present on returned rows.

- [ ] **Step 4: Update `RawTurnForTool` interface in `db.ts`**

In `src/db.ts`, replace lines 99-104:

```typescript
export interface RawTurnForTool {
  uuid: string;
  sessionId: string;
  cwd: string | null;
  outputTokens: number;
  costUsd: number | null;
  message: string;
}
```

- [ ] **Step 5: Update SQLite `queryRawTurnsForTool` query**

In `src/db.ts`, replace lines 216-223:

```typescript
export function queryRawTurnsForTool(db: Database, since: number): RawTurnForTool[] {
  return db.query<RawTurnForTool, [number]>(`
    SELECT am.uuid, bm.session_id AS sessionId, bm.cwd,
      CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER) AS outputTokens,
      am.cost_usd AS costUsd, am.message
    ${JOIN}
  `).all(since);
}
```

- [ ] **Step 6: Update JSONL `queryRawTurnsForTool`**

In `src/jsonl.ts`, replace lines 117-123:

```typescript
  queryRawTurnsForTool(since: number): RawTurnForTool[] {
    return this.filter(since).map((t) => ({
      uuid: t.uuid,
      sessionId: t.sessionId,
      cwd: t.cwd,
      outputTokens: t.outputTokens,
      costUsd: t.costUsd,
      message: t.messageJson,
    }));
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: All 103+ tests PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/db.ts src/jsonl.ts tests/db.test.ts tests/jsonl.test.ts
git commit -m "feat: add sessionId and cwd to RawTurnForTool"
```

---

### Task 2: Fix `queryContextStats` cwd resolution in JSONL reader

**Files:**
- Modify: `src/jsonl.ts:315-334` (queryContextStats)
- Modify: `tests/jsonl.test.ts` (add multi-cwd context stats test)

- [ ] **Step 1: Write failing test for dominant-cwd in context stats**

In `tests/jsonl.test.ts`, add to the existing `describe("JsonlReader — context stats")`:

```typescript
  it("uses dominant cwd when session spans multiple cwds", () => {
    const rows = reader.queryContextStats(0, 20);
    const sess4 = rows.find((r) => r.sessionId === "sess-j4");
    expect(sess4).toBeDefined();
    expect(sess4!.cwd).toBe("/Users/alice/projects/beacon");
  });
```

- [ ] **Step 2: Run test to verify it passes or fails**

Run: `bun test tests/jsonl.test.ts`

Note: sess-j4 fixture may already have a single cwd. If the test passes, it's a no-op. If it fails, the fix is needed. Either way, proceed with the code change for correctness.

- [ ] **Step 3: Implement dominant-cwd in `queryContextStats`**

In `src/jsonl.ts`, replace lines 315-334:

```typescript
  queryContextStats(since: number, limit: number): ContextStatRow[] {
    const turns = this.filter(since);
    const bySession = new Map<string, { cwdCounts: Map<string, number>; turns: JsonlTurn[] }>();
    for (const t of turns) {
      const e = bySession.get(t.sessionId) ?? { cwdCounts: new Map<string, number>(), turns: [] };
      e.cwdCounts.set(t.cwd, (e.cwdCounts.get(t.cwd) ?? 0) + 1);
      e.turns.push(t);
      bySession.set(t.sessionId, e);
    }
    const rows: ContextStatRow[] = [];
    for (const [sessionId, d] of bySession.entries()) {
      if (d.turns.length < 6) continue;
      const sorted = d.turns.slice().sort((a, b) => a.timestampMs - b.timestampMs);
      const early = sorted.slice(0, 3);
      const late = sorted.slice(-3);
      const avgEarlyInput = early.reduce((s, t) => s + t.inputTokens, 0) / 3;
      const avgLateInput = late.reduce((s, t) => s + t.inputTokens, 0) / 3;
      const bloatRatio = avgEarlyInput > 0 ? avgLateInput / avgEarlyInput : null;
      const cwd = [...d.cwdCounts.entries()].sort((a, b) => (b[1] as number) - (a[1] as number))[0]![0];
      rows.push({ sessionId, cwd, turnCount: d.turns.length, avgEarlyInput, avgLateInput, bloatRatio });
    }
    return rows.sort((a, b) => (b.bloatRatio ?? 0) - (a.bloatRatio ?? 0)).slice(0, limit);
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test && bun run typecheck`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jsonl.ts tests/jsonl.test.ts
git commit -m "fix: use dominant-cwd in queryContextStats for consistency"
```

---

### Task 3: Expand test fixtures with MCP/plugin/skill/meta tool_use blocks

**Files:**
- Modify: `tests/fixtures/projects/-Users-alice-projects-token-scope/sess-j1.jsonl`

- [ ] **Step 1: Add a turn with MCP tool call**

Append to `tests/fixtures/projects/-Users-alice-projects-token-scope/sess-j1.jsonl`:

```json
{"type":"assistant","uuid":"j1-t4","parentUuid":"j1-t3","sessionId":"sess-j1","cwd":"/Users/alice/projects/token-scope","timestamp":"2026-04-01T10:03:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j1t4","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu4","name":"mcp__zenhub__getSprint","input":{"sprintId":"123"}},{"type":"tool_use","id":"tu5","name":"Bash","input":{"command":"echo hello world from the terminal"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":150,"cache_read_input_tokens":50000,"cache_creation_input_tokens":100}}}
```

This turn has two tool calls (MCP + Bash) for testing proportional cost attribution.

- [ ] **Step 2: Add a turn with plugin tool call**

Append to the same file:

```json
{"type":"assistant","uuid":"j1-t5","parentUuid":"j1-t4","sessionId":"sess-j1","cwd":"/Users/alice/projects/token-scope","timestamp":"2026-04-01T10:04:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j1t5","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu6","name":"mcp__plugin_figma_figma__get_design_context","input":{"nodeId":"node-abc","depth":2}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":6,"output_tokens":250,"cache_read_input_tokens":52000,"cache_creation_input_tokens":0}}}
```

- [ ] **Step 3: Add a turn with Skill tool call**

Append to the same file:

```json
{"type":"assistant","uuid":"j1-t6","parentUuid":"j1-t5","sessionId":"sess-j1","cwd":"/Users/alice/projects/token-scope","timestamp":"2026-04-01T10:05:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j1t6","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu7","name":"Skill","input":{"skill":"brainstorming"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":100,"cache_read_input_tokens":55000,"cache_creation_input_tokens":0}}}
```

- [ ] **Step 4: Add a turn with meta tool call (TaskCreate)**

Append to the same file:

```json
{"type":"assistant","uuid":"j1-t7","parentUuid":"j1-t6","sessionId":"sess-j1","cwd":"/Users/alice/projects/token-scope","timestamp":"2026-04-01T10:06:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j1t7","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu8","name":"TaskCreate","input":{"subject":"Fix bug","description":"Fix the null pointer"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":2,"output_tokens":80,"cache_read_input_tokens":57000,"cache_creation_input_tokens":0}}}
```

- [ ] **Step 5: Update existing JSONL test assertions**

In `tests/jsonl.test.ts`, update counts that changed because sess-j1 now has 7 turns instead of 3:

- `querySummaryTotals` `turnCount`: 13 → 17
- `querySummaryTotals` `sessionCount`: 4 (unchanged — same session)
- `querySummaryTotals` `totalOutputTokens`: 2750 → 3330 (add 150+250+100+80)
- `querySessions` sess-j1 `turnCount`: 3 → 7
- `querySessionTurns` sess-j1 length: 3 → 7
- 30d window `turnCount`: 12 → 16, `sessionCount`: 3 (unchanged)
- `queryByProject` token-scope project `turns`: 3 → 7
- `queryBashTurns`: 1 → 2 (new multi-tool turn has a Bash block)

Update each assertion to match.

- [ ] **Step 6: Run tests**

Run: `bun test && bun run typecheck`
Expected: All tests PASS with updated counts.

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures tests/jsonl.test.ts
git commit -m "test: add MCP/plugin/skill/meta tool_use blocks to fixtures"
```

---

### Task 4: Create `src/tools.ts` — classifier and analyzer

**Files:**
- Create: `src/tools.ts`
- Create: `tests/tools.test.ts`

- [ ] **Step 1: Write classification unit tests**

Create `tests/tools.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { classifyTool, analyzeTooling } from "@/tools";
import type { ToolLayer } from "@/tools";

describe("classifyTool", () => {
  it("classifies plugin tools", () => {
    const result = classifyTool("mcp__plugin_figma_figma__get_design_context");
    expect(result.layer).toBe("plugin" as ToolLayer);
    expect(result.server).toBe("figma");
    expect(result.shortName).toBe("get_design_context");
  });

  it("classifies MCP tools", () => {
    const result = classifyTool("mcp__zenhub__getSprint");
    expect(result.layer).toBe("mcp" as ToolLayer);
    expect(result.server).toBe("zenhub");
    expect(result.shortName).toBe("getSprint");
  });

  it("classifies claude_ai MCP integrations as mcp", () => {
    const result = classifyTool("mcp__claude_ai_Figma__authenticate");
    expect(result.layer).toBe("mcp" as ToolLayer);
    expect(result.server).toBe("claude_ai_Figma");
    expect(result.shortName).toBe("authenticate");
  });

  it("classifies Skill tool", () => {
    const result = classifyTool("Skill");
    expect(result.layer).toBe("skill" as ToolLayer);
  });

  it("classifies meta tools", () => {
    for (const name of ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop", "Task", "TodoWrite", "EnterPlanMode", "ExitPlanMode", "ToolSearch"]) {
      expect(classifyTool(name).layer).toBe("meta" as ToolLayer);
    }
  });

  it("classifies built-in tools", () => {
    for (const name of ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Agent", "MultiEdit", "WebFetch", "WebSearch"]) {
      expect(classifyTool(name).layer).toBe("builtin" as ToolLayer);
    }
  });

  it("classifies unknown tools as builtin", () => {
    expect(classifyTool("SomeNewTool").layer).toBe("builtin" as ToolLayer);
  });
});

describe("cost proportioning", () => {
  it("splits cost proportionally by input size", () => {
    const turns = [{
      uuid: "t1", sessionId: "s1", cwd: "/test", outputTokens: 100, costUsd: 1.00,
      message: JSON.stringify({
        content: [
          { type: "tool_use", name: "Bash", input: { command: "a".repeat(800) } },
          { type: "tool_use", name: "mcp__zenhub__getSprint", input: { id: "x".repeat(200) } },
        ],
        usage: { output_tokens: 100 },
      }),
    }];
    const result = analyzeTooling(turns);
    const bash = result.byTool.find((t) => t.name === "Bash");
    const zenhub = result.byTool.find((t) => t.name === "mcp__zenhub__getSprint");
    expect(bash!.attributedCost).toBeGreaterThan(zenhub!.attributedCost);
    expect(bash!.attributedCost + zenhub!.attributedCost).toBeCloseTo(1.00, 2);
  });

  it("assigns full cost to (no tool) for text-only turns", () => {
    const turns = [{
      uuid: "t1", sessionId: "s1", cwd: "/test", outputTokens: 100, costUsd: 0.50,
      message: JSON.stringify({
        content: [{ type: "text", text: "Hello world" }],
        usage: { output_tokens: 100 },
      }),
    }];
    const result = analyzeTooling(turns);
    const noTool = result.layers.find((l) => l.layer === "(no tool)");
    expect(noTool!.attributedCost).toBeCloseTo(0.50, 4);
  });

  it("handles null costUsd without NaN", () => {
    const turns = [{
      uuid: "t1", sessionId: "s1", cwd: "/test", outputTokens: 100, costUsd: null,
      message: JSON.stringify({
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        usage: { output_tokens: 100 },
      }),
    }];
    const result = analyzeTooling(turns);
    const bash = result.byTool.find((t) => t.name === "Bash");
    expect(bash!.calls).toBe(1);
    expect(bash!.attributedCost).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/tools.test.ts`
Expected: FAIL — module `@/tools` does not exist.

- [ ] **Step 3: Implement `src/tools.ts`**

Create `src/tools.ts`:

```typescript
import { parseContentBlocks } from "@/parse";
import type { ContentBlock } from "@/parse";
import type { RawTurnForTool } from "@/reader";

export type ToolLayer = "plugin" | "mcp" | "skill" | "meta" | "builtin";

export interface ToolClassification {
  layer: ToolLayer;
  server?: string;
  shortName?: string;
}

const META_TOOLS = new Set([
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "Task", "TodoWrite", "EnterPlanMode", "ExitPlanMode", "ToolSearch",
]);

export function classifyTool(name: string): ToolClassification {
  if (name.startsWith("mcp__plugin_")) {
    const parts = name.split("__");
    const server = parts[2] ?? "unknown";
    const shortName = parts.slice(3).join("__") || name;
    return { layer: "plugin", server, shortName };
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] ?? "unknown";
    const shortName = parts.slice(2).join("__") || name;
    return { layer: "mcp", server, shortName };
  }
  if (name === "Skill") return { layer: "skill" };
  if (META_TOOLS.has(name)) return { layer: "meta" };
  return { layer: "builtin" };
}

interface ToolEntry {
  name: string;
  layer: ToolLayer;
  server: string | null;
  shortName: string | null;
  calls: number;
  attributedCost: number;
}

interface LayerEntry {
  layer: string;
  calls: number;
  attributedCost: number;
  costPct: number;
  avgCostPerCall: number;
}

export interface ToolAnalysis {
  summary: {
    totalCalls: number;
    distinctTools: number;
    activeLayers: number;
    unclassifiedCount: number;
  };
  layers: LayerEntry[];
  byTool: ToolEntry[];
  unclassified: string[];
}

export function analyzeTooling(turns: RawTurnForTool[]): ToolAnalysis {
  const toolMap = new Map<string, ToolEntry>();
  const unclassifiedSet = new Set<string>();
  let totalCalls = 0;

  for (const turn of turns) {
    const blocks = parseContentBlocks(turn.message);
    const toolBlocks = blocks.filter((b): b is ContentBlock & { name: string } =>
      b.type === "tool_use" && typeof b.name === "string"
    );

    if (toolBlocks.length === 0) {
      const key = "(no tool)";
      const entry = toolMap.get(key) ?? { name: key, layer: "(no tool)" as ToolLayer, server: null, shortName: null, calls: 0, attributedCost: 0 };
      entry.calls++;
      entry.attributedCost += turn.costUsd ?? 0;
      toolMap.set(key, entry);
      totalCalls++;
      continue;
    }

    const sizes = toolBlocks.map((b) => JSON.stringify(b.input ?? {}).length);
    const totalSize = sizes.reduce((s, n) => s + n, 0);

    for (let i = 0; i < toolBlocks.length; i++) {
      const block = toolBlocks[i]!;
      const name = block.name;
      const proportion = totalSize > 0 ? sizes[i]! / totalSize : 1 / toolBlocks.length;
      const cost = (turn.costUsd ?? 0) * proportion;

      const classification = classifyTool(name);
      const entry = toolMap.get(name) ?? {
        name,
        layer: classification.layer,
        server: classification.server ?? null,
        shortName: classification.shortName ?? null,
        calls: 0,
        attributedCost: 0,
      };
      entry.calls++;
      entry.attributedCost += cost;
      toolMap.set(name, entry);
      totalCalls++;
    }
  }

  const byTool = Array.from(toolMap.values()).sort((a, b) => b.attributedCost - a.attributedCost);

  const layerMap = new Map<string, { calls: number; cost: number }>();
  for (const tool of byTool) {
    const key = tool.layer;
    const e = layerMap.get(key) ?? { calls: 0, cost: 0 };
    e.calls += tool.calls;
    e.cost += tool.attributedCost;
    layerMap.set(key, e);
  }

  const totalCost = byTool.reduce((s, t) => s + t.attributedCost, 0);
  const layerOrder = ["builtin", "mcp", "plugin", "skill", "meta", "(no tool)"];
  const layers = layerOrder
    .filter((l) => layerMap.has(l))
    .map((l) => {
      const d = layerMap.get(l)!;
      return {
        layer: l,
        calls: d.calls,
        attributedCost: d.cost,
        costPct: totalCost > 0 ? (d.cost / totalCost) * 100 : 0,
        avgCostPerCall: d.calls > 0 ? d.cost / d.calls : 0,
      };
    });

  const knownLayers: Set<string> = new Set(["plugin", "mcp", "skill", "meta", "builtin", "(no tool)"]);
  const activeLayers = layers.filter((l) => knownLayers.has(l.layer) && l.layer !== "(no tool)").length;

  return {
    summary: {
      totalCalls,
      distinctTools: new Set(byTool.map((t) => t.name)).size,
      activeLayers,
      unclassifiedCount: unclassifiedSet.size,
    },
    layers,
    byTool,
    unclassified: [...unclassifiedSet],
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/tools.test.ts`
Expected: All classification and cost tests PASS.

- [ ] **Step 5: Run full suite**

Run: `bun test && bun run typecheck`
Expected: All tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools.ts tests/tools.test.ts
git commit -m "feat: add tool classifier and analyzer with proportional cost attribution"
```

---

### Task 5: Create `src/reports/tools.ts` — sectioned report renderer

**Files:**
- Create: `src/reports/tools.ts`
- Modify: `tests/reports.test.ts` (smoke tests)

- [ ] **Step 1: Write smoke tests**

In `tests/reports.test.ts`, add at the end (before any closing braces):

```typescript
import { renderToolingReport } from "@/reports/tools";

describe("Tooling report", () => {
  let jsonlReader: Reader;
  beforeAll(() => { jsonlReader = createReader({ source: "jsonl" }); });
  afterAll(() => { jsonlReader.close(); });

  it("renders without throwing via JSONL", () => {
    expect(() => renderToolingReport(jsonlReader, opts)).not.toThrow();
  });

  it("renders valid JSON with layers and byTool arrays", () => {
    const output = capture(() => renderToolingReport(jsonlReader, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("tools");
    expect(Array.isArray(parsed.layers)).toBe(true);
    expect(Array.isArray(parsed.byTool)).toBe(true);
    expect(Array.isArray(parsed.unclassified)).toBe(true);
    expect(parsed.summary).toHaveProperty("totalCalls");
  });

  it("has zero unclassified tools in fixture data", () => {
    const output = capture(() => renderToolingReport(jsonlReader, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.unclassified.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/reports.test.ts`
Expected: FAIL — `@/reports/tools` does not exist.

- [ ] **Step 3: Implement `src/reports/tools.ts`**

Create `src/reports/tools.ts`:

```typescript
import type { Reader } from "@/reader";
import { analyzeTooling } from "@/tools";
import type { ToolLayer } from "@/tools";
import { renderHeader, renderKV, renderTable, formatUsd, formatPct, bold, dim, renderFootnote } from "@/format";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderToolingReport(reader: Reader, opts: Options): void {
  const turns = reader.queryRawTurnsForTool(opts.since);
  const analysis = analyzeTooling(turns);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "tools",
      summary: analysis.summary,
      layers: analysis.layers,
      byTool: analysis.byTool,
      unclassified: analysis.unclassified,
    }, null, 2));
    return;
  }

  if (analysis.summary.totalCalls === 0) {
    console.log(`No tool calls found in the last ${opts.sinceStr}.`);
    return;
  }

  console.log(renderHeader("token-scope — Tooling Analysis"));
  console.log(renderKV([
    ["Total Tool Calls", String(analysis.summary.totalCalls)],
    ["Distinct Tools", String(analysis.summary.distinctTools)],
    ["Layers Active", `${analysis.summary.activeLayers} of 5`],
    ["Unclassified Tools", String(analysis.summary.unclassifiedCount)],
  ]));

  console.log(`\n${bold("  Cost by Layer")}`);
  console.log(renderTable(
    [
      { header: "Layer", align: "left", width: 12 },
      { header: "Calls", align: "right", width: 7 },
      { header: "Attributed Cost", align: "right", width: 16 },
      { header: "Cost %", align: "right", width: 8 },
      { header: "Avg/Call", align: "right", width: 10 },
    ],
    analysis.layers.map((l) => [
      l.layer === "builtin" ? "Built-in" : l.layer === "mcp" ? "MCP" : l.layer === "plugin" ? "Plugin" : l.layer === "skill" ? "Skill" : l.layer === "meta" ? "Meta" : l.layer,
      String(l.calls),
      formatUsd(l.attributedCost),
      formatPct(l.costPct),
      formatUsd(l.avgCostPerCall),
    ])
  ));

  const renderLayerSection = (layer: ToolLayer | "(no tool)", title: string, showServer: boolean) => {
    const tools = analysis.byTool.filter((t) => t.layer === layer).slice(0, opts.limit);
    if (tools.length === 0) return;

    console.log(`\n${bold(`  ── ${title} ──`)}`);
    if (showServer) {
      console.log(renderTable(
        [
          { header: "Server", align: "left", width: 18 },
          { header: "Tool", align: "left", width: 24 },
          { header: "Calls", align: "right", width: 7 },
          { header: "Attributed Cost", align: "right", width: 16 },
        ],
        tools.map((t) => [t.server ?? "—", t.shortName ?? t.name, String(t.calls), formatUsd(t.attributedCost)])
      ));
    } else {
      console.log(renderTable(
        [
          { header: "Tool", align: "left", width: 24 },
          { header: "Calls", align: "right", width: 7 },
          { header: "Attributed Cost", align: "right", width: 16 },
          { header: "Avg/Call", align: "right", width: 10 },
        ],
        tools.map((t) => [t.shortName ?? t.name, String(t.calls), formatUsd(t.attributedCost), formatUsd(t.calls > 0 ? t.attributedCost / t.calls : 0)])
      ));
    }
  };

  renderLayerSection("builtin", "Built-in Tools", false);
  renderLayerSection("mcp", "MCP Servers", true);
  renderLayerSection("plugin", "Plugins", true);
  renderLayerSection("skill", "Skills", false);
  renderLayerSection("meta", "Meta / Orchestration", false);

  console.log(renderFootnote("Hooks run as shell commands, not tool_use blocks — invisible here."));
  console.log(renderFootnote("Cost attributed proportionally by input payload size per turn."));

  if (analysis.unclassified.length > 0) {
    console.log(`\n${bold("  Unclassified Tools")}`);
    for (const name of analysis.unclassified) {
      console.log(`    ${name}`);
    }
  }

  console.log("");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test && bun run typecheck`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reports/tools.ts tests/reports.test.ts
git commit -m "feat: add --tools sectioned report renderer"
```

---

### Task 6: Wire `--tools` into CLI

**Files:**
- Modify: `src/cli.ts:53` (CliArgs mode union)
- Modify: `src/cli.ts:84-88` (parseArgs switch)
- Modify: `src/cli.ts:176-208` (main switch)

- [ ] **Step 1: Add `"tools"` to CliArgs mode union**

In `src/cli.ts`, line 53, add `"tools"` to the mode union:

```typescript
  mode: "summary" | "tool" | "project" | "session" | "thinking" | "sessions" | "context" | "cache" | "efficiency" | "tools";
```

- [ ] **Step 2: Add `--tools` to parseArgs switch**

In `src/cli.ts`, after the `case "--efficiency":` line (around line 88), add:

```typescript
      case "--tools": setMode("tools"); break;
```

- [ ] **Step 3: Add tools case to main switch**

In `src/cli.ts`, after the `case "efficiency":` block (around line 207), add:

```typescript
    case "tools": {
      const { renderToolingReport } = await import("@/reports/tools");
      renderToolingReport(reader, options); break;
    }
```

- [ ] **Step 4: Add `--tools` to HELP text**

In the HELP string (around line 22), add after the `--efficiency` line:

```
  --tools                 Tooling analysis by layer (plugin, MCP, skill, meta, built-in)
```

- [ ] **Step 5: Add `--tools` to error message**

In the `setMode` function (around line 71), update the error message to include `--tools`:

```typescript
      process.stderr.write("Error: --tool, --project, --session, --thinking, --sessions, and --tools are mutually exclusive.\n");
```

- [ ] **Step 6: Run tests and smoke test**

Run: `bun test && bun run typecheck`
Expected: All tests PASS.

Smoke test: `token-scope --tools --since 7d`
Expected: Sectioned report renders with real data.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts
git commit -m "feat: wire --tools flag into CLI"
```

---

### Task 7: Update README with `--tools` report

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `--tools` to the usage table**

In the usage table (after the `--efficiency` row), add:

```markdown
| `token-scope --tools` | Tooling analysis: cost by layer (plugin, MCP, skill, meta, built-in) |
```

- [ ] **Step 2: Add sample output section**

After the "Thinking analysis" section, add:

```markdown
---

### Tooling analysis

\`\`\`bash
token-scope --tools --since 30d
\`\`\`

\`\`\`
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
\`\`\`

Classifies every tool call into five layers and attributes cost proportionally by input payload size. Plugins are MCP servers provided by Claude Code plugins (`mcp__plugin_*`). Hooks are invisible (shell commands, not tool_use blocks).
```

- [ ] **Step 3: Update roadmap**

Replace the existing roadmap section:

```markdown
## Roadmap

- **Phase 1:** Core terminal reports (summary, tool, project, session, thinking)
- **Phase 2:** Cost efficiency analytics (cache, efficiency, context bloat, per-project thinking)
- **Phase 3 (current):** Tooling analysis by layer with proportional cost attribution
- **Phase 4:** Full MCP tool drill-down, per-project tool usage breakdown
- **Phase 5:** Export any report to Markdown / Obsidian
```

- [ ] **Step 4: Update accuracy notes**

Add to the accuracy notes section:

```markdown
- **Tool attribution** — Phase 3+ counts ALL tool_use blocks per turn and splits cost proportionally by input payload size. Earlier reports use per-turn dominant tool (largest input).
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add --tools report section to README"
```

---

### Task 8: Discovery validation against live data

**Files:** None — this is a verification step.

- [ ] **Step 1: Run `--tools --json` against real data**

```bash
token-scope --tools --since 30d --json | jq '.unclassified'
```

Expected: `[]` (empty array).

- [ ] **Step 2: Verify layer counts are plausible**

```bash
token-scope --tools --since 30d --json | jq '.summary'
```

Verify `totalCalls` > 0, `activeLayers` >= 1, `unclassifiedCount` == 0.

- [ ] **Step 3: Verify cost sums match**

```bash
token-scope --tools --since 30d --json | jq '[.layers[].attributedCost] | add'
token-scope --since 30d --json | jq '.totals.totalCostUsd'
```

The tools total should be close to (but may not exactly equal) the summary total due to floating point. They should be within 1%.

- [ ] **Step 4: Run the terminal report**

```bash
token-scope --tools --since 30d
```

Visual inspection: all sections render, no NaN or undefined values, layer names are readable.

- [ ] **Step 5: If any unclassified tools appear, add them to the META_TOOLS set or adjust classification rules**

If `unclassified` is non-empty, update `src/tools.ts` classification, re-run tests, commit.

- [ ] **Step 6: Commit any fixes from discovery**

```bash
git add -A && git commit -m "fix: address tool classification gaps from live data validation"
```

Only commit if changes were made. Skip if discovery passed clean.
