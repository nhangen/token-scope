# token-scope JSONL Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JSONL transcript files as the primary data source for token-scope, keeping SQLite as a secondary fallback, via a `Reader` abstraction layer that all report modules consume.

**Architecture:** Introduce a `Reader` interface in `src/reader.ts` that exposes all query methods. A `JsonlReader` in `src/jsonl.ts` reads `~/.claude/projects/**/*.jsonl` (skipping subagents) and implements all Reader methods as in-memory operations. A `createSqliteReader()` factory wraps the existing `db.ts` functions. `cli.ts` auto-detects the source (JSONL if `~/.claude/projects/` has files, else SQLite) and passes a `Reader` to all report functions, which are updated to accept `Reader` instead of `Database`.

**Tech Stack:** TypeScript, Bun, `bun:sqlite` (SQLite path), `fs` stdlib (JSONL path scanning), existing `src/parse.ts` and `src/pricing.ts` modules.

---

## File Map

| File | Action | Role |
|------|--------|------|
| `src/reader.ts` | Create | `Reader` interface + `createReader()` auto-detect factory |
| `src/jsonl.ts` | Create | `JsonlReader` — scans JSONL files, in-memory queries |
| `src/db.ts` | Modify | Add `createSqliteReader(db): Reader` factory export |
| `src/pricing.ts` | Modify | Add missing model IDs seen in real JSONL data |
| `src/cli.ts` | Modify | Use `createReader()`, pass `reader` to reports |
| `src/reports/summary.ts` | Modify | `(db: Database, opts)` → `(reader: Reader, opts)` |
| `src/reports/tool.ts` | Modify | Same |
| `src/reports/project.ts` | Modify | Same |
| `src/reports/session.ts` | Modify | Same |
| `src/reports/thinking.ts` | Modify | Same |
| `tests/fixtures/projects/` | Create | JSONL fixture sessions for tests |
| `tests/setup.ts` | Modify | Also set `TOKEN_SCOPE_PROJECTS_DIR` to fixture path |
| `tests/jsonl.test.ts` | Create | Unit tests for `JsonlReader` |
| `tests/reports.test.ts` | Modify | Use reader instead of db directly |

---

## Task 1: Reader Interface + Missing Pricing Models

**Files:**
- Create: `src/reader.ts`
- Modify: `src/pricing.ts`
- Test: `tests/reader.test.ts`

The real JSONL data contains these model IDs not yet in `src/pricing.ts`:
- `claude-sonnet-4-5-20250929` (same price tier as claude-sonnet-4-6)
- `claude-opus-4-1-20250805` (same price tier as claude-opus-4-6)
- `claude-sonnet-4-20250514` (same price tier as claude-sonnet-4-6)

- [ ] **Step 1: Add missing models to `src/pricing.ts`**

Add these 3 entries to the `PRICING` map immediately after the existing entries (before the closing `}`):

```typescript
  "claude-sonnet-4-5-20250929": { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
  "claude-opus-4-1-20250805":   { inputPerMillion: 15.00, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50,  outputPerMillion: 75.00 },
  "claude-sonnet-4-20250514":   { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
```

- [ ] **Step 2: Write failing test for `src/reader.ts`**

Create `tests/reader.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";

describe("reader module", () => {
  it("exports createReader function", async () => {
    const mod = await import("@/reader");
    expect(typeof mod.createReader).toBe("function");
  });
});
```

Run: `bun test tests/reader.test.ts`
Expected: FAIL with "Cannot find module @/reader"

- [ ] **Step 3: Create `src/reader.ts`**

```typescript
import type {
  SummaryTotals, ToolRow, ProjectRow, SessionRow, TurnRow, WeekRow,
  ThinkingTurnRow, BashCommandRow, ProjectMatch,
} from "@/db";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

export type { SummaryTotals, ToolRow, ProjectRow, SessionRow, TurnRow, WeekRow, ThinkingTurnRow, BashCommandRow, ProjectMatch };

export interface Reader {
  querySummaryTotals(since: number): SummaryTotals;
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
    const { JsonlReader } = require("./jsonl") as typeof import("./jsonl");
    return new JsonlReader(projectsDir);
  }

  const { resolveDbPath, openDb, createSqliteReader } = require("./db") as typeof import("./db");
  const { path } = resolveDbPath(opts.dbPath);
  const db = openDb(path);
  return createSqliteReader(db);
}
```

- [ ] **Step 4: Run test**

Run: `bun test tests/reader.test.ts`
Expected: PASS (module resolves, `createReader` is a function)

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `bun test`
Expected: 57 pass, 0 fail

- [ ] **Step 6: Typecheck**

Run: `bun run tsc --noEmit`
Expected: exits 0 (may warn about missing `./jsonl` module until Task 3 — use `// @ts-ignore` if needed on the require line)

- [ ] **Step 7: Commit**

```bash
git add src/reader.ts src/pricing.ts tests/reader.test.ts
git commit -m "Add Reader interface and auto-detect factory; add missing model pricing"
```

---

## Task 2: JSONL Test Fixture

**Files:**
- Create: `tests/fixtures/projects/-Users-alice-projects-token-scope/sess-j1.jsonl`
- Create: `tests/fixtures/projects/-Users-alice-projects-optin-monster-app/sess-j2.jsonl`
- Create: `tests/fixtures/projects/-Users-alice-projects-beacon/sess-j3.jsonl`
- Modify: `tests/setup.ts`

The JSONL fixture must match the shape of real Claude Code transcripts so the reader can be tested against known data. Each JSONL line is a JSON object. Only `type === "assistant"` lines with `message.usage.output_tokens > 0` are processed.

Fixture data summary:
- **sess-j1** (token-scope project): 3 turns — Bash (200 tokens), Read+thinking (500 tokens), Edit (300 tokens). Thinking block in turn 2.
- **sess-j2** (optin-monster project): 2 turns — Agent (800 tokens), Edit (150 tokens).
- **sess-j3** (beacon project): 1 turn — Grep (100 tokens). Old timestamp (2025-01-01).

Total output tokens across sessions j1+j2 = 200+500+300+800+150 = 1950 (sess-j3 is old, excluded by default 30d filter).

- [ ] **Step 1: Create `tests/fixtures/projects/-Users-alice-projects-token-scope/sess-j1.jsonl`**

Create the directory first:
```bash
mkdir -p ~/ML-AI/token-scope/tests/fixtures/projects/-Users-alice-projects-token-scope
```

Create the file with exactly these 3 lines (each is one JSON object, no trailing comma):

Line 1 — Bash turn (200 output tokens):
```json
{"type":"assistant","uuid":"j1-t1","parentUuid":null,"sessionId":"sess-j1","cwd":"/Users/alice/projects/token-scope","timestamp":"2026-04-01T10:00:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j1t1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"bun test"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":200,"cache_read_input_tokens":10000,"cache_creation_input_tokens":500}}}
```

Line 2 — Read + thinking turn (500 output tokens, has thinking block):
```json
{"type":"assistant","uuid":"j1-t2","parentUuid":"j1-t1","sessionId":"sess-j1","cwd":"/Users/alice/projects/token-scope","timestamp":"2026-04-01T10:01:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j1t2","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"Let me think about this carefully. The test is failing because of a type mismatch in the comparison."},{"type":"tool_use","id":"tu2","name":"Read","input":{"file_path":"/Users/alice/projects/token-scope/src/db.ts"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":500,"cache_read_input_tokens":45000,"cache_creation_input_tokens":0}}}
```

Line 3 — Edit turn (300 output tokens):
```json
{"type":"assistant","uuid":"j1-t3","parentUuid":"j1-t2","sessionId":"sess-j1","cwd":"/Users/alice/projects/token-scope","timestamp":"2026-04-01T10:02:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j1t3","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu3","name":"Edit","input":{"file_path":"/Users/alice/projects/token-scope/src/db.ts","old_string":"x","new_string":"y"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":2,"output_tokens":300,"cache_read_input_tokens":48000,"cache_creation_input_tokens":200}}}
```

- [ ] **Step 2: Create `tests/fixtures/projects/-Users-alice-projects-optin-monster-app/sess-j2.jsonl`**

