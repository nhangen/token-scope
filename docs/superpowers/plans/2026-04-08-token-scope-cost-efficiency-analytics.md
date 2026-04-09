# token-scope Phase 2: Cost Efficiency Analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four cost efficiency analytics reports to token-scope: context bloat detection, cache efficiency, session efficiency, and an enhanced thinking breakdown — all accessible as new CLI flags.

**Architecture:** Add two new Reader interface methods (`queryContextStats`, `queryCacheStats`) with implementations in both `JsonlReader` (in-memory) and `createSqliteReader` (SQL window functions + CTEs). Create three new report modules and enhance one existing one. Wire all four into `cli.ts` as new mode flags.

**Tech Stack:** Bun, TypeScript, bun:test, bun:sqlite, existing `Reader` interface pattern, `computeCacheSavings` from `pricing.ts`, `renderTable`/`renderKV`/`renderHeader` from `format.ts`.

---

## File Map

**Create:**
- `tests/fixtures/projects/-Users-alice-projects-beacon/sess-j4.jsonl` — 7-turn bloat fixture (growing input tokens)
- `src/reports/context.ts` — `--context` report (sessions ranked by context bloat ratio)
- `src/reports/cache.ts` — `--cache` report (per-project cache hit % and estimated savings)
- `src/reports/efficiency.ts` — `--efficiency` report (per-turn cost bucketed by session length)

**Modify:**
- `src/db.ts` — add `ContextStatRow`, `CacheStatRow` types; `queryContextStats`, `queryCacheStats` functions; update `SqliteReaderInterface` and `createSqliteReader`
- `src/reader.ts` — add `queryContextStats`, `queryCacheStats` to `Reader` interface; re-export new types
- `src/jsonl.ts` — implement `queryContextStats`, `queryCacheStats` in `JsonlReader`
- `src/cli.ts` — add `--context`, `--cache`, `--efficiency` modes
- `src/reports/thinking.ts` — add per-project thinking breakdown section
- `tests/jsonl.test.ts` — add tests for new Reader methods; update fixture counts
- `tests/reports.test.ts` — add smoke tests for all four new/enhanced reports

---

## Task 1: Add ContextStatRow + CacheStatRow Types and Reader Interface Methods

**Files:**
- Modify: `src/db.ts`
- Modify: `src/reader.ts`

- [ ] **Step 1: Add types to `src/db.ts`**

Add after the `RawTurnForTool` interface (line ~104):

```typescript
export interface ContextStatRow {
  sessionId: string;
  cwd: string | null;
  turnCount: number;
  avgEarlyInput: number;   // avg input tokens of first 3 turns
  avgLateInput: number;    // avg input tokens of last 3 turns
  bloatRatio: number | null; // avgLateInput / avgEarlyInput; null if avgEarlyInput === 0
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
```

- [ ] **Step 2: Add methods to `Reader` interface in `src/reader.ts`**

In the `import type { ... } from "@/db"` block, add `ContextStatRow, CacheStatRow` to the import.

In the `export type { ... }` re-export line, add `ContextStatRow, CacheStatRow`.

In the `Reader` interface, add after `queryProjectMatches`:

```typescript
queryContextStats(since: number, limit: number): ContextStatRow[];
queryCacheStats(since: number, limit: number): CacheStatRow[];
```

- [ ] **Step 3: Run typecheck to confirm shape is visible**

