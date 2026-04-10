# token-scope Phase 4: Cache Intelligence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform token-scope from a spend reporter into a cache optimization tool. Add reports that decompose *what* is being cached, identify which operations grow context fastest, and recommend when to reset sessions — shifting focus from output-side analytics to the input/cache side that represents 93.6% of actual spend.

**Motivation:** Analysis of real usage data showed:
- Cache reads = 63.3% of cost ($467/week), cache writes = 30.3%, output = 6.4%
- Context bloat report (now fixed in v1.0.1) shows 8-37x growth across sessions
- Sessions with 51+ turns cost 6x per turn vs short sessions
- No existing report tells you *what* is consuming cache or *which tools* inflate context fastest

**Architecture:** Four new reports + one enhanced report, built on the existing Reader interface pattern. All data is already available in the DB/JSONL — no new data sources needed. The key insight: `cache_creation_input_tokens` per turn represents new content entering the context window, and correlating it with tool usage reveals which operations are the most expensive context contributors.

**Tech Stack:** Same as existing — Bun, TypeScript, bun:test, bun:sqlite, Reader interface, pricing.ts, format.ts.

---

## Data Model Notes

The Claude API reports per assistant turn:
- `input_tokens` — non-cached input (typically 1-5 with prompt caching)
- `cache_read_input_tokens` — previously cached content re-read this turn
- `cache_creation_input_tokens` — new content entering the cache this turn

**Total context = input + cache_read + cache_write** (fixed in v1.0.1)

Key derivable metrics:
- **Base load** = turn 1 `cache_write` (system prompt + CLAUDE.md + rules + MCP instructions)
- **Per-turn delta** = `cache_write` this turn (new content entering context — tool results, user messages, assistant output)
- **Cumulative context** = `cache_read` growth over turns (everything being re-read)
- **Cache write spikes** = turns where `cache_write` is unusually large, correlated with tool name

---

## File Map

**Create:**
- `src/reports/base-load.ts` — `--base-load` report (system prompt weight by project)
- `src/reports/cache-growth.ts` — `--cache-growth` report (per-turn context waterfall for a session)
- `src/reports/context-contributors.ts` — `--contributors` report (cache_write by tool type)
- `src/reports/session-budget.ts` — `--budget` report (optimal session length recommendation)

**Modify:**
- `src/db.ts` — add query functions for base load, cache growth, context contributors, session budget
- `src/reader.ts` — add new methods to Reader interface; export new row types
- `src/jsonl.ts` — implement new Reader methods in JsonlReader
- `src/cli.ts` — add `--base-load`, `--cache-growth`, `--contributors`, `--budget` modes
- `src/reports/context.ts` — enhance bloat report with cache_write breakdown column
- `tests/jsonl.test.ts` — add tests for new Reader methods
- `tests/db.test.ts` — add tests for new SQL queries (using fixture data with nonzero cache tokens)
- `tests/reports.test.ts` — add smoke tests for new reports
- `tests/fixtures/seed.sql` — add sessions with realistic cache token patterns

**Modify (fixtures):**
- `tests/fixtures/seed.sql` — update existing sessions to include nonzero cache tokens, add new session with realistic growth pattern
- `tests/fixtures/projects/-Users-alice-projects-beacon/sess-j4.jsonl` — already has cache tokens, sufficient for JSONL tests

---

## Task 1: Update Test Fixtures with Cache Token Data

**Files:**
- Modify: `tests/fixtures/seed.sql`

Currently all SQL fixture sessions have `cache_read_input_tokens: 0` and `cache_creation_input_tokens: 0`. The new reports need realistic cache patterns to test against.

- [ ] **Step 1: Add a new 10-turn session (`sess-d1`) with realistic cache growth**

Add to `seed.sql` a session that mimics real behavior:
- Turn 1: cache_write=20000 (base load), cache_read=0
- Turn 2: cache_write=3000, cache_read=20000
- Turn 3: cache_write=500, cache_read=23000
- Turns 4-10: growing cache_read, varied cache_write (spikes on Read/Edit turns)