```bash
mkdir -p ~/ML-AI/token-scope/tests/fixtures/projects/-Users-alice-projects-optin-monster-app
```

Line 1 — Agent turn (800 output tokens):
```json
{"type":"assistant","uuid":"j2-t1","parentUuid":null,"sessionId":"sess-j2","cwd":"/Users/alice/projects/optin-monster-app","timestamp":"2026-04-02T09:00:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-opus-4-6","id":"msg-j2t1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu4","name":"Agent","input":{"prompt":"Fix the bug"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":800,"cache_read_input_tokens":60000,"cache_creation_input_tokens":3000}}}
```

Line 2 — Edit turn (150 output tokens):
```json
{"type":"assistant","uuid":"j2-t2","parentUuid":"j2-t1","sessionId":"sess-j2","cwd":"/Users/alice/projects/optin-monster-app","timestamp":"2026-04-02T09:05:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-opus-4-6","id":"msg-j2t2","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu5","name":"Edit","input":{"file_path":"/some/file.php","old_string":"a","new_string":"b"}},{"type":"text","text":"Done."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":4,"output_tokens":150,"cache_read_input_tokens":62000,"cache_creation_input_tokens":0}}}
```

- [ ] **Step 3: Create `tests/fixtures/projects/-Users-alice-projects-beacon/sess-j3.jsonl`**

```bash
mkdir -p ~/ML-AI/token-scope/tests/fixtures/projects/-Users-alice-projects-beacon
```

Line 1 — Grep turn, old timestamp (100 output tokens, outside 30d window):
```json
{"type":"assistant","uuid":"j3-t1","parentUuid":null,"sessionId":"sess-j3","cwd":"/Users/alice/projects/beacon","timestamp":"2025-01-01T00:00:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j3t1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu6","name":"Grep","input":{"pattern":"foo"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":2,"output_tokens":100,"cache_read_input_tokens":5000,"cache_creation_input_tokens":100}}}
```

- [ ] **Step 4: Modify `tests/setup.ts`**

Current content:
```typescript
process.env["TOKEN_SCOPE_DB"] = new URL("./fixtures/__store.db", import.meta.url).pathname;
```

New content:
```typescript
process.env["TOKEN_SCOPE_DB"] = new URL("./fixtures/__store.db", import.meta.url).pathname;
process.env["TOKEN_SCOPE_PROJECTS_DIR"] = new URL("./fixtures/projects", import.meta.url).pathname;
```

- [ ] **Step 5: Commit**

```bash
cd ~/ML-AI/token-scope
git add tests/fixtures/projects/ tests/setup.ts
git commit -m "Add JSONL fixture data (3 projects, 3 sessions, 6 turns)"
```

---

## Task 3: `src/jsonl.ts` — JSONL Reader

**Files:**
- Create: `src/jsonl.ts`
- Create: `tests/jsonl.test.ts`

The `JsonlReader` class:
1. Constructor scans `projectsDir/**/*.jsonl` (skips files inside `subagents/` directories)
2. Parses each line; keeps only `type === "assistant"` lines where `message.usage.output_tokens` > 0 and `json_valid`
3. Stores a flat `JsonlTurn[]` array in memory (immutable after construction)
4. All query methods filter/aggregate over this array

`costUsd` is computed from `src/pricing.ts` using `model + outputTokens + inputTokens + cacheReadTokens + cacheWriteTokens`. If the model is not in the pricing table, `costUsd` is null.

`contentJson` field: `JSON.stringify(message.content)` so that existing `parseContentBlocks()` from `src/parse.ts` works unchanged.

`timestamp` in all returned row types is **milliseconds** (consistent with SQLite reader). The JSONL ISO timestamp is converted: `new Date(isoString).getTime()`.

- [ ] **Step 1: Write failing tests**

Create `tests/jsonl.test.ts`:

```typescript
import { describe, expect, it, beforeAll } from "bun:test";
import { JsonlReader } from "@/jsonl";

let reader: JsonlReader;

beforeAll(() => {
  const dir = process.env["TOKEN_SCOPE_PROJECTS_DIR"]!;
  reader = new JsonlReader(dir);
});

describe("JsonlReader — summary totals", () => {
  it("counts all turns with since=0", () => {
    const totals = reader.querySummaryTotals(0);
    expect(totals.turnCount).toBe(6);
  });

  it("counts sessions with since=0", () => {
    const totals = reader.querySummaryTotals(0);
    expect(totals.sessionCount).toBe(3);
  });

  it("sums output tokens with since=0", () => {
    const totals = reader.querySummaryTotals(0);
    expect(totals.totalOutputTokens).toBe(2050);
  });

  it("excludes old session with 30d window", () => {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const totals = reader.querySummaryTotals(since);
    expect(totals.turnCount).toBe(5);
    expect(totals.sessionCount).toBe(2);
  });
});

describe("JsonlReader — by-tool", () => {
  it("returns tool rows sorted by outputTokens desc", () => {
    const rows = reader.queryByTool(0, 20);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.outputTokens).toBeGreaterThanOrEqual(rows[1]?.outputTokens ?? 0);
  });

  it("dominant tool for thinking turn is Read", () => {
    const rows = reader.queryByTool(0, 20);
    const readRow = rows.find((r) => r.tool === "Read");
    expect(readRow).toBeDefined();
  });
});

describe("JsonlReader — by-project", () => {
  it("returns 3 projects with since=0", () => {
    const rows = reader.queryByProject(0, 20);
    expect(rows.length).toBe(3);
  });

  it("token-scope project has 3 turns", () => {
    const rows = reader.queryByProject(0, 20);
    const ts = rows.find((r) => r.cwd?.includes("token-scope"));
    expect(ts?.turns).toBe(3);
  });
});

describe("JsonlReader — sessions", () => {
  it("returns 3 sessions with since=0", () => {
    const sessions = reader.querySessions(0, 20);
    expect(sessions.length).toBe(3);
  });

  it("sess-j1 has 3 turns", () => {
    const sessions = reader.querySessions(0, 20);
    const s = sessions.find((r) => r.sessionId === "sess-j1");
    expect(s?.turnCount).toBe(3);
  });
});

describe("JsonlReader — session turns", () => {
  it("returns 3 turns for sess-j1", () => {
    const turns = reader.querySessionTurns("sess-j1");
    expect(turns.length).toBe(3);
  });

  it("turns are ordered by timestamp asc", () => {
    const turns = reader.querySessionTurns("sess-j1");
    expect(turns[0]!.timestamp).toBeLessThan(turns[1]!.timestamp);
  });
});

describe("JsonlReader — project matches", () => {
  it("matches by fragment", () => {
    const matches = reader.queryProjectMatches("token-scope");
    expect(matches.length).toBe(1);
    expect(matches[0]!.cwd).toContain("token-scope");
  });

  it("returns empty for no match", () => {
    const matches = reader.queryProjectMatches("zzz-no-match");
    expect(matches.length).toBe(0);
  });
});

describe("JsonlReader — thinking turns", () => {
  it("finds thinking turns with since=0", () => {
    const turns = reader.queryThinkingTurns(0);
    expect(turns.length).toBe(1);
    expect(turns[0]!.thinkingChars).toBeGreaterThan(0);
  });
});

describe("JsonlReader — bash turns", () => {
  it("finds bash turns with since=0", () => {
    const turns = reader.queryBashTurns(0);
    expect(turns.length).toBe(1);
    expect(turns[0]!.command).toBe("bun test");
  });
});

describe("JsonlReader — close", () => {
  it("close() does not throw", () => {
    expect(() => reader.close()).not.toThrow();
  });
});
```

Run: `bun test tests/jsonl.test.ts`
Expected: FAIL with "Cannot find module @/jsonl"

- [ ] **Step 2: Implement `src/jsonl.ts`**