Run: `bun tsc --noEmit`
Expected: errors about unimplemented methods on `JsonlReader` and `SqliteReaderInterface` — those are expected at this stage.

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/reader.ts
git commit -m "feat: add ContextStatRow, CacheStatRow types and Reader interface methods"
```

---

## Task 2: Fixture + queryContextStats Implementation + Tests

**Files:**
- Create: `tests/fixtures/projects/-Users-alice-projects-beacon/sess-j4.jsonl`
- Modify: `src/db.ts` (add `queryContextStats` function + update `SqliteReaderInterface` + `createSqliteReader`)
- Modify: `src/jsonl.ts` (add `queryContextStats` method to `JsonlReader`)
- Modify: `tests/jsonl.test.ts` (add tests + update counts)

- [ ] **Step 1: Write the failing tests**

In `tests/jsonl.test.ts`, add after the `"close"` describe block:

```typescript
describe("JsonlReader — context stats", () => {
  it("returns sessions with 6+ turns", () => {
    const rows = reader.queryContextStats(0, 20);
    expect(rows.length).toBe(1);
    expect(rows[0]!.sessionId).toBe("sess-j4");
  });

  it("sess-j4 has correct turnCount", () => {
    const rows = reader.queryContextStats(0, 20);
    expect(rows[0]!.turnCount).toBe(7);
  });

  it("avgEarlyInput is average of first 3 turns", () => {
    const rows = reader.queryContextStats(0, 20);
    // sess-j4 first 3 turns: 1000, 1200, 1400 → avg 1200
    expect(rows[0]!.avgEarlyInput).toBeCloseTo(1200, 0);
  });

  it("avgLateInput is average of last 3 turns", () => {
    const rows = reader.queryContextStats(0, 20);
    // sess-j4 last 3 turns: 6000, 8000, 9500 → avg 7833.33
    expect(rows[0]!.avgLateInput).toBeCloseTo(7833, 0);
  });

  it("bloatRatio is avgLateInput / avgEarlyInput", () => {
    const rows = reader.queryContextStats(0, 20);
    // 7833.33 / 1200 ≈ 6.53
    expect(rows[0]!.bloatRatio).toBeCloseTo(6.5, 0);
  });

  it("returns empty for since that excludes sess-j4", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const rows = reader.queryContextStats(future, 20);
    expect(rows.length).toBe(0);
  });
});
```

Also update the three count-based tests that will change when sess-j4 is added:

```typescript
// In "counts all turns with since=0" → change 6 to 13
expect(totals.turnCount).toBe(13);

// In "counts sessions with since=0" → change 3 to 4
expect(totals.sessionCount).toBe(4);

// In "sums output tokens with since=0" → change 2050 to 2750
// (sess-j4 has 7 × 100 = 700 output tokens)
expect(totals.totalOutputTokens).toBe(2750);

// In "excludes old session with 30d window" → change 5/2 to 12/3
expect(totals.turnCount).toBe(12);
expect(totals.sessionCount).toBe(3);