Use different tools across turns: `(text)`, `Read`, `Edit`, `Bash`, `Grep`, `Agent` — so the contributors report has varied data.

- [ ] **Step 2: Update existing sessions to include small cache values**

Add nonzero cache_read and cache_write to at least `sess-a1` and `sess-b1` so cache efficiency tests have data.

- [ ] **Step 3: Run existing test suite to confirm fixture changes don't break anything**

Existing tests that depend on specific token totals may need adjustment.

---

## Task 2: Base Load Report (`--base-load`)

**Files:**
- Modify: `src/db.ts` — add `BaseLoadRow` type and `queryBaseLoad` function
- Modify: `src/reader.ts` — add to Reader interface
- Modify: `src/jsonl.ts` — implement in JsonlReader
- Create: `src/reports/base-load.ts`
- Modify: `src/cli.ts` — add `--base-load` mode

**Purpose:** Show the "system prompt tax" — the fixed token cost every session pays on turn 1 before any work happens. Helps identify projects with bloated CLAUDE.md, too many rules, or heavy MCP server instructions.

- [ ] **Step 1: Add `BaseLoadRow` type to `src/db.ts`**

```typescript
export interface BaseLoadRow {
  cwd: string;
  sessions: number;
  avgBaseTokens: number;     // avg turn-1 (cache_write + cache_read + input)
  avgCacheWrite: number;     // avg turn-1 cache_write (new cache, i.e. system prompt)
  avgCacheRead: number;      // avg turn-1 cache_read (shared cache from other sessions)
  minBaseTokens: number;
  maxBaseTokens: number;
  estimatedBaseCostUsd: number | null;  // avg base tokens * price per session count
}
```

- [ ] **Step 2: Add `queryBaseLoad` SQL function**

```sql
WITH first_turns AS (
  SELECT bm.session_id, bm.cwd,
    (CAST(json_extract(am.message, '$.usage.cache_creation_input_tokens') AS INTEGER)
     + CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER)
     + CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER)) AS total,
    CAST(json_extract(am.message, '$.usage.cache_creation_input_tokens') AS INTEGER) AS cw,
    CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER) AS cr,
    am.model,
    ROW_NUMBER() OVER (PARTITION BY bm.session_id ORDER BY bm.timestamp) AS rn
  FROM assistant_messages am
  JOIN base_messages bm ON am.uuid = bm.uuid
  WHERE bm.timestamp > ? AND json_valid(am.message) = 1
)
SELECT cwd,
  COUNT(*) AS sessions,
  ROUND(AVG(total)) AS avgBaseTokens,
  ROUND(AVG(cw)) AS avgCacheWrite,
  ROUND(AVG(cr)) AS avgCacheRead,
  MIN(total) AS minBaseTokens,
  MAX(total) AS maxBaseTokens
FROM first_turns WHERE rn = 1
GROUP BY cwd ORDER BY avgBaseTokens DESC LIMIT ?
```

Cost estimation uses the dominant model's input pricing.

- [ ] **Step 3: Implement `queryBaseLoad` in JsonlReader**

Filter to first turn per session, compute same aggregates in JS.

- [ ] **Step 4: Create `src/reports/base-load.ts`**

Output format:
```
token-scope — Base Load (System Prompt Tax)
  Projects                     N
  Heaviest Base Load           XX,XXX tokens
  Lightest Base Load           X,XXX tokens

  By Project
  Project   │ Sessions │ Avg Base │ Min    │ Max    │ Est. Cost/Session
  ──────────┼──────────┼──────────┼────────┼────────┼──────────────────
  public    │       12 │   38,607 │ 35,000 │ 42,000 │          $0.0290
```

Include footnote: "Base load = turn 1 context size (system prompt + CLAUDE.md + rules + MCP instructions). Reducing these reduces the fixed cost of every session."