```typescript
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { getPricing } from "@/pricing";
import { parseContentBlocks, resolveDominantTool, estimateThinkingTokens } from "@/parse";
import type { Reader, SummaryTotals, ToolRow, ProjectRow, SessionRow, TurnRow, WeekRow, ThinkingTurnRow, BashCommandRow, ProjectMatch } from "@/reader";

interface JsonlTurn {
  uuid: string;
  sessionId: string;
  cwd: string;
  timestampMs: number;
  model: string;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason: string | null;
  contentJson: string;
  costUsd: number | null;
}

function computeCost(model: string, out: number, inp: number, cacheRead: number, cacheWrite: number): number | null {
  const p = getPricing(model);
  if (!p) return null;
  return (out * p.outputPerMillion + inp * p.inputPerMillion + cacheRead * p.cacheReadPerMillion + cacheWrite * p.cacheWritePerMillion) / 1_000_000;
}

function scanJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(dir, entry.name);
    for (const f of readdirSync(projectDir, { withFileTypes: true })) {
      if (f.isDirectory() && f.name === "subagents") continue;
      if (f.isFile() && f.name.endsWith(".jsonl")) {
        files.push(join(projectDir, f.name));
      }
    }
  }
  return files;
}

function loadTurns(dir: string): JsonlTurn[] {
  const turns: JsonlTurn[] = [];
  for (const file of scanJsonlFiles(dir)) {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj["type"] !== "assistant") continue;
      const msg = obj["message"] as Record<string, unknown> | undefined;
      if (!msg) continue;
      const usage = msg["usage"] as Record<string, unknown> | undefined;
      if (!usage) continue;
      const out = Number(usage["output_tokens"] ?? 0);
      if (out <= 0) continue;
      const model = String(msg["model"] ?? "");
      const inp = Number(usage["input_tokens"] ?? 0);
      const cacheRead = Number(usage["cache_read_input_tokens"] ?? 0);
      const cacheWrite = Number(usage["cache_creation_input_tokens"] ?? 0);
      const content = (msg["content"] ?? []) as unknown[];
      turns.push({
        uuid: String(obj["uuid"] ?? ""),
        sessionId: String(obj["sessionId"] ?? ""),
        cwd: String(obj["cwd"] ?? ""),
        timestampMs: new Date(String(obj["timestamp"] ?? "")).getTime(),
        model,
        outputTokens: out,
        inputTokens: inp,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        stopReason: msg["stop_reason"] ? String(msg["stop_reason"]) : null,
        contentJson: JSON.stringify(content),
        costUsd: computeCost(model, out, inp, cacheRead, cacheWrite),
      });
    }
  }
  return turns;
}

export class JsonlReader implements Reader {
  private readonly turns: JsonlTurn[];

  constructor(projectsDir: string) {
    this.turns = loadTurns(projectsDir);
  }

  private filter(since: number): JsonlTurn[] {
    const sinceMs = since * 1000;
    return this.turns.filter((t) => t.timestampMs > sinceMs);
  }

  querySummaryTotals(since: number): SummaryTotals {
    const turns = this.filter(since);
    const sessionCount = new Set(turns.map((t) => t.sessionId)).size;
    const totalOutputTokens = turns.reduce((s, t) => s + t.outputTokens, 0);
    const totalInputTokens = turns.reduce((s, t) => s + t.inputTokens, 0);
    const totalCacheReadTokens = turns.reduce((s, t) => s + t.cacheReadTokens, 0);
    const totalCacheWriteTokens = turns.reduce((s, t) => s + t.cacheWriteTokens, 0);
    const costsKnown = turns.filter((t) => t.costUsd !== null);
    const totalCostUsd = costsKnown.length > 0 ? costsKnown.reduce((s, t) => s + t.costUsd!, 0) : null;
    const avgCostPerSession = totalCostUsd !== null && sessionCount > 0 ? totalCostUsd / sessionCount : null;
    const avgCostPerTurn = totalCostUsd !== null && turns.length > 0 ? totalCostUsd / turns.length : null;
    return { totalOutputTokens, totalInputTokens, totalCacheReadTokens, totalCacheWriteTokens, totalCostUsd, sessionCount, turnCount: turns.length, avgCostPerSession, avgCostPerTurn };
  }

  queryByTool(since: number, limit: number): ToolRow[] {
    const turns = this.filter(since);
    const totalOutput = turns.reduce((s, t) => s + t.outputTokens, 0);
    const totalCost = turns.reduce((s, t) => s + (t.costUsd ?? 0), 0);
    const byTool = new Map<string, { turns: number; outputTokens: number; costUsd: number }>();
    for (const t of turns) {
      const tool = resolveDominantTool(parseContentBlocks(t.contentJson));
      const e = byTool.get(tool) ?? { turns: 0, outputTokens: 0, costUsd: 0 };
      byTool.set(tool, { turns: e.turns + 1, outputTokens: e.outputTokens + t.outputTokens, costUsd: e.costUsd + (t.costUsd ?? 0) });
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

  queryByProject(since: number, limit: number): ProjectRow[] {
    const turns = this.filter(since);
    const byProject = new Map<string, { sessions: Set<string>; turns: number; outputTokens: number; costUsd: number; costKnown: boolean }>();
    for (const t of turns) {
      const e = byProject.get(t.cwd) ?? { sessions: new Set(), turns: 0, outputTokens: 0, costUsd: 0, costKnown: false };
      e.sessions.add(t.sessionId);
      e.turns++;
      e.outputTokens += t.outputTokens;
      if (t.costUsd !== null) { e.costUsd += t.costUsd; e.costKnown = true; }
      byProject.set(t.cwd, e);
    }
    return Array.from(byProject.entries())
      .map(([cwd, d]) => {
        const totalCostUsd = d.costKnown ? d.costUsd : null;
        const sessions = d.sessions.size;
        return { cwd, sessions, turns: d.turns, outputTokens: d.outputTokens, totalCostUsd, avgSessionCost: totalCostUsd !== null && sessions > 0 ? totalCostUsd / sessions : null };
      })
      .sort((a, b) => (b.totalCostUsd ?? 0) - (a.totalCostUsd ?? 0))
      .slice(0, limit);
  }

  queryWeeklyTrend(since: number): WeekRow[] {
    const turns = this.filter(since);
    const byWeek = new Map<string, { sessions: Set<string>; turns: number; outputTokens: number; costUsd: number; costKnown: boolean }>();
    for (const t of turns) {
      const d = new Date(t.timestampMs);
      const year = d.getUTCFullYear();
      const jan1 = new Date(Date.UTC(year, 0, 1));
      const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7);
      const label = `${year}-W${String(week).padStart(2, "0")}`;
      const e = byWeek.get(label) ?? { sessions: new Set(), turns: 0, outputTokens: 0, costUsd: 0, costKnown: false };
      e.sessions.add(t.sessionId);
      e.turns++;
      e.outputTokens += t.outputTokens;
      if (t.costUsd !== null) { e.costUsd += t.costUsd; e.costKnown = true; }
      byWeek.set(label, e);
    }
    return Array.from(byWeek.entries())
      .map(([weekLabel, d]) => ({
        weekLabel, sessions: d.sessions.size, turns: d.turns, outputTokens: d.outputTokens, totalCostUsd: d.costKnown ? d.costUsd : null,
      }))
      .sort((a, b) => b.weekLabel.localeCompare(a.weekLabel))
      .slice(0, 5);
  }

  querySessions(since: number, limit: number): SessionRow[] {
    const turns = this.filter(since);
    const bySession = new Map<string, { cwd: string; timestamps: number[]; outputTokens: number; inputTokens: number; cacheReadTokens: number; costUsd: number; costKnown: boolean }>();
    for (const t of turns) {
      const e = bySession.get(t.sessionId) ?? { cwd: t.cwd, timestamps: [], outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, costUsd: 0, costKnown: false };
      e.timestamps.push(t.timestampMs);
      e.outputTokens += t.outputTokens;
      e.inputTokens += t.inputTokens;
      e.cacheReadTokens += t.cacheReadTokens;
      if (t.costUsd !== null) { e.costUsd += t.costUsd; e.costKnown = true; }
      bySession.set(t.sessionId, e);
    }
    return Array.from(bySession.entries())
      .map(([sessionId, d]) => {
        const sorted = d.timestamps.slice().sort((a, b) => a - b);
        const startedAt = sorted[0]!;
        const endedAt = sorted.at(-1)!;
        const totalInput = d.inputTokens + d.cacheReadTokens;
        const cacheHitPct = totalInput > 0 ? (d.cacheReadTokens / totalInput) * 100 : null;
        return {
          sessionId, cwd: d.cwd, startedAt,
          durationMs: sorted.length > 1 ? endedAt - startedAt : null,
          turnCount: d.timestamps.length,
          outputTokens: d.outputTokens,
          cacheHitPct,
          totalCostUsd: d.costKnown ? d.costUsd : null,
        };
      })
      .sort((a, b) => (b.totalCostUsd ?? 0) - (a.totalCostUsd ?? 0))
      .slice(0, limit);
  }

  querySessionTurns(sessionId: string): TurnRow[] {
    return this.turns
      .filter((t) => t.sessionId === sessionId)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((t) => ({
        uuid: t.uuid,
        timestamp: t.timestampMs,
        outputTokens: t.outputTokens,
        inputTokens: t.inputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        costUsd: t.costUsd,
        durationMs: null,
        model: t.model,
        stopReason: t.stopReason,
        message: t.contentJson,
      }));
  }

  queryThinkingTurns(since: number): ThinkingTurnRow[] {
    return this.filter(since)
      .map((t) => {
        const blocks = parseContentBlocks(t.contentJson);
        let thinkingChars = 0;
        let textChars = 0;
        for (const b of blocks) {
          if (b.type === "thinking") thinkingChars += (b.thinking ?? "").length;
          else if (b.type === "text") textChars += (b.text ?? "").length;
        }
        return { uuid: t.uuid, sessionId: t.sessionId, cwd: t.cwd, timestamp: t.timestampMs, outputTokens: t.outputTokens, costUsd: t.costUsd, thinkingChars, textChars, message: t.contentJson };
      })
      .filter((t) => t.thinkingChars > 0);
  }

  queryBashTurns(since: number): BashCommandRow[] {
    return this.filter(since)
      .filter((t) => resolveDominantTool(parseContentBlocks(t.contentJson)).toLowerCase() === "bash")
      .map((t) => {
        const blocks = parseContentBlocks(t.contentJson);
        const bashBlock = blocks.find((b) => b.type === "tool_use" && (b.name ?? "").toLowerCase() === "bash");
        const command = bashBlock?.input && typeof bashBlock.input === "object" && "command" in bashBlock.input
          ? String((bashBlock.input as Record<string, unknown>)["command"])
          : null;
        return { uuid: t.uuid, sessionId: t.sessionId, timestamp: t.timestampMs, outputTokens: t.outputTokens, costUsd: t.costUsd, command: command ?? "" };
      });
  }

  queryProjectMatches(fragment: string): ProjectMatch[] {
    const seen = new Set<string>();
    const results: ProjectMatch[] = [];
    for (const t of this.turns) {
      if (!seen.has(t.cwd) && t.cwd.includes(fragment)) {
        seen.add(t.cwd);
        results.push({ cwd: t.cwd });
      }
    }
    return results;
  }

  close(): void {}
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/jsonl.test.ts`
Expected: all tests pass.