// In "returns 3 sessions with since=0" → change 3 to 4
expect(sessions.length).toBe(4);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/jsonl.test.ts`
Expected: FAIL — context stats describe block fails with "not a function"

- [ ] **Step 3: Create the fixture file**

Create `tests/fixtures/projects/-Users-alice-projects-beacon/sess-j4.jsonl` with this content (7 lines, one per turn, showing growing input tokens):

```
{"type":"assistant","uuid":"j4-t1","parentUuid":null,"sessionId":"sess-j4","cwd":"/Users/alice/projects/beacon","timestamp":"2026-04-03T08:00:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j4t1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/a.ts"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":5000,"cache_creation_input_tokens":1000}}}
{"type":"assistant","uuid":"j4-t2","parentUuid":"j4-t1","sessionId":"sess-j4","cwd":"/Users/alice/projects/beacon","timestamp":"2026-04-03T08:01:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j4t2","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu2","name":"Read","input":{"file_path":"/b.ts"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1200,"output_tokens":100,"cache_read_input_tokens":15000,"cache_creation_input_tokens":0}}}
{"type":"assistant","uuid":"j4-t3","parentUuid":"j4-t2","sessionId":"sess-j4","cwd":"/Users/alice/projects/beacon","timestamp":"2026-04-03T08:02:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j4t3","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu3","name":"Grep","input":{"pattern":"foo"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":1400,"output_tokens":100,"cache_read_input_tokens":20000,"cache_creation_input_tokens":0}}}
{"type":"assistant","uuid":"j4-t4","parentUuid":"j4-t3","sessionId":"sess-j4","cwd":"/Users/alice/projects/beacon","timestamp":"2026-04-03T08:03:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j4t4","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu4","name":"Read","input":{"file_path":"/c.ts"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":3500,"output_tokens":100,"cache_read_input_tokens":25000,"cache_creation_input_tokens":0}}}
{"type":"assistant","uuid":"j4-t5","parentUuid":"j4-t4","sessionId":"sess-j4","cwd":"/Users/alice/projects/beacon","timestamp":"2026-04-03T08:04:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j4t5","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu5","name":"Edit","input":{"file_path":"/c.ts","old_string":"a","new_string":"b"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":6000,"output_tokens":100,"cache_read_input_tokens":28000,"cache_creation_input_tokens":0}}}
{"type":"assistant","uuid":"j4-t6","parentUuid":"j4-t5","sessionId":"sess-j4","cwd":"/Users/alice/projects/beacon","timestamp":"2026-04-03T08:05:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j4t6","type":"message","role":"assistant","content":[{"type":"tool_use","id":"tu6","name":"Read","input":{"file_path":"/d.ts"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":8000,"output_tokens":100,"cache_read_input_tokens":32000,"cache_creation_input_tokens":0}}}
{"type":"assistant","uuid":"j4-t7","parentUuid":"j4-t6","sessionId":"sess-j4","cwd":"/Users/alice/projects/beacon","timestamp":"2026-04-03T08:06:00.000Z","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"model":"claude-sonnet-4-6","id":"msg-j4t7","type":"message","role":"assistant","content":[{"type":"text","text":"Done."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":9500,"output_tokens":100,"cache_read_input_tokens":35000,"cache_creation_input_tokens":0}}}
```

- [ ] **Step 4: Implement `queryContextStats` in `JsonlReader` (`src/jsonl.ts`)**

Add this import at the top: `import type { ContextStatRow } from "@/reader";` (add `ContextStatRow` to the existing import block).

Add after `queryProjectMatches` (before `close`):

```typescript
queryContextStats(since: number, limit: number): ContextStatRow[] {
  const turns = this.filter(since);
  const bySession = new Map<string, { cwd: string; turns: JsonlTurn[] }>();
  for (const t of turns) {
    const e = bySession.get(t.sessionId) ?? { cwd: t.cwd, turns: [] };
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
    rows.push({ sessionId, cwd: d.cwd, turnCount: d.turns.length, avgEarlyInput, avgLateInput, bloatRatio });
  }
  return rows.sort((a, b) => (b.bloatRatio ?? 0) - (a.bloatRatio ?? 0)).slice(0, limit);
}
```

- [ ] **Step 5: Implement `queryContextStats` in `src/db.ts`**

Add the following function before `createSqliteReader`:

```typescript
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
```

Update `SqliteReaderInterface` (add after `queryProjectMatches`):

```typescript
queryContextStats(since: number, limit: number): ContextStatRow[];
```

Update `createSqliteReader` (add after `queryProjectMatches` binding):

```typescript
queryContextStats: (since, limit) => queryContextStats(db, since, limit),
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/jsonl.test.ts`
Expected: All tests pass, including new context stats describe block.

- [ ] **Step 7: Run typecheck**

Run: `bun tsc --noEmit`
Expected: Only errors about missing `queryCacheStats` (expected — next task).

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/projects/-Users-alice-projects-beacon/sess-j4.jsonl src/db.ts src/jsonl.ts tests/jsonl.test.ts
git commit -m "feat: add queryContextStats with bloat fixture and JsonlReader + SQLite implementations"
```

---

## Task 3: queryCacheStats Implementation + Tests

**Files:**
- Modify: `src/db.ts` (add `queryCacheStats` function + update `SqliteReaderInterface` + `createSqliteReader`)
- Modify: `src/jsonl.ts` (add `queryCacheStats` method)
- Modify: `tests/jsonl.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

In `tests/jsonl.test.ts`, add after the context stats describe block:

```typescript
describe("JsonlReader — cache stats", () => {
  it("returns a row for each project", () => {
    const rows = reader.queryCacheStats(0, 20);
    expect(rows.length).toBe(3);
  });

  it("beacon project has correct sessions count", () => {
    const rows = reader.queryCacheStats(0, 20);
    const beacon = rows.find((r) => r.cwd.includes("beacon"));
    // sess-j3 (1 turn) + sess-j4 (7 turns) = 2 sessions
    expect(beacon?.sessions).toBe(2);
  });

  it("beacon project totalCacheReadTokens is correct", () => {
    const rows = reader.queryCacheStats(0, 20);
    const beacon = rows.find((r) => r.cwd.includes("beacon"));
    // j3: 5000 + j4: 5000+15000+20000+25000+28000+32000+35000 = 165000 → total 170000
    expect(beacon?.totalCacheReadTokens).toBe(170000);
  });

  it("cacheHitPct is between 0 and 100", () => {
    const rows = reader.queryCacheStats(0, 20);
    for (const r of rows) {
      if (r.cacheHitPct !== null) {
        expect(r.cacheHitPct).toBeGreaterThan(0);
        expect(r.cacheHitPct).toBeLessThanOrEqual(100);
      }
    }
  });

  it("estimatedSavingsUsd is positive for projects with cache reads", () => {
    const rows = reader.queryCacheStats(0, 20);
    const withReads = rows.filter((r) => r.totalCacheReadTokens > 0);
    for (const r of withReads) {
      expect(r.estimatedSavingsUsd).not.toBeNull();
      expect(r.estimatedSavingsUsd!).toBeGreaterThan(0);
    }
  });

  it("rows are sorted by estimatedSavingsUsd desc", () => {
    const rows = reader.queryCacheStats(0, 20);
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i]!.estimatedSavingsUsd ?? 0).toBeGreaterThanOrEqual(rows[i + 1]!.estimatedSavingsUsd ?? 0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/jsonl.test.ts`
Expected: FAIL — "queryCacheStats is not a function"

- [ ] **Step 3: Implement `queryCacheStats` in `JsonlReader` (`src/jsonl.ts`)**

Add `CacheStatRow` to the import from `@/reader`. Add `computeCacheSavings` to the import from `@/pricing`.

Add after `queryContextStats`:

```typescript
queryCacheStats(since: number, limit: number): CacheStatRow[] {
  const turns = this.filter(since);
  const byProject = new Map<string, {
    sessions: Set<string>; turns: number;
    totalInputTokens: number; totalCacheReadTokens: number; totalCacheWriteTokens: number;
    savings: number;
  }>();
  for (const t of turns) {
    const e = byProject.get(t.cwd) ?? {
      sessions: new Set(), turns: 0,
      totalInputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
      savings: 0,
    };
    e.sessions.add(t.sessionId);
    e.turns++;
    e.totalInputTokens += t.inputTokens;
    e.totalCacheReadTokens += t.cacheReadTokens;
    e.totalCacheWriteTokens += t.cacheWriteTokens;
    const s = computeCacheSavings(t.model, t.cacheReadTokens);
    if (s !== null) e.savings += s;
    byProject.set(t.cwd, e);
  }
  return Array.from(byProject.entries())
    .map(([cwd, d]) => ({
      cwd,
      sessions: d.sessions.size,
      turns: d.turns,
      totalInputTokens: d.totalInputTokens,
      totalCacheReadTokens: d.totalCacheReadTokens,
      totalCacheWriteTokens: d.totalCacheWriteTokens,
      cacheHitPct: d.totalInputTokens + d.totalCacheReadTokens > 0
        ? (d.totalCacheReadTokens / (d.totalInputTokens + d.totalCacheReadTokens)) * 100 : null,
      estimatedSavingsUsd: d.savings > 0 ? d.savings : null,
    }))
    .sort((a, b) => (b.estimatedSavingsUsd ?? 0) - (a.estimatedSavingsUsd ?? 0))
    .slice(0, limit);
}
```

- [ ] **Step 4: Implement `queryCacheStats` in `src/db.ts`**

Add the following function before `createSqliteReader`:

```typescript
export function queryCacheStats(db: Database, since: number, limit: number): CacheStatRow[] {
  const rows = db.query<{
    cwd: string; sessions: number; turns: number;
    totalInputTokens: number; totalCacheReadTokens: number; totalCacheWriteTokens: number;
    topModel: string | null;
  }, [number, number]>(`
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
      tm.model AS topModel
    FROM raw r
    LEFT JOIN top_model tm ON tm.cwd = r.cwd AND tm.rk = 1
    GROUP BY r.cwd
    ORDER BY totalCacheReadTokens DESC
    LIMIT ?
  `).all(since, limit);

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
  }));
}
```

Update `SqliteReaderInterface` (add after `queryContextStats`):

```typescript
queryCacheStats(since: number, limit: number): CacheStatRow[];
```

Update `createSqliteReader` (add after `queryContextStats` binding):

```typescript
queryCacheStats: (since, limit) => queryCacheStats(db, since, limit),
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/jsonl.test.ts`
Expected: All tests pass, including new cache stats describe block.

- [ ] **Step 6: Run typecheck**

Run: `bun tsc --noEmit`
Expected: No errors (all Reader methods now implemented everywhere).

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/jsonl.ts tests/jsonl.test.ts
git commit -m "feat: add queryCacheStats to JsonlReader and SQLite reader"
```

---

## Task 4: Context Bloat Report + --context Flag

**Files:**
- Create: `src/reports/context.ts`
- Modify: `src/cli.ts`
- Modify: `tests/reports.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/reports.test.ts`, add after the last `describe` block:

```typescript
describe("Context report", () => {
  it("renders without throwing via JSONL", () => {
    expect(() => renderContextReport(jsonlReader, opts)).not.toThrow();
  });

  it("renders valid JSON with rows array via JSONL", () => {
    const output = capture(() => renderContextReport(jsonlReader, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("context");
    expect(Array.isArray(parsed.rows)).toBe(true);
  });
});
```

Also add the import at the top of the file:
```typescript
import { renderContextReport } from "@/reports/context";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/reports.test.ts`
Expected: FAIL — "Cannot find module '@/reports/context'"

- [ ] **Step 3: Create `src/reports/context.ts`**

```typescript
import type { Reader, ContextStatRow } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, bold, dim } from "@/format";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderContextReport(reader: Reader, opts: Options): void {
  const rows = reader.queryContextStats(opts.since, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "context", rows,
    }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No sessions with 6+ turns found in the last ${opts.sinceStr}.`);
    return;
  }

  const sorted = rows.slice().sort((a, b) => (a.bloatRatio ?? 0) - (b.bloatRatio ?? 0));
  const medianRatio = sorted[Math.floor(sorted.length / 2)]?.bloatRatio ?? null;
  const maxRatio = rows[0]?.bloatRatio ?? null;

  console.log(renderHeader("token-scope — Context Bloat Analysis"));
  console.log(renderKV([
    ["Sessions Analyzed", String(rows.length)],
    ["Max Bloat Ratio", maxRatio != null ? `${maxRatio.toFixed(1)}×` : "—"],
    ["Median Bloat Ratio", medianRatio != null ? `${medianRatio.toFixed(1)}×` : "—"],
  ]));

  console.log(`\n${bold("  Sessions Ranked by Bloat")} ${dim("(early = avg of first 3 turns, late = avg of last 3 turns)")}`);
  console.log(renderTable(
    [
      { header: "Session", align: "left", width: 14 },
      { header: "Project", align: "left", width: 25 },
      { header: "Turns", align: "right", width: 6 },
      { header: "Early Avg Input", align: "right", width: 16 },
      { header: "Late Avg Input", align: "right", width: 15 },
      { header: "Bloat", align: "right", width: 8 },
    ],
    rows.map((r) => [
      r.sessionId.slice(0, 14),
      (r.cwd ?? "(unknown)").split("/").at(-1) ?? "(unknown)",
      String(r.turnCount),
      formatTokens(Math.round(r.avgEarlyInput)),
      formatTokens(Math.round(r.avgLateInput)),
      r.bloatRatio != null ? `${r.bloatRatio.toFixed(1)}×` : "—",
    ])
  ));

  console.log("");
}
```

- [ ] **Step 4: Add `--context` to `src/cli.ts`**

In the `CliArgs` interface, change:
```typescript
mode: "summary" | "tool" | "project" | "session" | "thinking" | "sessions";
```
to:
```typescript
mode: "summary" | "tool" | "project" | "session" | "thinking" | "sessions" | "context" | "cache" | "efficiency";
```

In the `HELP` string, add to REPORT MODES:
```
  --context               Sessions ranked by context bloat (input growth over session)
  --cache                 Per-project cache efficiency and estimated savings
  --efficiency            Per-turn cost bucketed by session length
```

In `parseArgs` switch, add three cases before `default`:
```typescript
case "--context": setMode("context"); break;
case "--cache": setMode("cache"); break;
case "--efficiency": setMode("efficiency"); break;
```

In `main()`, add to the switch:
```typescript
case "context": {
  const { renderContextReport } = await import("@/reports/context");
  renderContextReport(reader, options); break;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/reports.test.ts`
Expected: All tests pass, including new context describe block.

- [ ] **Step 6: Run typecheck**

Run: `bun tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/reports/context.ts src/cli.ts tests/reports.test.ts
git commit -m "feat: add --context report for context bloat detection"
```

---

## Task 5: Cache Efficiency Report + --cache Flag

**Files:**
- Create: `src/reports/cache.ts`
- Modify: `src/cli.ts`
- Modify: `tests/reports.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/reports.test.ts`, add after the context describe block:

```typescript
describe("Cache report", () => {
  it("renders without throwing via JSONL", () => {
    expect(() => renderCacheReport(jsonlReader, opts)).not.toThrow();
  });

  it("renders valid JSON with rows array via JSONL", () => {
    const output = capture(() => renderCacheReport(jsonlReader, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("cache");
    expect(Array.isArray(parsed.rows)).toBe(true);
  });

  it("each row has cacheHitPct and estimatedSavingsUsd", () => {
    const output = capture(() => renderCacheReport(jsonlReader, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    for (const row of parsed.rows) {
      expect(row).toHaveProperty("cacheHitPct");
      expect(row).toHaveProperty("estimatedSavingsUsd");
    }
  });
});
```

Add the import at the top:
```typescript
import { renderCacheReport } from "@/reports/cache";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/reports.test.ts`
Expected: FAIL — "Cannot find module '@/reports/cache'"

- [ ] **Step 3: Create `src/reports/cache.ts`**

```typescript
import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatPct, bold } from "@/format";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderCacheReport(reader: Reader, opts: Options): void {
  const rows = reader.queryCacheStats(opts.since, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "cache", rows,
    }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No cache data found in the last ${opts.sinceStr}.`);
    return;
  }

  const totalSavings = rows.reduce((s, r) => s + (r.estimatedSavingsUsd ?? 0), 0);
  const totalCacheRead = rows.reduce((s, r) => s + r.totalCacheReadTokens, 0);
  const totalInput = rows.reduce((s, r) => s + r.totalInputTokens, 0);
  const overallHitPct = totalInput + totalCacheRead > 0
    ? (totalCacheRead / (totalInput + totalCacheRead)) * 100 : null;

  console.log(renderHeader("token-scope — Cache Efficiency"));
  console.log(renderKV([
    ["Projects", String(rows.length)],
    ["Overall Cache Hit %", formatPct(overallHitPct)],
    ["Est. Total Savings", formatUsd(totalSavings > 0 ? totalSavings : null)],
  ]));

  console.log(`\n${bold("  By Project")}`);
  console.log(renderTable(
    [
      { header: "Project", align: "left", width: 30 },
      { header: "Sessions", align: "right", width: 9 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Cache Hit %", align: "right", width: 12 },
      { header: "Cache Reads", align: "right", width: 13 },
      { header: "Est. Savings", align: "right", width: 13 },
    ],
    rows.map((r) => [
      r.cwd.split("/").at(-1) ?? r.cwd,
      String(r.sessions),
      String(r.turns),
      formatPct(r.cacheHitPct),
      formatTokens(r.totalCacheReadTokens),
      formatUsd(r.estimatedSavingsUsd),
    ])
  ));

  console.log("");
}
```

- [ ] **Step 4: Add `--cache` dispatch to `src/cli.ts` `main()`**

```typescript
case "cache": {
  const { renderCacheReport } = await import("@/reports/cache");
  renderCacheReport(reader, options); break;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/reports.test.ts`
Expected: All tests pass, including cache describe block.

- [ ] **Step 6: Run typecheck**

Run: `bun tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/reports/cache.ts src/cli.ts tests/reports.test.ts
git commit -m "feat: add --cache report for per-project cache efficiency"
```

---

## Task 6: Session Efficiency Report + --efficiency Flag

**Files:**
- Create: `src/reports/efficiency.ts`
- Modify: `src/cli.ts`
- Modify: `tests/reports.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/reports.test.ts`, add after the cache describe block:

```typescript
describe("Efficiency report", () => {
  it("renders without throwing via JSONL", () => {
    expect(() => renderEfficiencyReport(jsonlReader, opts)).not.toThrow();
  });

  it("renders valid JSON with buckets array via JSONL", () => {
    const output = capture(() => renderEfficiencyReport(jsonlReader, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("efficiency");
    expect(Array.isArray(parsed.buckets)).toBe(true);
    expect(parsed.buckets.length).toBe(5);
  });

  it("buckets cover 1-5, 6-15, 16-30, 31-50, 51+", () => {
    const output = capture(() => renderEfficiencyReport(jsonlReader, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    const labels = parsed.buckets.map((b: { bucket: string }) => b.bucket);
    expect(labels).toEqual(["1–5", "6–15", "16–30", "31–50", "51+"]);
  });
});
```

Add the import at the top:
```typescript
import { renderEfficiencyReport } from "@/reports/efficiency";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/reports.test.ts`
Expected: FAIL — "Cannot find module '@/reports/efficiency'"

- [ ] **Step 3: Create `src/reports/efficiency.ts`**

```typescript
import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatUsd, bold, dim } from "@/format";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

const BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "1–5",   min: 1,  max: 5 },
  { label: "6–15",  min: 6,  max: 15 },
  { label: "16–30", min: 16, max: 30 },
  { label: "31–50", min: 31, max: 50 },
  { label: "51+",   min: 51, max: Infinity },
];

export function renderEfficiencyReport(reader: Reader, opts: Options): void {
  const sessions = reader.querySessions(opts.since, 100_000);

  const buckets = BUCKETS.map(({ label, min, max }) => {
    const inBucket = sessions.filter((s) => s.turnCount >= min && s.turnCount <= max);
    const totalCost = inBucket.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    const totalTurns = inBucket.reduce((s, r) => s + r.turnCount, 0);
    return {
      bucket: label,
      sessionCount: inBucket.length,
      avgTurns: inBucket.length > 0 ? totalTurns / inBucket.length : null,
      avgSessionCost: inBucket.length > 0 ? totalCost / inBucket.length : null,
      avgPerTurnCost: totalTurns > 0 ? totalCost / totalTurns : null,
    };
  });

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "efficiency", buckets,
    }, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log(`No sessions found in the last ${opts.sinceStr}.`);
    return;
  }

  console.log(renderHeader("token-scope — Session Efficiency"));
  console.log(renderKV([["Total Sessions", String(sessions.length)]]));

  console.log(`\n${bold("  Cost Per Turn by Session Length")} ${dim("(longer sessions accumulate more context, raising per-turn cost)")}`);
  console.log(renderTable(
    [
      { header: "Turn Bucket", align: "left",  width: 12 },
      { header: "Sessions",   align: "right", width: 9 },
      { header: "Avg Turns",  align: "right", width: 10 },
      { header: "Avg Per-Turn Cost", align: "right", width: 18 },
      { header: "Avg Session Cost",  align: "right", width: 17 },
    ],
    buckets.map((b) => [
      b.label,
      String(b.sessionCount),
      b.avgTurns != null ? b.avgTurns.toFixed(1) : "—",
      b.avgPerTurnCost != null ? formatUsd(b.avgPerTurnCost) : "—",
      b.avgSessionCost != null ? formatUsd(b.avgSessionCost) : "—",
    ])
  ));

  console.log("");
}
```

- [ ] **Step 4: Add `--efficiency` dispatch to `src/cli.ts` `main()`**

```typescript
case "efficiency": {
  const { renderEfficiencyReport } = await import("@/reports/efficiency");
  renderEfficiencyReport(reader, options); break;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/reports.test.ts`
Expected: All tests pass, including efficiency describe block.

- [ ] **Step 6: Run typecheck**

Run: `bun tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/reports/efficiency.ts src/cli.ts tests/reports.test.ts
git commit -m "feat: add --efficiency report for per-turn cost by session length"
```

---

## Task 7: Enhance Thinking Report with Per-Project Breakdown

**Files:**
- Modify: `src/reports/thinking.ts`
- Modify: `tests/reports.test.ts`

- [ ] **Step 1: Update the failing test**

In `tests/reports.test.ts`, find the existing thinking JSON test and add the `byProject` assertion:

```typescript
it("renders valid JSON with overview.estimated_thinking_tokens", () => {
  const output = capture(() => renderThinkingReport(reader, { ...opts, json: true }));
  const parsed = JSON.parse(output);
  expect(parsed.report).toBe("thinking");
  expect(parsed.overview).toHaveProperty("estimated_thinking_tokens");
  expect(parsed.overview).toHaveProperty("turns_with_thinking");
  expect(Array.isArray(parsed.byProject)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/reports.test.ts`
Expected: FAIL — `parsed.byProject` is undefined (not in current JSON output).

- [ ] **Step 3: Add per-project section to `src/reports/thinking.ts`**

After the `byTool` map is built (around line 35), add:

```typescript
const byProject = new Map<string, {
  thinkingTurns: number; estThinking: number; sessions: Set<string>; outputTokens: number;
}>();
for (const t of enriched) {
  const cwd = t.cwd ?? "(unknown)";
  const e = byProject.get(cwd) ?? { thinkingTurns: 0, estThinking: 0, sessions: new Set(), outputTokens: 0 };
  e.thinkingTurns++;
  e.estThinking += t.estimatedThinkingTokens;
  e.sessions.add(t.sessionId);
  e.outputTokens += t.outputTokens;
  byProject.set(cwd, e);
}
const byProjectRows = Array.from(byProject.entries())
  .sort((a, b) => b[1].estThinking - a[1].estThinking)
  .slice(0, opts.limit);
```

In the `if (opts.json)` block, add `byProject` to the JSON object:

```typescript
byProject: byProjectRows.map(([cwd, d]) => ({
  cwd,
  thinkingTurns: d.thinkingTurns,
  sessionCount: d.sessions.size,
  estimatedThinkingTokens: d.estThinking,
})),
```

After the "By Co-occurring Tool" table, add a "By Project" table:

```typescript
if (byProjectRows.length > 0) {
  console.log(`\n${bold("  By Project")}`);
  console.log(renderTable(
    [
      { header: "Project", align: "left", width: 30 },
      { header: "Thinking Sessions", align: "right", width: 18 },
      { header: "Thinking Turns", align: "right", width: 15 },
      { header: "~Total Thinking Tokens", align: "right", width: 22 },
    ],
    byProjectRows.map(([cwd, d]) => [
      cwd.split("/").at(-1) ?? cwd,
      String(d.sessions.size),
      String(d.thinkingTurns),
      approx(formatTokens(d.estThinking)),
    ])
  ));
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/reports.test.ts`
Expected: All tests pass, including the updated thinking JSON test.

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass (count should be 81 + new tests added in tasks 2–7).

- [ ] **Step 6: Run typecheck**

Run: `bun tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/reports/thinking.ts tests/reports.test.ts
git commit -m "feat: add per-project breakdown to thinking report"
```

---

## Self-Review

**Spec coverage:**
- Context bloat: `queryContextStats` in Reader + JsonlReader + SqliteReader + `renderContextReport` + `--context` flag ✓
- Cache efficiency: `queryCacheStats` in Reader + JsonlReader + SqliteReader + `renderCacheReport` + `--cache` flag ✓
- Session efficiency: `renderEfficiencyReport` using existing `querySessions` + `--efficiency` flag ✓
- Thinking per-project: `byProject` section added to `renderThinkingReport` ✓

**Type consistency check:**
- `ContextStatRow` defined in `db.ts`, imported in `reader.ts` (re-exported), used in `jsonl.ts` and `context.ts` ✓
- `CacheStatRow` same chain ✓
- `queryContextStats(since: number, limit: number): ContextStatRow[]` — matches in interface, JsonlReader, SqliteReaderInterface, createSqliteReader, and report call sites ✓
- `queryCacheStats(since: number, limit: number): CacheStatRow[]` — same ✓
- `Options` interface in all new reports: `{ since: number; sinceStr: string; limit: number; json: boolean }` — matches what cli.ts passes via `options` ✓
- `renderContextReport`, `renderCacheReport`, `renderEfficiencyReport` all imported in `cli.ts` via dynamic import using correct module path ✓

**Placeholder scan:** No TODOs, TBDs, or "similar to Task N" references. All code blocks are complete.