- [ ] **Step 5: Wire into cli.ts as `--base-load` mode**

---

## Task 3: Cache Growth Waterfall (`--cache-growth`)

**Files:**
- Modify: `src/db.ts` — add `CacheGrowthRow` type and `queryCacheGrowth` function
- Modify: `src/reader.ts` — add to Reader interface
- Modify: `src/jsonl.ts` — implement in JsonlReader
- Create: `src/reports/cache-growth.ts`
- Modify: `src/cli.ts` — add `--cache-growth` mode

**Purpose:** Turn-by-turn waterfall for a specific session showing how context accumulates. The most diagnostic view — shows exactly where context explodes.

- [ ] **Step 1: Add `CacheGrowthRow` type**

```typescript
export interface CacheGrowthRow {
  turn: number;
  totalContext: number;      // input + cache_read + cache_write
  cacheRead: number;
  cacheWrite: number;
  inputTokens: number;
  delta: number;             // totalContext - previous turn's totalContext
  costUsd: number | null;
  tool: string;              // dominant tool this turn
}
```

- [ ] **Step 2: Add `queryCacheGrowth` function**

Takes a session ID (or partial match). Returns all turns with token breakdown. Dominant tool resolved via `parseContentBlocks` + `resolveDominantTool` (existing parse.ts functions).

- [ ] **Step 3: Implement in JsonlReader**

- [ ] **Step 4: Create `src/reports/cache-growth.ts`**

Output format:
```
token-scope — Cache Growth: sess-04442160…
  Project: public  |  Turns: 1291  |  Duration: 4h 23m

  Turn │ Total Context │ Cache Read │ Cache Write │ Delta   │ Cost    │ Tool
  ─────┼───────────────┼────────────┼─────────────┼─────────┼─────────┼──────
  1    │        38,607 │          0 │      38,503 │       — │ $0.0290 │ (text)
  2    │        42,118 │     38,503 │       3,611 │  +3,511 │ $0.0310 │ Read
  3    │        43,220 │     42,114 │       1,102 │  +1,102 │ $0.0315 │ Edit
  ...

  Top 5 Context Spikes
  Turn │ Delta    │ Tool  │ Detail
  ─────┼──────────┼───────┼────────────────────
  47   │  +12,450 │ Read  │ /src/db.ts (2000 lines)
  112  │   +8,200 │ Agent │ (subagent result)
```

The "Top 5 Context Spikes" section shows the turns with the largest `cache_write` values, which represent the biggest context contributors.

For tool detail: if tool is Read, extract `file_path` from input. If Bash, extract `command` (truncated). If Agent, note "(subagent result)".

- [ ] **Step 5: Wire into cli.ts**

Accepts `--cache-growth <session-id>`. If no session ID, show the most recent session. Support partial UUID match (first 8+ chars).

---

## Task 4: Context Contributors Report (`--contributors`)

**Files:**
- Modify: `src/db.ts` — add `ContributorRow` type and `queryContextContributors` function
- Modify: `src/reader.ts` — add to Reader interface
- Modify: `src/jsonl.ts` — implement in JsonlReader
- Create: `src/reports/context-contributors.ts`
- Modify: `src/cli.ts` — add `--contributors` mode

**Purpose:** Answer "which tools/operations add the most to context?" by aggregating `cache_creation_input_tokens` by tool type. This is the actionable report — if Read operations add 60% of context, you know to read smaller file slices.

- [ ] **Step 1: Add `ContributorRow` type**

```typescript
export interface ContributorRow {
  tool: string;
  turns: number;
  totalCacheWrite: number;     // sum of cache_creation_input_tokens
  avgCacheWrite: number;       // per-turn average
  maxCacheWrite: number;       // single biggest spike
  pctOfTotal: number;          // share of all cache_write tokens
  estimatedCostUsd: number | null;
}
```