If `querySummaryTotals` total is wrong, double-check fixture output token values: j1 (200+500+300=1000) + j2 (800+150=950) + j3 (100) = 2050 total. The 30d filter excludes j3 (2025-01-01), leaving 1950 tokens.

- [ ] **Step 4: Run full suite**

Run: `bun test`
Expected: 57 + new jsonl tests passing, 0 fail.

- [ ] **Step 5: Typecheck**

Run: `bun run tsc --noEmit`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/jsonl.ts tests/jsonl.test.ts
git commit -m "Add JsonlReader — JSONL transcript data source with full query interface"
```

---

## Task 4: SQLite Reader Adapter

**Files:**
- Modify: `src/db.ts`

Add a `createSqliteReader(db: Database): Reader` factory at the bottom of `src/db.ts`. It wraps all existing query functions.

- [ ] **Step 1: Write failing test**

Add to `tests/db.test.ts` (append at the end, before closing):

```typescript
import { createSqliteReader } from "@/db";

describe("createSqliteReader", () => {
  it("returns an object implementing Reader interface", () => {
    const db = openDb(resolveDbPath().path);
    const reader = createSqliteReader(db);
    expect(typeof reader.querySummaryTotals).toBe("function");
    expect(typeof reader.queryByTool).toBe("function");
    expect(typeof reader.queryProjectMatches).toBe("function");
    expect(typeof reader.close).toBe("function");
    reader.close();
  });

  it("querySummaryTotals returns same result as direct call", () => {
    const db = openDb(resolveDbPath().path);
    const reader = createSqliteReader(db);
    const direct = querySummaryTotals(db, 0);
    const via = reader.querySummaryTotals(0);
    expect(via.turnCount).toBe(direct.turnCount);
    expect(via.totalOutputTokens).toBe(direct.totalOutputTokens);
    reader.close();
  });
});
```

Run: `bun test tests/db.test.ts`
Expected: FAIL with "createSqliteReader is not a function"

- [ ] **Step 2: Add `createSqliteReader` to `src/db.ts`**

Append at the end of `src/db.ts`:

```typescript
// ─── SQLite Reader Adapter ────────────────────────────────────────────────────

import type { Reader } from "@/reader";

export function createSqliteReader(db: Database): Reader {
  return {
    querySummaryTotals: (since) => querySummaryTotals(db, since),
    queryByTool: (since, limit) => queryByTool(db, since, limit),
    queryByProject: (since, limit) => queryByProject(db, since, limit),
    queryWeeklyTrend: (since) => queryWeeklyTrend(db, since),
    querySessions: (since, limit) => querySessions(db, since, limit),
    querySessionTurns: (sessionId) => querySessionTurns(db, sessionId),
    queryThinkingTurns: (since) => queryThinkingTurns(db, since),
    queryBashTurns: (since) => queryBashTurns(db, since),
    queryProjectMatches: (fragment) => queryProjectMatches(db, fragment),
    close: () => db.close(),
  };
}
```

Note: `import type { Reader }` at the top of db.ts may cause a circular import (reader.ts imports from db.ts, db.ts imports from reader.ts). If that occurs, inline the `Reader` type definition directly in db.ts instead of importing it:

```typescript
// Inline Reader interface to avoid circular import with reader.ts
interface InlineReader {
  querySummaryTotals(since: number): SummaryTotals;
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

export function createSqliteReader(db: Database): InlineReader {
  return { /* same implementation */ };
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/db.test.ts`
Expected: all pass including new tests.

- [ ] **Step 4: Full suite + typecheck**

```bash
bun test && bun run tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "Add createSqliteReader adapter to db.ts"
```

---

## Task 5: Update `src/cli.ts`

**Files:**
- Modify: `src/cli.ts`

Replace direct SQLite usage with `createReader()`. Add `--source` flag. Pass `reader` (not `db`) to all report functions.

- [ ] **Step 1: Rewrite `src/cli.ts`**

```typescript
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

SHARED FLAGS
  --source <jsonl|sqlite> Data source (default: auto-detect)
  --since <duration>      Time window: Nh hours, Nd days, Nw weeks (default: 30d)
  --limit <n>             Cap rows in tables (default: 20)
  --json                  Machine-readable JSON output
  --db <path>             Override SQLite database path (overrides TOKEN_SCOPE_DB)
  --version               Print version and exit
  --help                  Show this help

ENVIRONMENT
  TOKEN_SCOPE_DB           Override SQLite database path
  TOKEN_SCOPE_PROJECTS_DIR Override JSONL projects directory (default: ~/.claude/projects)
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
  source?: "jsonl" | "sqlite" | "auto";
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

  const reader = createReader({ source: args.source ?? "auto", dbPath: args.dbPath });

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

  const options = { since, limit: args.limit, json: args.json };

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
  }

  reader.close();
}

main().catch((e) => {
  process.stderr.write(`Unexpected error: ${String(e)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

Run: `bun run tsc --noEmit`
Expected: exits 0. (Report module type errors will be fixed in Task 6.)

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "Update cli.ts to use Reader abstraction with auto-detect and --source flag"
```

---

## Task 6: Update Report Modules

**Files:**
- Modify: `src/reports/summary.ts`
- Modify: `src/reports/tool.ts`
- Modify: `src/reports/project.ts`
- Modify: `src/reports/session.ts`
- Modify: `src/reports/thinking.ts`

All 5 files follow the same pattern:
1. Remove `import type { Database } from "bun:sqlite"`
2. Add `import type { Reader } from "@/reader"`
3. Change first parameter from `db: Database` to `reader: Reader`
4. Change all `querySummaryTotals(db, ...)` calls to `reader.querySummaryTotals(...)`
   (Same for all other query functions.)

The full updated content for each file is below. Implement them exactly.

- [ ] **Step 1: Update `src/reports/summary.ts`**

```typescript
import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatUsd, formatPct, bold } from "@/format";

interface Options { since: number; limit: number; json: boolean }

export function renderSummary(reader: Reader, opts: Options): void {
  const totals = reader.querySummaryTotals(opts.since);
  const byTool = reader.queryByTool(opts.since, opts.limit);
  const byProject = reader.queryByProject(opts.since, opts.limit);
  const weekly = reader.queryWeeklyTrend(opts.since);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "summary", totals, byTool, byProject, weeklyTrend: weekly,
    }, null, 2));
    return;
  }

  const sinceDate = new Date(opts.since * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  console.log(renderHeader(`token-scope — Summary  (${sinceDate} → now)`));
  console.log(`  Sessions: ${bold(String(totals.sessionCount))}   Turns: ${bold(String(totals.turnCount))}\n`);

  console.log(bold("  Totals"));
  console.log(renderKV([
    ["Output Tokens", formatTokens(totals.totalOutputTokens)],
    ["Input Tokens", formatTokens(totals.totalInputTokens)],
    ["Cache Read Tokens", formatTokens(totals.totalCacheReadTokens)],
    ["Cache Write Tokens", formatTokens(totals.totalCacheWriteTokens)],
    ["Total Cost", formatUsd(totals.totalCostUsd)],
    ["Avg Cost / Session", formatUsd(totals.avgCostPerSession)],
    ["Avg Cost / Turn", formatUsd(totals.avgCostPerTurn)],
  ]));

  const cacheHitRate = totals.totalInputTokens + totals.totalCacheReadTokens > 0
    ? (totals.totalCacheReadTokens / (totals.totalInputTokens + totals.totalCacheReadTokens)) * 100
    : null;

  console.log(`\n${bold("  Cache Efficiency")}`);
  console.log(renderKV([
    ["Cache Hit Rate", formatPct(cacheHitRate)],
    ["Est. Cache Savings", "— (requires model breakdown)"],
  ]));

  console.log(`\n${bold("  Output Tokens by Tool")}`);
  console.log(renderTable(
    [
      { header: "Tool", align: "left" },
      { header: "Turns", align: "right", width: 7 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Output %", align: "right", width: 9 },
      { header: "Avg/Turn", align: "right", width: 10 },
      { header: "Total Cost", align: "right", width: 11 },
      { header: "Cost %", align: "right", width: 7 },
    ],
    byTool.map((r) => [r.tool, String(r.turns), formatTokens(r.outputTokens), formatPct(r.outputPct), formatTokens(r.avgOutputPerTurn), formatUsd(r.totalCostUsd), formatPct(r.costPct)])
  ));
  console.log(renderFootnote("Each turn attributed to its dominant tool by input character size. Output tokens are turn-level totals."));

  console.log(`\n${bold("  Output Tokens by Project")}`);
  console.log(renderTable(
    [
      { header: "Project", align: "left" },
      { header: "Sessions", align: "right", width: 9 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Total Cost", align: "right", width: 11 },
      { header: "Avg Session Cost", align: "right", width: 17 },
    ],
    byProject.map((r) => [r.cwd ?? "(unknown)", String(r.sessions), String(r.turns), formatTokens(r.outputTokens), formatUsd(r.totalCostUsd), formatUsd(r.avgSessionCost)])
  ));

  if (weekly.length > 0) {
    console.log(`\n${bold("  Weekly Trend")}`);
    console.log(renderTable(
      [
        { header: "Week", align: "left", width: 10 },
        { header: "Sessions", align: "right", width: 9 },
        { header: "Turns", align: "right", width: 7 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Total Cost", align: "right", width: 11 },
      ],
      weekly.map((r) => [r.weekLabel, String(r.sessions), String(r.turns), formatTokens(r.outputTokens), formatUsd(r.totalCostUsd, 2)])
    ));
  }

  console.log("");
}
```

- [ ] **Step 2: Update `src/reports/tool.ts`**

Change the function signature and all query calls:

```typescript
import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatPct, truncate, bold } from "@/format";
import { parseContentBlocks, resolveDominantTool, categorizeBashCommand } from "@/parse";

interface Options { since: number; limit: number; json: boolean }

export function renderToolDrillDown(reader: Reader, toolName: string, opts: Options): void {
  const normalizedName = toolName.charAt(0).toUpperCase() + toolName.slice(1).toLowerCase();
  const allTurns = reader.queryRawTurnsForTool
    ? (reader as any).queryRawTurnsForTool(opts.since)
    : [];
```

Wait — `queryRawTurnsForTool` is an internal function in db.ts that returns `RawTurnForTool[]`. It's NOT part of the `Reader` interface. The tool report uses it to do its own dominant-tool filtering.

**Solution**: Add `queryRawTurnsForTool` to the `Reader` interface.

Update `src/reader.ts` to add to the interface:
```typescript
  queryRawTurnsForTool(since: number): RawTurnForTool[];
```

And add to `src/jsonl.ts`'s `JsonlReader`:
```typescript
  queryRawTurnsForTool(since: number): RawTurnForTool[] {
    return this.filter(since).map((t) => ({
      uuid: t.uuid,
      outputTokens: t.outputTokens,
      costUsd: t.costUsd,
      message: t.contentJson,
    }));
  }
```

And to `createSqliteReader` in db.ts:
```typescript
    queryRawTurnsForTool: (since) => queryRawTurnsForTool(db, since),
```

Also add `RawTurnForTool` to the re-export list in `src/reader.ts`.

With that done, `src/reports/tool.ts` becomes:

```typescript
import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatPct, truncate, bold } from "@/format";
import { parseContentBlocks, resolveDominantTool, categorizeBashCommand } from "@/parse";

interface Options { since: number; limit: number; json: boolean }

export function renderToolDrillDown(reader: Reader, toolName: string, opts: Options): void {
  const normalizedName = toolName.charAt(0).toUpperCase() + toolName.slice(1).toLowerCase();
  const allTurns = reader.queryRawTurnsForTool(opts.since);
  const allTotals = reader.querySummaryTotals(opts.since);

  const toolTurns = allTurns.filter((t) => resolveDominantTool(parseContentBlocks(t.message)).toLowerCase() === toolName.toLowerCase());

  if (toolTurns.length === 0) {
    console.log(`No turns found for tool "${normalizedName}" in the last ${opts.since}.`);
    return;
  }

  const totalOutput = toolTurns.reduce((s, t) => s + t.outputTokens, 0);
  const totalCost = toolTurns.reduce((s, t) => s + (t.costUsd ?? 0), 0);
  const sorted = [...toolTurns].sort((a, b) => a.outputTokens - b.outputTokens);
  const p50 = sorted[Math.floor(sorted.length * 0.5)]?.outputTokens ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]?.outputTokens ?? 0;
  const shareOutput = allTotals.totalOutputTokens > 0 ? (totalOutput / allTotals.totalOutputTokens) * 100 : 0;
  const shareCost = (allTotals.totalCostUsd ?? 0) > 0 ? (totalCost / (allTotals.totalCostUsd ?? 1)) * 100 : 0;

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "tool", toolName: normalizedName,
      overview: { turns: toolTurns.length, totalOutputTokens: totalOutput, totalCostUsd: totalCost, shareOutputPct: shareOutput, shareCostPct: shareCost },
    }, null, 2));
    return;
  }

  console.log(renderHeader(`token-scope — Tool: ${bold(normalizedName)}`));
  console.log(renderKV([
    ["Turns (dominant)", String(toolTurns.length)],
    ["Total Output Tokens", formatTokens(totalOutput)],
    ["Total Cost", formatUsd(totalCost)],
    ["Share of All Output", formatPct(shareOutput)],
    ["Share of All Cost", formatPct(shareCost)],
    ["Avg Output / Turn", formatTokens(totalOutput / toolTurns.length)],
    ["Distribution (p50/p95/max)", `${formatTokens(p50)} / ${formatTokens(p95)} / ${formatTokens(sorted.at(-1)?.outputTokens)}`],
  ]));

  if (toolName.toLowerCase() === "bash") {
    const bashTurns = reader.queryBashTurns(opts.since);
    const categories = new Map<string, { turns: number; outputTokens: number; costUsd: number }>();
    for (const t of bashTurns) {
      const cat = categorizeBashCommand(t.command ?? "");
      const e = categories.get(cat) ?? { turns: 0, outputTokens: 0, costUsd: 0 };
      categories.set(cat, { turns: e.turns + 1, outputTokens: e.outputTokens + t.outputTokens, costUsd: e.costUsd + (t.costUsd ?? 0) });
    }

    const catRows = Array.from(categories.entries())
      .sort((a, b) => b[1].outputTokens - a[1].outputTokens)
      .map(([cat, d]) => [cat, String(d.turns), formatTokens(d.outputTokens), formatTokens(d.outputTokens / d.turns), formatUsd(d.costUsd)]);

    console.log(`\n${bold("  Command Categories")}`);
    console.log(renderTable(
      [
        { header: "Category", align: "left" },
        { header: "Turns", align: "right", width: 7 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Avg/Turn", align: "right", width: 10 },
        { header: "Total Cost", align: "right", width: 11 },
      ],
      catRows
    ));

    const topCommands = [...bashTurns].sort((a, b) => b.outputTokens - a.outputTokens).slice(0, opts.limit);
    console.log(`\n${bold("  Most Expensive Commands")}`);
    console.log(renderTable(
      [
        { header: "Command", align: "left", width: 60 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Cost", align: "right", width: 10 },
      ],
      topCommands.map((t) => [truncate(t.command ?? "(none)", 60), formatTokens(t.outputTokens), formatUsd(t.costUsd)])
    ));
  }

  console.log("");
}
```

- [ ] **Step 3: Update `src/reports/project.ts`**

```typescript
import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatTimestamp, bold } from "@/format";

interface Options { since: number; limit: number; json: boolean }

export function renderProjectDrillDown(reader: Reader, fragment: string, opts: Options): void {
  const matches = reader.queryProjectMatches(fragment);

  if (matches.length === 0) {
    console.log(`No projects found matching "${fragment}".`);
    return;
  }

  if (matches.length > 1) {
    console.log(`Multiple projects match "${fragment}":`);
    matches.forEach((m, i) => console.log(`  ${i + 1}. ${m.cwd}`));
    console.log("Re-run with a more specific fragment.");
    return;
  }

  const cwd = matches[0]!.cwd;
  const allProjects = reader.queryByProject(opts.since, 1000);
  const project = allProjects.find((p) => p.cwd === cwd);

  if (!project) {
    console.log(`No data for project "${cwd}" in the last ${opts.since}.`);
    return;
  }

  const sessions = reader.querySessions(opts.since, opts.limit).filter((s) => s.cwd === cwd);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "project", cwd, project, sessions,
    }, null, 2));
    return;
  }

  console.log(renderHeader(`token-scope — Project: ${cwd}`));
  console.log(renderKV([
    ["Sessions", String(project.sessions)],
    ["Turns", String(project.turns)],
    ["Output Tokens", formatTokens(project.outputTokens)],
    ["Total Cost", formatUsd(project.totalCostUsd)],
    ["Avg Session Cost", formatUsd(project.avgSessionCost)],
  ]));

  if (sessions.length > 0) {
    console.log(`\n${bold("  Recent Sessions")}`);
    console.log(renderTable(
      [
        { header: "Session ID", align: "left", width: 12 },
        { header: "Started", align: "left", width: 18 },
        { header: "Turns", align: "right", width: 7 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Cost", align: "right", width: 10 },
      ],
      sessions.map((s) => [s.sessionId.slice(0, 12), formatTimestamp(s.startedAt), String(s.turnCount), formatTokens(s.outputTokens), formatUsd(s.totalCostUsd)])
    ));
  }

  console.log("");
}
```

- [ ] **Step 4: Update `src/reports/session.ts`**

```typescript
import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatUsd, formatPct, formatDuration, formatTimestamp, approx, truncate, bold, dim } from "@/format";
import { parseContentBlocks, resolveDominantTool, estimateThinkingTokens } from "@/parse";

interface Options { since: number; limit: number; json: boolean }

export function renderSessionView(reader: Reader, sessionId: string, json: boolean, sinceStr: string): void {
  const allSessions = reader.querySessions(0, 10000);
  const matching = allSessions.filter((s) => s.sessionId.startsWith(sessionId));

  if (matching.length === 0) {
    console.log(`No session found with ID starting with "${sessionId}".`);
    return;
  }
  if (matching.length > 1) {
    console.log(`Multiple sessions match "${sessionId}":`);
    matching.forEach((s) => console.log(`  ${s.sessionId.slice(0, 16)} — ${s.cwd ?? "(unknown)"}`));
    console.log("Use a longer prefix.");
    return;
  }

  const session = matching[0]!;
  const turns = reader.querySessionTurns(session.sessionId);

  if (turns.length === 0) {
    console.log(`Session "${sessionId}" has no valid turns.`);
    return;
  }

  const peakIdx = turns.reduce((max, t, i) => t.outputTokens > (turns[max]?.outputTokens ?? 0) ? i : max, 0);

  if (json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), token_scope_version: "1.0.0" },
      report: "session", session,
      turns: turns.map((t, i) => {
        const blocks = parseContentBlocks(t.message);
        const { thinking, text } = getThinkingChars(blocks);
        return {
          turn: i + 1, timestamp: t.timestamp,
          dominantTool: resolveDominantTool(blocks),
          outputTokens: t.outputTokens, costUsd: t.costUsd, stopReason: t.stopReason,
          estimatedThinkingTokens: estimateThinkingTokens(thinking, text, t.outputTokens),
        };
      }),
    }, null, 2));
    return;
  }

  if (sinceStr !== "30d") {
    console.log(dim("  Note: --since is ignored for --session (a session is a fixed time range)."));
  }

  const startMs = turns[0]!.timestamp;
  const endMs = turns.at(-1)!.timestamp;

  console.log(renderHeader(`token-scope — Session: ${session.sessionId.slice(0, 16)}…`));
  console.log(renderKV([
    ["Project", session.cwd ?? "(unknown)"],
    ["Started", formatTimestamp(startMs)],
    ["Duration", formatDuration(endMs - startMs)],
    ["Turns", String(turns.length)],
    ["Total Output Tokens", formatTokens(session.outputTokens)],
    ["Total Cost", formatUsd(session.totalCostUsd)],
    ["Peak Turn", `Turn ${peakIdx + 1} (${formatTokens(turns[peakIdx]!.outputTokens)} tokens)`],
  ]));

  let cumulativeTokens = 0;
  let cumulativeCost = 0;

  const rows = turns.map((t, i) => {
    const blocks = parseContentBlocks(t.message);
    const { thinking, text } = getThinkingChars(blocks);
    const thinkingPct = thinking + text > 0 ? approx(formatPct((thinking / (thinking + text)) * 100)) : "—";
    cumulativeTokens += t.outputTokens;
    cumulativeCost += t.costUsd ?? 0;
    const row = [
      String(i + 1), formatTimestamp(t.timestamp), resolveDominantTool(blocks),
      thinkingPct, formatTokens(t.outputTokens), formatTokens(cumulativeTokens),
      formatUsd(t.costUsd), formatUsd(cumulativeCost), t.stopReason ?? "—",
    ];
    return i === peakIdx ? row.map(bold) : row;
  });

  console.log(`\n${bold("  Turn-by-Turn Breakdown")}`);
  console.log(renderTable(
    [
      { header: "#", align: "right", width: 4 },
      { header: "Timestamp", align: "left", width: 14 },
      { header: "Dominant Tool", align: "left", width: 16 },
      { header: "~Think Chars %", align: "right", width: 15 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Cumulative", align: "right", width: 12 },
      { header: "Cost", align: "right", width: 10 },
      { header: "Cumul. Cost", align: "right", width: 12 },
      { header: "Stop", align: "left", width: 10 },
    ],
    rows
  ));
  console.log(renderFootnote("~Think Chars % is a character ratio, not a token ratio (±15–30% error)."));
  console.log(renderFootnote("Peak turn (most output tokens) is shown in bold."));
  console.log("");
}

export function renderSessionsList(reader: Reader, opts: Options): void {
  const sessions = reader.querySessions(opts.since, opts.limit);

  if (opts.json) {
    const total = sessions.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "sessions",
      totals: { session_count: sessions.length, total_cost_usd: total, avg_session_cost_usd: sessions.length > 0 ? total / sessions.length : 0 },
      sessions: sessions.map((s) => ({
        session_id: s.sessionId, cwd: s.cwd, started_at: new Date(s.startedAt).toISOString(),
        duration_ms: s.durationMs, turn_count: s.turnCount, output_tokens: s.outputTokens,
        cache_hit_pct: s.cacheHitPct, total_cost_usd: s.totalCostUsd,
      })),
    }, null, 2));
    return;
  }

  console.log(renderHeader(`token-scope — Sessions  (last ${opts.since})`));
  console.log(renderTable(
    [
      { header: "Session ID", align: "left", width: 14 },
      { header: "Project", align: "left", width: 40 },
      { header: "Started", align: "left", width: 16 },
      { header: "Duration", align: "right", width: 10 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Cache Hit%", align: "right", width: 10 },
      { header: "Cost", align: "right", width: 10 },
    ],
    sessions.map((s) => [
      s.sessionId.slice(0, 14), truncate(s.cwd ?? "(unknown)", 40), formatTimestamp(s.startedAt),
      formatDuration(s.durationMs), String(s.turnCount), formatTokens(s.outputTokens),
      formatPct(s.cacheHitPct), formatUsd(s.totalCostUsd),
    ])
  ));

  const totalCost = sessions.reduce((sum, s) => sum + (s.totalCostUsd ?? 0), 0);
  const avgCost = sessions.length > 0 ? totalCost / sessions.length : 0;
  console.log(dim(`\n  Showing ${sessions.length} sessions  |  Total cost: ${formatUsd(totalCost)}  |  Avg: ${formatUsd(avgCost)}`));
  console.log("");
}

function getThinkingChars(blocks: ReturnType<typeof parseContentBlocks>) {
  let thinking = 0, text = 0;
  for (const b of blocks) {
    if (b.type === "thinking") thinking += (b.thinking ?? "").length;
    else if (b.type === "text") text += (b.text ?? "").length;
  }
  return { thinking, text };
}
```

- [ ] **Step 5: Update `src/reports/thinking.ts`**

```typescript
import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatUsd, formatPct, formatTimestamp, approx, bold, dim } from "@/format";
import { estimateThinkingTokens, parseContentBlocks, resolveDominantTool } from "@/parse";

interface Options { since: number; limit: number; json: boolean }

export function renderThinkingReport(reader: Reader, opts: Options): void {
  const thinkingTurns = reader.queryThinkingTurns(opts.since);
  const totals = reader.querySummaryTotals(opts.since);
  const allSessions = reader.querySessions(opts.since, 10000);

  const sessionIdsWithThinking = new Set(thinkingTurns.map((t) => t.sessionId));
  const sessionsWithThinking = allSessions.filter((s) => sessionIdsWithThinking.has(s.sessionId));
  const sessionsWithout = allSessions.filter((s) => !sessionIdsWithThinking.has(s.sessionId));

  let totalEstThinking = 0;
  let totalThinkingChars = 0;
  let totalTextChars = 0;

  const enriched = thinkingTurns.map((t) => {
    const est = estimateThinkingTokens(t.thinkingChars, t.textChars, t.outputTokens) ?? 0;
    totalEstThinking += est;
    totalThinkingChars += t.thinkingChars;
    totalTextChars += t.textChars;
    return { ...t, estimatedThinkingTokens: est, dominantTool: resolveDominantTool(parseContentBlocks(t.message)) };
  });

  const thinkingPctOfOutput = totals.totalOutputTokens > 0 ? (totalEstThinking / totals.totalOutputTokens) * 100 : 0;

  const byTool = new Map<string, { turns: number; estThinking: number }>();
  for (const t of enriched) {
    const e = byTool.get(t.dominantTool) ?? { turns: 0, estThinking: 0 };
    byTool.set(t.dominantTool, { turns: e.turns + 1, estThinking: e.estThinking + t.estimatedThinkingTokens });
  }

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "thinking",
      overview: {
        estimated_thinking_tokens: totalEstThinking,
        thinking_pct_of_output: thinkingPctOfOutput,
        turns_with_thinking: thinkingTurns.length,
        turns_with_thinking_pct: totals.turnCount > 0 ? (thinkingTurns.length / totals.turnCount) * 100 : 0,
        sessions_with_thinking: sessionsWithThinking.length,
      },
      character_distribution: {
        thinking_chars: totalThinkingChars, text_chars: totalTextChars,
        thinking_char_pct: totalThinkingChars + totalTextChars > 0 ? (totalThinkingChars / (totalThinkingChars + totalTextChars)) * 100 : 0,
        estimated_thinking_tokens: totalEstThinking,
      },
    }, null, 2));
    return;
  }

  console.log(renderHeader("token-scope — Thinking Analysis"));
  console.log(renderKV([
    ["~Total Thinking Tokens (est)", approx(formatTokens(totalEstThinking))],
    ["~Thinking % of Output", approx(formatPct(thinkingPctOfOutput))],
    ["Turns with Thinking", `${thinkingTurns.length} (${formatPct(totals.turnCount > 0 ? thinkingTurns.length / totals.turnCount * 100 : 0)} of all turns)`],
    ["Sessions with Thinking", `${sessionsWithThinking.length} (${formatPct(allSessions.length > 0 ? sessionsWithThinking.length / allSessions.length * 100 : 0)})`],
  ]));
  console.log(renderFootnote("Thinking token counts are character-ratio estimates (±15–30% error). Prefixed with ~ throughout."));

  const totalChars = totalThinkingChars + totalTextChars;
  if (totalChars > 0) {
    console.log(`\n${bold("  Content Character Distribution")} ${dim("(character proxy, not a token split)")}`);
    console.log(renderTable(
      [
        { header: "Content Block Type", align: "left", width: 20 },
        { header: "Total Characters", align: "right", width: 18 },
        { header: "Char %", align: "right", width: 8 },
        { header: "~Token Estimate", align: "right", width: 16 },
      ],
      [
        ["thinking", formatTokens(totalThinkingChars), formatPct(totalThinkingChars / totalChars * 100), approx(formatTokens(totalEstThinking))],
        ["text", formatTokens(totalTextChars), formatPct(totalTextChars / totalChars * 100), approx(formatTokens(totals.totalOutputTokens - totalEstThinking))],
      ]
    ));
    console.log(renderFootnote("tool_use block JSON contributes to output_tokens but is excluded from this panel."));
  }

  const toolRows = Array.from(byTool.entries()).sort((a, b) => b[1].estThinking - a[1].estThinking).slice(0, opts.limit);
  if (toolRows.length > 0) {
    console.log(`\n${bold("  By Co-occurring Tool")}`);
    console.log(renderTable(
      [
        { header: "Co-occurring Tool", align: "left", width: 20 },
        { header: "Thinking Turns", align: "right", width: 15 },
        { header: "~Avg Thinking Tokens", align: "right", width: 21 },
        { header: "~Total Thinking Tokens", align: "right", width: 22 },
      ],
      toolRows.map(([tool, d]) => [tool, String(d.turns), approx(formatTokens(d.estThinking / d.turns)), approx(formatTokens(d.estThinking))])
    ));
  }

  const avgOutput = (ss: typeof allSessions) => ss.length > 0 ? ss.reduce((s, r) => s + r.outputTokens, 0) / ss.length : 0;
  const avgCost = (ss: typeof allSessions) => ss.length > 0 ? ss.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0) / ss.length : 0;
  const avgTurns = (ss: typeof allSessions) => ss.length > 0 ? ss.reduce((s, r) => s + r.turnCount, 0) / ss.length : 0;

  console.log(`\n${bold("  Session Comparison")}`);
  console.log(renderTable(
    [
      { header: "Metric", align: "left", width: 22 },
      { header: "Thinking Sessions", align: "right", width: 19 },
      { header: "Non-Thinking Sessions", align: "right", width: 22 },
    ],
    [
      ["Count", String(sessionsWithThinking.length), String(sessionsWithout.length)],
      ["Avg Output Tokens", formatTokens(avgOutput(sessionsWithThinking)), formatTokens(avgOutput(sessionsWithout))],
      ["Avg Cost", formatUsd(avgCost(sessionsWithThinking)), formatUsd(avgCost(sessionsWithout))],
      ["Avg Turns", String(Math.round(avgTurns(sessionsWithThinking))), String(Math.round(avgTurns(sessionsWithout)))],
    ]
  ));

  const top10 = [...enriched].sort((a, b) => b.estimatedThinkingTokens - a.estimatedThinkingTokens).slice(0, 10);
  if (top10.length > 0) {
    console.log(`\n${bold("  Top Thinking Turns")}`);
    console.log(renderTable(
      [
        { header: "Session", align: "left", width: 12 },
        { header: "Project", align: "left", width: 25 },
        { header: "Timestamp", align: "left", width: 16 },
        { header: "~Thinking Tokens", align: "right", width: 17 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Cost", align: "right", width: 10 },
      ],
      top10.map((t) => [
        t.sessionId.slice(0, 12), (t.cwd ?? "(unknown)").split("/").at(-1) ?? "(unknown)",
        formatTimestamp(t.timestamp), approx(formatTokens(t.estimatedThinkingTokens)),
        formatTokens(t.outputTokens), formatUsd(t.costUsd),
      ])
    ));
  }

  console.log("");
}
```

- [ ] **Step 6: Update `src/reader.ts` to add `queryRawTurnsForTool`**

Add `RawTurnForTool` to the re-export and add the method to the `Reader` interface:

```typescript
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
```

Also add `queryRawTurnsForTool` to `JsonlReader` and `createSqliteReader` as described above.

- [ ] **Step 7: Run tests + typecheck**

```bash
bun test && bun run tsc --noEmit
```

Expected: all 57+ tests pass, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/reports/ src/reader.ts src/jsonl.ts src/db.ts
git commit -m "Update all reports to accept Reader interface; add queryRawTurnsForTool to Reader"
```

---

## Task 7: Update `tests/reports.test.ts` + Integration Tests

**Files:**
- Modify: `tests/reports.test.ts`

The existing `reports.test.ts` imports `openDb` and `resolveDbPath` from `@/db` and passes a `Database` directly to report functions. After Task 6, reports accept `Reader` instead. Update the test to use `createReader()`.

- [ ] **Step 1: Update `tests/reports.test.ts`**

Replace the top of the file (imports, db setup, beforeAll/afterAll) with:

```typescript
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createReader } from "@/reader";
import type { Reader } from "@/reader";
import { renderSummary } from "@/reports/summary";
import { renderToolDrillDown } from "@/reports/tool";
import { renderProjectDrillDown } from "@/reports/project";
import { renderSessionView, renderSessionsList } from "@/reports/session";
import { renderThinkingReport } from "@/reports/thinking";

let reader: Reader;
const opts = { since: 0, limit: 20, json: false };

beforeAll(() => { reader = createReader({ source: "sqlite" }); });
afterAll(() => { reader.close(); });
```

Then update all report calls from `(db, ...)` to `(reader, ...)`:
- `renderSummary(db, opts)` → `renderSummary(reader, opts)`
- `renderToolDrillDown(db, "bash", opts)` → `renderToolDrillDown(reader, "bash", opts)`
- `renderProjectDrillDown(db, "token-scope", opts)` → `renderProjectDrillDown(reader, "token-scope", opts)`
- `renderSessionView(db, "sess-a1", false, "30d")` → `renderSessionView(reader, "sess-a1", false, "30d")`
- `renderSessionsList(db, opts)` → `renderSessionsList(reader, opts)`
- `renderThinkingReport(db, opts)` → `renderThinkingReport(reader, opts)`

Also update the `capture()` helper invocations to use `reader` instead of `db`.

- [ ] **Step 2: Run existing report tests against SQLite source**

Run: `bun test tests/reports.test.ts`
Expected: 16 pass (SQLite source, same fixture DB as before).

- [ ] **Step 3: Add JSONL report smoke tests**

Add a second describe block at the end of `tests/reports.test.ts`:

```typescript
describe("Reports via JSONL reader", () => {
  let jsonlReader: Reader;
  beforeAll(() => { jsonlReader = createReader({ source: "jsonl" }); });
  afterAll(() => { jsonlReader.close(); });

  it("summary renders without throwing via JSONL", () => {
    expect(() => renderSummary(jsonlReader, opts)).not.toThrow();
  });

  it("summary JSON has byTool array via JSONL", () => {
    const output = capture(() => renderSummary(jsonlReader, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("summary");
    expect(Array.isArray(parsed.byTool)).toBe(true);
  });

  it("session view renders sess-j1 via JSONL", () => {
    expect(() => renderSessionView(jsonlReader, "sess-j1", false, "30d")).not.toThrow();
  });

  it("session view JSON for sess-j1 has 3 turns via JSONL", () => {
    const output = capture(() => renderSessionView(jsonlReader, "sess-j1", true, "30d"));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("session");
    expect(parsed.turns.length).toBe(3);
  });
});
```

Run: `bun test tests/reports.test.ts`
Expected: 20 pass (16 SQLite + 4 JSONL).

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: 75+ pass, 0 fail.

- [ ] **Step 5: End-to-end smoke test against real data**

```bash
cd ~/ML-AI/token-scope && export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
bun run src/cli.ts --since 400d 2>&1 | head -30
bun run src/cli.ts --source sqlite --since 400d 2>&1 | head -5
bun run src/cli.ts --tool edit --since 400d 2>&1 | head -15
bun run src/cli.ts --sessions --since 400d 2>&1 | head -15
```

Expected:
- Default (JSONL): shows 1397 sessions, 13000+ turns from `~/.claude/projects/`
- `--source sqlite`: shows 4 sessions from `~/.claude/__store.db`
- `--tool edit`: shows Edit tool breakdown from JSONL
- `--sessions`: shows recent sessions from JSONL

- [ ] **Step 6: Typecheck final**

Run: `bun run tsc --noEmit`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add tests/reports.test.ts
git commit -m "Update reports tests for Reader interface; add JSONL smoke tests (20 tests total)"
```

---

## Self-Review

### Spec Coverage

| Requirement | Task |
|-------------|------|
| JSONL as primary source | Task 3 `JsonlReader` |
| SQLite as secondary fallback | Task 4 `createSqliteReader` |
| Auto-detect source | Task 1 `createReader` with `hasJsonlData` |
| `--source` flag | Task 5 cli.ts |
| `TOKEN_SCOPE_PROJECTS_DIR` env override | Task 1 `resolveProjectsDir` |
| Cost computed from pricing (JSONL has no costUSD) | Task 3 `computeCost` |
| Missing model IDs in pricing table | Task 1 pricing.ts |
| `queryRawTurnsForTool` on Reader interface | Task 6 |
| All 5 reports accept `Reader` | Task 6 |
| JSONL fixture for tests | Task 2 |
| JSONL reader tests | Task 3 |
| SQLite adapter tests | Task 4 |
| Report tests updated to use Reader | Task 7 |
| JSONL smoke tests in reports.test.ts | Task 7 |

### No Placeholders Check

All steps contain complete code. No TBDs or "add validation" patterns.

### Type Consistency

- `Reader` interface defined in Task 1, used consistently in Tasks 3-7
- `queryRawTurnsForTool` added to `Reader` in Task 6 and back-applied to `JsonlReader` and `createSqliteReader`
- `RawTurnForTool` re-exported from `reader.ts` in Task 6
- `TurnRow.message` field holds JSON string in both SQLite and JSONL paths — compatible with `parseContentBlocks()`