- [ ] **Step 2: Add `queryContextContributors` SQL function**

Group by dominant tool (resolved in JS via `parseContentBlocks` like existing `queryByTool`). Compute totals/averages/max per tool.

- [ ] **Step 3: Implement in JsonlReader**

- [ ] **Step 4: Create `src/reports/context-contributors.ts`**

Output format:
```
token-scope — Context Contributors
  Total Cache Writes           XX,XXX,XXX tokens
  Turns Analyzed               N

  By Tool (what adds the most to your context window)
  Tool       │ Turns │ Total Added  │ Avg/Turn │ Max Spike │ Share  │ Est. Cost
  ───────────┼───────┼──────────────┼──────────┼───────────┼────────┼──────────
  Read       │   356 │   12,450,000 │   34,972 │   145,989 │  42.1% │  $93.38
  (text)     │  5535 │    8,200,000 │    1,481 │    32,983 │  27.7% │  $61.50
  Edit       │   152 │    4,100,000 │   26,974 │   151,495 │  13.9% │  $30.75
  Agent      │   144 │    2,800,000 │   19,444 │    69,065 │   9.5% │  $21.00
  Bash       │  1310 │    1,200,000 │      916 │    23,360 │   4.1% │   $9.00
  ...

  Recommendations
  - Read operations contribute 42% of context growth. Use offset/limit to read smaller file slices.
  - Agent subagent results add ~19K tokens per call. Consider whether results can be summarized.
```

The recommendations section is generated based on the data: flag the top contributor with a contextual suggestion.

- [ ] **Step 5: Wire into cli.ts as `--contributors` mode**

Support `--project <fragment>` filter to scope to one project.

---

## Task 5: Session Budget Report (`--budget`)

**Files:**
- Modify: `src/db.ts` — add `SessionBudgetRow` type and `querySessionBudgets` function
- Modify: `src/reader.ts` — add to Reader interface
- Modify: `src/jsonl.ts` — implement in JsonlReader
- Create: `src/reports/session-budget.ts`
- Modify: `src/cli.ts` — add `--budget` mode

**Purpose:** Recommend the optimal session length by computing where cumulative cache cost crosses a threshold. Tells you "clear after N turns to stay under $X."

- [ ] **Step 1: Add types**

```typescript
export interface SessionBudgetRow {
  sessionId: string;
  cwd: string | null;
  turnCount: number;
  totalCostUsd: number | null;
  costAtTurn10: number | null;
  costAtTurn25: number | null;
  costAtTurn50: number | null;
  avgCostPerTurnFirst10: number | null;
  avgCostPerTurnLast10: number | null;
  costAccelerationRatio: number | null;  // last10 avg / first10 avg
}
```

- [ ] **Step 2: Add `querySessionBudgets` function**

For each session, compute cumulative cost at milestones (turn 10, 25, 50) and cost acceleration (avg cost of last 10 turns / avg cost of first 10 turns). Use existing `cost_usd` column per turn.

- [ ] **Step 3: Implement in JsonlReader**

- [ ] **Step 4: Create `src/reports/session-budget.ts`**

Output format:
```
token-scope — Session Budget Analysis
  Sessions Analyzed            N
  Avg Cost Acceleration        X.Xx (last 10 turns cost X.Xx more than first 10)

  Optimal Reset Point
  Based on your usage patterns, context cost doubles at ~turn N.
  Clearing after turn N saves an estimated $X.XX per session.

  Sessions by Cost Acceleration
  Session    │ Project    │ Turns │ Total Cost │ @T10    │ @T25    │ @T50    │ Accel
  ───────────┼────────────┼───────┼────────────┼─────────┼─────────┼─────────┼───────
  04442160-  │ public     │  1291 │   $326.36  │  $0.92  │  $2.43  │  $6.12  │  8.8x
```

The "Optimal Reset Point" is computed by finding the turn where per-turn cost exceeds 2x the session's average per-turn cost, averaged across all sessions. This is a heuristic, not a precise recommendation.

- [ ] **Step 5: Wire into cli.ts as `--budget` mode**

---

## Task 6: Enhance Context Bloat Report with Cache Breakdown

**Files:**
- Modify: `src/reports/context.ts`
- Modify: `src/db.ts` — extend `ContextStatRow` with cache breakdown fields
- Modify: `src/reader.ts` — update type
- Modify: `src/jsonl.ts` — compute new fields

**Purpose:** The existing bloat report shows total context growth. Adding a cache_write column shows *how much new content* was added vs *how much was re-read*, making the bloat report more diagnostic.

- [ ] **Step 1: Extend `ContextStatRow`**

Add fields:
```typescript
  totalCacheRead: number;
  totalCacheWrite: number;
  avgTurnCacheWrite: number;  // avg cache_write per turn (new content rate)
```

- [ ] **Step 2: Update SQL query in `queryContextStats`**

Add SUM aggregates for cache_read and cache_write per session.

- [ ] **Step 3: Update JsonlReader**

- [ ] **Step 4: Update context.ts report**

Add columns to the table: `Avg CW/Turn` (average cache_write per turn) and `Total CW` (total cache writes). This shows the "content ingestion rate" alongside the bloat ratio.

---

## Task 7: Tests for All New Reports

**Files:**
- Modify: `tests/jsonl.test.ts`
- Modify: `tests/db.test.ts`
- Modify: `tests/reports.test.ts`

- [ ] **Step 1: Add JSONL reader tests for new methods**

Test `queryBaseLoad`, `queryCacheGrowth`, `queryContextContributors`, `querySessionBudgets` using existing sess-j4 fixture (has cache tokens).

- [ ] **Step 2: Add DB reader tests for new SQL queries**

Test against updated seed.sql with the new sess-d1 session.

- [ ] **Step 3: Add report smoke tests**

Each new report should render without errors. Test with `--json` flag for structured output validation.

---

## Task 8: CLI Wiring and Documentation

**Files:**
- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add all new flags to cli.ts argument parser**

New flags: `--base-load`, `--cache-growth`, `--contributors`, `--budget`

`--cache-growth` accepts an optional session ID argument.
`--contributors` accepts an optional `--project` filter.

- [ ] **Step 2: Update README.md with new report descriptions**

- [ ] **Step 3: Update CHANGELOG.md**

Add Phase 4 section documenting all new reports.

- [ ] **Step 4: Bump version to 1.1.0**

This is a feature release (new reports, no breaking changes).

---

## Implementation Order

1. **Task 1** (fixtures) — foundation for all tests
2. **Task 4** (contributors) — highest value, answers "what's bloating context?"
3. **Task 2** (base load) — simple, answers "how heavy is my system prompt?"
4. **Task 3** (cache growth) — diagnostic waterfall for individual sessions
5. **Task 5** (session budget) — actionable recommendation
6. **Task 6** (enhance bloat) — incremental improvement to existing report
7. **Task 7** (tests) — can be done incrementally per task
8. **Task 8** (CLI + docs) — finalize

Tasks 2-5 are independent and can be parallelized after Task 1.

---

## What This Does NOT Cover (Future Work)

- **Cache content decomposition** — The API doesn't report *what* is in the cache (system prompt vs conversation history vs tool results). We can infer from `cache_write` spikes which operations add content, but we can't attribute what percentage of a `cache_read` is system prompt vs history. This would require intercepting the actual prompt assembly, which is inside Claude Code's runtime.
- **Real-time cache monitoring hook** — The existing cost-alert hook could be extended to warn when cache_write exceeds a threshold per turn. Deferred to Phase 5.
- **Automated `/clear` recommendation** — A hook that suggests clearing when cost acceleration exceeds a threshold. Requires the budget analysis to be runnable as a library, not just CLI. Deferred to Phase 5.
