# token-scope

**Analytics for your Claude Code token spend.**

Reads Claude Code's JSONL session files (and optionally `~/.claude/__store.db`) in read-only mode and shows exactly where your tokens and money go — by tool, project, session, thinking blocks, cache efficiency, context bloat, and cost per turn.

## Why

Claude Code users have no built-in visibility into token spend. `token-scope` fills that gap retroactively, with no proxy, no tokenizer, and no daemon. The data is already on disk.

## Prerequisites

[Bun](https://bun.sh) 1.1.0+

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install

```bash
git clone https://github.com/nhangen/token-scope ~/ML-AI/claude/token-scope
cd ~/ML-AI/claude/token-scope
bun install
bun link          # makes `token-scope` available from any directory
```

## Reports

### Summary (default)

```bash
token-scope --since 7d
```

```
token-scope — Summary  (Apr 1, 2026 → now)
────────────────────────────────────────────────────────────
  Sessions: 236   Turns: 5,966

  Totals
  Output Tokens                1,617,245
  Cache Read Tokens            412,581,387
  Total Cost                   $401.77
  Avg Cost / Session           $1.70
  Avg Cost / Turn              $0.07

  Output Tokens by Tool
Tool              │ Turns  │ Output Tokens │ Cost %
──────────────────┼────────┼───────────────┼───────
(text only)       │  4,227 │       868,702 │  56.5%
Bash              │    900 │       272,348 │  22.3%
Agent             │    147 │       167,949 │   7.1%
Write             │     50 │       155,838 │   1.4%
...

  Output Tokens by Project
Project                  │ Sessions │ Turns │ Total Cost │ Avg/Session
─────────────────────────┼──────────┼───────┼────────────┼────────────
appoptinmonstertest      │        8 │ 1,140 │    $96.37  │     $12.05
token-scope              │        1 │   314 │    $17.03  │     $17.03
...

  Weekly Trend
Week     │ Sessions │ Turns  │ Output Tokens │ Total Cost
─────────┼──────────┼────────┼───────────────┼───────────
2026-W14 │      222 │  4,749 │     1,362,379 │    $198.71
2026-W13 │       16 │  1,217 │       254,866 │    $203.06
```

---

### Tool drill-down

```bash
token-scope --tool bash --since 7d
```

```
token-scope — Tool: Bash
────────────────────────────────────────────────────────────
  Turns (dominant)             902
  Total Cost                   $89.78
  Share of All Cost            22.3%
  Distribution (p50/p95/max)   160 / 799 / 9,875

  Command Categories
Category        │ Turns │ Output Tokens │ Total Cost
────────────────┼───────┼───────────────┼───────────
Other           │   508 │       136,524 │    $57.43
File Inspection │   272 │        91,402 │    $16.41
Version Control │    54 │        10,612 │    $10.99
JS Tooling      │    22 │         6,773 │     $1.18
...
```

---

### Sessions list

```bash
token-scope --sessions --since 7d
```

```
token-scope — Sessions  (last 7d)
────────────────────────────────────────────────────────────
Session ID     │ Project              │ Started         │ Duration   │ Turns │ Cost
───────────────┼──────────────────────┼─────────────────┼────────────┼───────┼──────────
be299042-801f- │ appoptinmonstertest  │ Apr 02 at 20:59 │ 123:47:33  │   682 │ $105.19
04442160-fea2- │ appoptinmonstertest  │ Apr 06 at 14:21 │  52:38:20  │   806 │  $47.90
07896aa6-5249- │ mtf-builder          │ Apr 07 at 17:45 │  07:01:05  │   141 │   $9.88
...
```

---

### Session detail

```bash
token-scope --session be299042
```

Turn-by-turn breakdown with output tokens, cost, tool used, and thinking indicator for every turn in the session.

---

### Spend (per-task token accounting)

```bash
token-scope --spend --session be299042            # whole session
token-scope --spend --session be299042 --turns 5..12   # isolate one task
token-scope --spend --turns 5..12                 # most-recent session
```

Isolates the **Claude (billed) token spend** — output, input, cache-read, cache-write,
and a derived cost — for one session, sliced to a turn range so a single task can be
measured. Rolls up subagent (Task/Agent) overhead so PM-loop cost (auditors, explorers)
is visible rather than hidden. `--session` picks the session (defaults to the most recent);
`--turns N..M` (also `N..`, `..M`, `N`) is a 1-indexed inclusive slice; `--since` acts as a
within-session timestamp floor when set.

Notes: subagent totals are session-wide in v1 (not scoped to the turn range), and require
the JSONL source (subagent transcripts aren't in the SQLite store). Turns on a model with
no known pricing still count their tokens; only their cost is excluded. Local (ollama)
authoring runs off-transcript and is not counted — so a delegated task's spend shows just
the thin Claude PM overhead.

---

### Savings (ollama delegation ROI)

```bash
token-scope --savings                                  # all delegation runs
token-scope --savings --session be299042               # one delegation session
token-scope --savings --counterfactual-model claude-sonnet-5   # value against a cheaper tier
token-scope --savings --session be299042 --pm-turns 4..9   # net vs. just the delegation's PM turns
token-scope --savings --session be299042 --pm-cost 0.87    # net vs. a measured PM figure (subagent PM)
token-scope --savings --ledger /path/to/runs.jsonl     # explicit ledger location
token-scope --savings --escalations /path/to/escalations.jsonl  # explicit escalation sidecar
```

Answers the "did delegating authorship to a local ollama model actually save money?"
question. Reads the **ollama-agent run ledger** (`$XDG_STATE_HOME/ollama-agent/runs.jsonl`,
or `$OLLAMA_AGENT_LEDGER`) — the bridge records each run's local token counts (ground truth
from ollama's `eval_count`/`prompt_eval_count`) plus the Claude session that spawned it.
token-scope prices them; the bridge never guesses cost.

For each delegation session it reports the **net savings**:

```
Net = Counterfactual − PM overhead
```

- **Counterfactual** — the ollama token volume valued at Claude prices (default
  `claude-opus-4-8`): an estimate of what Claude authoring the same work would have cost.
  ollama and Claude tokenize differently, so this is a proxy, not a measured figure.
- **PM overhead** — the *actual* Claude billed spend of the session that ran the
  delegation: the real cost of Claude playing project-manager (writing tests, auditing,
  steering). By default this is the **whole session** (direct + subagent rollup). That only
  makes sense for a *dedicated* delegation session — in a long mixed session, unrelated work
  swamps the delegation and net reads hugely negative. Use **`--pm-turns N..M`** (requires
  `--session`) to scope PM overhead to just the delegation's orchestration turns — the only
  way to get a meaningful **per-task** net from transcripts. The ledger has no delegation-start
  marker, so the turn window can't be auto-derived; you isolate it, exactly as with
  `--spend --turns`. (Turn-scoped PM excludes session-wide subagent cost, so it's a floor.)
- **Measured PM** — when the PM was a **subagent** (the recommended pattern: a lean Haiku
  agent writes the oracles and fires the bridge), *neither* scope can isolate its cost —
  subagent spend is session-wide in v1, and turn slices cover direct turns only. Measure it
  out-of-band (e.g. the subagent-bucket delta between two `--spend` runs) and pass it as
  **`--pm-cost <usd>`** (requires `--session`, mutually exclusive with `--pm-turns`). The
  report takes the figure on trust and labels the scope `measured (caller)`. Because no
  transcript lookup happens, this also attributes sessions that ran on another machine.

#### Escalated runs are not savings

When a spec hits the turn cap twice, `ollama-delegate` no longer stops — it hands the same
spec to a higher-tier author (a Sonnet subagent in Claude Code, `gpt-5.6-terra`/`-luna` in
Codex). That author is billed for the job. Pricing the local attempts as "what Claude would
have cost" then counts one job twice: once as a counterfactual saving and once as real spend.

So token-scope reads a sidecar written by llm-tools'
`~/.claude/scripts/ollama-record-escalation.sh`:

```
$XDG_STATE_HOME/ollama-agent/escalations.jsonl   (or $OLLAMA_AGENT_ESCALATIONS, or --escalations)
```

It is a sibling of `runs.jsonl` rather than a field on it — that file is written by
claude-ceo's bridge, and a new field there risks the parsing this report depends on.

A ledger run is **superseded** when a record names its `run_id`, ran in the same `cwd`, the
run itself failed, and it falls in the `OLLAMA_ATTEMPT_GAP` window (default 4h) before the
record. All four matter: a label is a ticket number and gets reused, a later run on the same
ticket that *succeeded* saved real work, and a run outside the window belongs to an earlier
cycle. Three shapes cannot be decided and all three stay in the counterfactual, over-stating the
saving rather than inventing an exclusion: a run with no timestamp, a legacy run with no
`cwd`, and a run whose `reason`/`completed`/`verified` are all unrecorded (the ledger
defines that as "not recorded — never a claim about the run", and the matcher reads it as
"succeeded"). A record with an empty `cwd` is read as having none, so it matches nothing —
the recorder refuses to write one and calls such a record not discountable at all.

Superseded runs are **excluded from the counterfactual** — unlike runs that merely failed,
which stay in it and are footnoted — but their tokens remain in the ledger totals, so no
spend is hidden. `--json` adds `superseded_run_count`, `superseded_input`,
`superseded_output`, and `superseded_excluded_usd` (the dollar figure the exclusion removed)
whenever the report found any.

**A sidecar that fails to load is never reported as one that legitimately held nothing.**
That distinction is the whole point of the feature: both produce zero exclusions, and zero
exclusions is a full, confident, wrong counterfactual — the double-count #81 removed, back
again. So `--json` always carries `escalations_path`, `escalations_status`
(`ok`/`absent`/`unreadable`), `escalations_records`, `escalations_skipped_lines`,
`escalations_unmatched`, and `attempt_gap_seconds`, whether or not anything was superseded.
An unreadable file warns on stderr; so does a missing file whose path you named yourself,
since a path you typed is an assertion that it is there.

Records that name a run the ledger does not contain are footnoted rather than dropped.
Matching keys on `cwd` as well as `run_id`, so a worktree that moved after the escalation
breaks every record naming it — silently restoring the double-count if nothing counts the
misses. A record whose run is present but ineligible (it succeeded, or it cannot be dated)
is doing its job by not firing and is not counted, and the footnote is suppressed on a
`--session`/`--since` report, where scoping leaves most records naming nothing by
construction.

The same disclosure covers the ledger itself: `ledger_status` and `ledger_skipped_lines`
sit beside `ledger_path`, and an unreadable ledger warns on stderr. It is the primary
source of every figure in the report, so disclosing the sidecar's load status and not the
ledger's would advertise an integrity the report does not have.

A **positive net means delegation saved money.** Note the economics: for a *small* task the
counterfactual is tiny, so a single expensive PM turn can exceed it (net negative) — delegation
pays off as the authored task grows large relative to the fixed PM overhead. Runs with no
attributable Claude session (null `session_id`, or a session not in the local transcripts) are
counted for token volume but excluded from the net headline. `--since` floors by ledger timestamp
when set.

---

### Project filter

```bash
token-scope --project wp-content --since 30d
```

Filters all reports to sessions where `wp-content` appears in the working directory path.

---

### Cache efficiency

```bash
token-scope --cache --since 30d
```

```
token-scope — Cache Efficiency
────────────────────────────────────────────────────────────
  Projects                     20
  Overall Cache Hit %          100.0%
  Est. Total Savings           $10,159.63

  By Project
Project                    │ Sessions │ Turns  │ Cache Hit % │ Cache Reads   │ Est. Savings
───────────────────────────┼──────────┼────────┼─────────────┼───────────────┼─────────────
public                     │       12 │  3,431 │      100.0% │   405,001,821 │   $3,974.15
wp-content-6879-hubspot-v3 │        2 │    449 │      100.0% │   130,063,498 │   $1,700.55
wp-content                 │        4 │    863 │      100.0% │   122,866,030 │   $1,513.68
token-scope                │        1 │    314 │      100.0% │    37,219,623 │     $100.49
...
```

Cache hit % and estimated dollar savings by project. Savings are estimated from Anthropic's cache read vs full input pricing differential.

---

### Session efficiency

```bash
token-scope --efficiency --since 30d
```

```
token-scope — Session Efficiency
────────────────────────────────────────────────────────────
  Total Sessions               1,162

  Cost Per Turn by Session Length
Turn Bucket │ Sessions │ Avg Turns │ Avg Per-Turn Cost │ Avg Session Cost
────────────┼──────────┼───────────┼──────────────────┼─────────────────
1–5         │      962 │       2.7 │           $0.010 │           $0.027
6–15        │      130 │       7.7 │           $0.025 │           $0.191
16–30       │       28 │      20.1 │           $0.034 │           $0.678
31–50       │       13 │      40.5 │           $0.077 │           $3.105
51+         │       29 │     315.6 │           $0.192 │          $60.626
```

Longer sessions accumulate more context, driving up per-turn cost. A 51+ turn session costs ~20× more per turn than a 1–5 turn session.

---

### Context bloat

```bash
token-scope --context --since 30d
```

```
token-scope — Context Bloat Analysis
────────────────────────────────────────────────────────────
  Sessions Analyzed            20

  Sessions Ranked by Bloat (early = avg of first 3 turns, late = avg of last 3 turns)
Session        │ Project           │ Turns │ Early Avg Input │ Late Avg Input │ Bloat
───────────────┼───────────────────┼───────┼─────────────────┼────────────────┼──────
cbb12eb7-b13b- │ HW                │   347 │               3 │              3 │  1.0×
58279086-c21b- │ observer-sessions │    23 │              10 │             10 │  1.0×
...
```

Sessions with ≥6 turns, ranked by how much input token count grows from early turns to late turns. High bloat ratios indicate context accumulation driving up costs.

---

### Thinking analysis

```bash
token-scope --thinking --since 7d
```

```
token-scope — Thinking Analysis
────────────────────────────────────────────────────────────
  ~Total Thinking Tokens (est)  ~126,832
  ~Thinking % of Output         ~7.8%
  Turns with Thinking           2,055 (34.4% of all turns)
  Sessions with Thinking        232 (98.3%)

  By Project
Project          │ Thinking Sessions │ Thinking Turns │ ~Total Thinking Tokens
─────────────────┼───────────────────┼────────────────┼───────────────────────
observer-sessions│               202 │          1,899 │               ~117,274
3body            │                 1 │             20 │                 ~8,159
wp-content       │                 2 │             16 │                   ~155
...
```

Thinking token estimates use a character-ratio proxy (±15–30% error). All thinking figures are prefixed with `~`.

---

### Tooling analysis

```bash
token-scope --tools --since 30d
```

```
token-scope — Tooling Analysis
────────────────────────────────────────────────────────────
  Total Tool Calls             4,716
  Distinct Tools               23
  Layers Active                4 of 5
  Unclassified Tools           0

  Cost by Layer
Layer        │ Calls  │ Attributed Cost │ Cost %  │ Avg/Call
─────────────┼────────┼─────────────────┼─────────┼──────────
Built-in     │  3,890 │        $342.18  │   85.2% │   $0.088
MCP          │     61 │         $12.40  │    3.1% │   $0.203
Plugin       │     17 │          $4.80  │    1.2% │   $0.282
Skill        │     67 │          $3.42  │    0.9% │   $0.051
Meta         │    241 │          $5.26  │    1.3% │   $0.022
(no tool)    │    440 │         $33.57  │    8.4% │   $0.076
```

Classifies every tool call into five layers and attributes cost proportionally by input payload size. Plugins are MCP servers provided by Claude Code plugins (`mcp__plugin_*`). Hooks are invisible (shell commands, not tool_use blocks).

---

### Context contributors

```bash
token-scope --contributors --since 30d
```

Ranks which tools add the most to the context window. Pair with `--project <fragment>` to scope to a single project.

---

### Base load

```bash
token-scope --base-load --since 30d
```

System-prompt tax per project: the per-session input cost before any work happens.

---

### Cache growth waterfall

```bash
token-scope --cache-growth <session-id>
```

Turn-by-turn cache growth waterfall for one session. Useful for diagnosing where context accumulates.

---

### Session budget

```bash
token-scope --budget --since 30d
```

Optimal session length analysis — where the per-turn cost curve breaks.

---

### Credits (weekly burn vs plan cap)

```bash
token-scope --credits --since 60d
  --providers             Cross-harness usage: Claude native, Claude over Ollama,
                          Codex, and OpenCode normalized into one provider-neutral
                          report (pairs with --since)
token-scope --credits --cap 4.8B           # Max 20x instead of the 5x default
```

Weekly consumption in **credits**, not dollars. A subscription's cap is denominated
in credits, so a dollar total — however accurate — cannot answer "am I over?".

The default cap of **1.2B** is a **Max 5x** allowance, measured rather than
published: Claude Code's `/usage` read 7% of the weekly limit over a window this
tool measured at 126.8M credits, which solves to ~1.81B against a promo-inflated
cap, ~1.2B base. It replaced a 166.7M figure that claimed to be Max 20x, was never
checked against the meter, and was wrong by roughly 30x — so both its value and its
tier label were wrong. Max 20x scales to roughly 4.8B, but that is inferred and
unmeasured. See the comment on `DEFAULT_WEEKLY_CAP` for the error bars and for why
the cap must be re-derived rather than hand-adjusted.

```
  Weekly cap                   1200.0M credits
  Avg full week                570.9M  (0.48x cap)   over 4 week(s)
  Week in progress             33.8M so far  (10% elapsed — too early to project)

Week (Mon)   │ Turns   │ Credits    │ vs Cap   │ Cache Rd  │ Cache Wr  │ Output   │ Subagent  │
2026-07-20   │    1737 │      68.7M │    0.06x │     56.7% │     33.8% │     9.5% │     20.4% │ partial (window)
2026-07-27   │   21790 │     789.5M │    0.66x │     64.9% │     26.3% │     8.8% │     17.7% │
2026-08-03   │    8201 │     294.3M │    0.25x │     60.6% │     31.2% │     8.2% │     30.3% │
2026-08-10   │   20118 │     722.4M │    0.60x │     64.9% │     26.8% │     8.3% │     21.3% │
2026-08-17   │   12675 │     477.4M │    0.40x │     61.9% │     24.2% │     7.6% │     24.3% │
2026-08-24   │     907 │      33.8M │    0.03x │     45.4% │     28.7% │     6.8% │     30.9% │ in progress
```

Four things worth knowing:

- **Credits are weighted tokens**, at 1 input : 1.25 cache-write : 0.1 cache-read :
  5 output. Fitted against one metered week — 294.3M computed vs ~296M metered, 0.6%
  — with no scaling constant. It tracks the meter; it is not the meter. See the
  caveat in `src/reports/credits.ts`, which is blunt about why a single observation
  cannot fully confirm the weighting.
- **Cache read + write is ~90% of the bill.** Output is ~8%. Shorter responses
  barely move the number; smaller contexts do. What costs money is how much context
  is re-sent each turn, not how much is said.
- **Subagent turns are counted here and nowhere else,** and priced, not just tallied.
  Every other report prunes `subagents/` so per-session numbers describe the session
  you were in. Subagents draw the same allowance — 17–30% of credits on real weeks —
  so omitting them read ~30% cheap. A turn count wouldn't answer "what would I save
  by dispatching fewer?", because subagent turns carry different context sizes; the
  `Subagent` column is their share of the week's *credits*. The sqlite source cannot
  see them at all and says so in a footnote instead of implying zero.
- **Two ways a row can be incomplete, and they're marked differently.** A week still
  running shows `→ Nm` projected at its observed rate — suppressed as "in progress"
  until a fifth of the week has elapsed, because extrapolating from Monday morning
  multiplies whatever happened to land there by 20x. A week whose start falls outside
  `--since` shows `partial (window)`: calendar-complete but data-incomplete, so it is
  excluded from the average. Widen `--since` to see it whole.

---

### Context-loop ROI

```bash
token-scope --context-loop --since 30d
token-scope --context-loop --tuning
token-scope --context-loop --reclamation
token-scope --context-loop --patterns
```

Savings and ROI analytics for the `context-loop` plugin. Subsections: threshold curve / acted vs ignored (`--tuning`), per-cwd reclamation and no-fire baseline (`--reclamation`), n-th-fire returns and quality proxy (`--patterns`).

---

### Artifacts (per-file Write/Edit cost)

```bash
token-scope --artifacts --since 30d
token-scope --artifacts --artifact-format md
token-scope --artifacts --artifact-path docs/
token-scope --artifact-show <full-path>
token-scope --artifact-compare <file.md>
```

Per-file production cost: which artifacts (files written or edited) cost the most to produce. Filter by extension (`--artifact-format`) or path fragment (`--artifact-path`). `--artifact-show` gives per-edit lifecycle for one file; `--artifact-compare` compares an `.md` to a sibling rendered HTML (`<dir>/artifacts/<slug>.html`).

---

## Provider Report (`--providers`)

`token-scope --providers --since 7d` normalizes the active coding harnesses into one provider-neutral table: per harness / billing route / model usage with nullable token classes (absent classes print `—`, never `0`), retry counts, and a measured-not-estimated footer. `--json` emits `{ rows, unavailable, measured }`.

### Data sources and limitations

| Source | Location | What it measures | Limitations |
|---|---|---|---|
| Claude native | `~/.claude/projects/**/*.jsonl`, walked recursively (subagent transcripts live in subdirectories) | Per-billed-response input/output and cache read/write — one event per unique `message.id`; the same response can appear on multiple transcript lines (streaming/sidechain copies) and counting lines overstated real spend by ~46% on a measured machine | No reasoning-token class; no per-request cash charge for Anthropic models (subscription includes them). Proxy-delegated models inside Claude transcripts (e.g. qwen via router) are labeled route `unknown`, NOT subscription — and may ALSO appear in the ollama ledger as local usage, so do not sum harness rows across sources without deciding which observation you want. |
| Claude over Ollama | `$XDG_STATE_HOME/ollama-agent/runs.jsonl` | One aggregate event per run: final cumulative input/output tokens; local route | No cache or reasoning classes (null); run-level, not per-request. Ledger `run_id`s identify tasks, not runs — event ids composite content so repeated ids with different totals stay distinct. The ledger records no attempt linkage, so `retryOf` stays null here. |
| Codex | `~/.codex/sessions/**/*.jsonl` rollouts | Session-aggregate token totals; reasoning class where recorded | Billing route unknown (not in rollout records); aggregate events dated by the last token-count record, not session start. OpenAI-style `input_tokens` includes cached input — the adapter subtracts it so every source's columns are disjoint and summable. Model comes from turn-context records when present. Event ids are file-anchored because resumed rollouts can inherit a prior session_meta id. |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` (defaulting to `~/.local/share`) | Per-message input/output/cache/reasoning, **measured cash cost** (`cost` → cash column, route `metered` when > 0), and error state (`error` → status) from message usage | Zero-value cost is genuinely zero on several routed providers; zero token classes can be absent or genuinely zero depending on the plugin. |

Cross-cutting rules:

- A source that exists but cannot be read is reported under **unavailable sources** — its volume is *unknown*, not zero. A source that reads partially names the skipped file count in the footer.
- Without `--since`, timestamp-less events count like any other. With `--since`, an undated event cannot be placed in the window: it is excluded and counted (`untimedExcluded` in JSON, footer line in text) rather than silently kept or dropped.
- `--since` bounds the SCAN, not just aggregation: file sources prefilter by mtime and sqlite filters at the storage layer. Files actually touched inside the window must still be parsed — on a machine with days of in-window transcript volume, expect seconds, not milliseconds.
- A token class that SOME events in a row report and others omit prints with its sum plus a named entry in the `partial` column: the aggregate covers reported events only and is not fully measured.
- Event IDs are source-qualified and deterministic, so re-scans deduplicate. The `retry` column counts events carrying `retryOf`; no source currently links retry attempts, so it reads 0 until one does.
- Cash spend appears only for metered routes once a source meters per request — no manufactured per-request cost for subscription plans. Allowance utilization stays in `--credits` (native five-hour / weekly / monthly units).
- All values are measured from source records; nothing is estimated. Row provenance (distinct source files) ships in the `--json` rows.

---

## Fleet Record Contract

Fleet-aware sources use the additive schema in `src/fleet-contract.ts`. Version `1.0` has two envelopes:

- `usage_event` is one request observation. It may carry nullable token classes and a nullable measured cash charge.
- `operational_snapshot` is an aggregate observation over a half-open time window. Its counters describe the whole window and must never be presented as request-level measurements.

Both envelopes always contain `schema_version`, `record_type`, `record_id`, `run_id`, `session_id`, `request_id`, `prompt_origin_host`, `execution_host`, `router_host`, `backend_host`, `harness`, `provider`, `backend`, `model`, `timestamp`, `status`, and `provenance`. An unavailable value is `null`; it is never `0`, an empty string, or an inferred host or route. Zero is reserved for a source that explicitly measured zero. Status is one of `ok`, `error`, `incomplete`, `partial`, `unavailable`, or `unknown`. Provenance names the source and collection time, with `complete`, `partial`, or `unavailable` completeness.

### Identity, clocks, and joins

- `record_id` is the stable deduplication identity. Identical records with the same ID collapse. Different content with the same ID is a conflict; neither variant wins.
- `run_id`, `session_id`, `request_id`, and snapshot `process_id` are opaque, source-qualified identifiers such as `codex:run-3`. Raw IDs are qualified by the adapter that owns their namespace.
- Correlation precedence is exact `request_id`, then exact `run_id`, then exact `session_id`. A match must also place the event timestamp inside the snapshot's `[window.start, window.end)` interval. One candidate is `matched`, none is `unmatched`, and more than one at the first matching precedence level is `ambiguous`. There is no model, hostname, or nearest-time fallback.
- Timestamps are canonical RFC 3339 UTC values at whole-second or millisecond precision. A usage timestamp is the source-reported request time or `null`; it is never replaced by file modification or collection time. A snapshot timestamp is its observation time, while `provenance.collected_at` is when TokenScope read it. TokenScope does not correct host clock skew. An undated event cannot be placed in a snapshot window and remains unmatched.
- A snapshot is `current` through exactly `stale_after_ms` after its timestamp and `stale` after that. A missing threshold or a future-dated snapshot has unknown freshness.

Snapshot counter deltas are emitted only when both values and both process IDs are present. A changed process ID is `restart`; a lower counter under the same process ID is `reset`; either case has a null delta. Missing values or process identity are `unavailable`, not zero. Snapshot provenance marked `partial` or `unavailable` requires the matching status, and those statuses require matching provenance; all other snapshot statuses require complete provenance. Partial snapshots retain measured counters and leave missing counters null. Unmatched, ambiguous, stale, partial, reset, restart, and unavailable states remain visible to downstream reports.

### Olla telemetry adapter

`collectOllaTelemetry` reads Olla with GET requests from `/internal/status`, `/internal/status/endpoints`, `/internal/status/models`, `/internal/stats/models`, and `/internal/metrics`. It emits v1 `operational_snapshot` records for system, endpoint, model, model-endpoint, and Prometheus observations. Cumulative counters use Olla's `system.start_time` as the snapshot window start and process identity, so a changed start time is a restart and a lower counter under the same start time is a reset.

Endpoint URLs are reduced to scheme, host, port, and path before storage; userinfo, query strings, and fragments are removed. Credential-like URL paths, including generic `token=` and `key=` assignments, are rejected rather than retained. Credential-like base URL paths, queries, fragments, and userinfo are rejected before collection, while provenance locators contain only the validated origin and known internal endpoint path. Every endpoint metadata key and string value, every record-ID component, Prometheus label value, JSON model name, routing string, and observed request/run ID passes the same privacy-safe validation before persistence. This includes assignment values following qualified-ID colons, such as `codex:token=...`. Credential-like source values make their source `partial/privacy`, and no records or metadata from that source are retained. Raw source bodies, headers, prompt data, and authorization fields are not retained. Endpoint and routing strings live in a separate sanitized metadata index rather than being added to the numeric v1 counter map. Missing model `endpoint_ids` produce a null endpoint counter; malformed arrays make the source `partial/malformed` rather than turning unknown placement into zero. Missing and unreadable routes are `unavailable`; stale, malformed, privacy-rejected, and dependency-incomplete routes are `partial`, each with source locator and collection-time provenance. Comparing consecutive collections reports endpoint IDs that disappeared only when the current endpoint source is valid and available; otherwise disappearance is unknown (`null`).

Optional route correlation requires a request or source-qualified run ID already present in the collection's `observedRoutes`, where it is paired with an exact endpoint ID or name. A model may further constrain the observation. The helper returns the unchanged aggregate snapshot, so caller IDs are never injected into snapshot records. An unseen key is `unmatched` with no returned key. If JSON and Prometheus both describe the same exact route, the result is `ambiguous` and carries both provenance records rather than silently selecting a source. There is no model-only, hostname-only, or nearest-time attribution. This adapter is additive and does not change `--providers`; the fleet report is introduced separately.

### Orca placement adapter

`collectOrcaPlacement` invokes the fixed `orca` executable with only the deeply frozen allowlist of `status --json`, `host list --json`, `worktree ps --json`, and `terminal list --json`. It emits v1 `operational_snapshot` records for agent terminals using Orca's explicit `executionHostId`, worktree ID, and documented `TuiAgent` identity enum, including `opencode2`, `freebuff`, and `muse`; arbitrary strings are rejected. Stable host IDs use `orca:local`, `orca:ssh:<target>`, or `orca:runtime:<environment>` and do not include Orca's restart-sensitive runtime ID. Worktree-to-agent correlation requires both source host identity and membership in the worktree response's authoritative host scope. Host/worktree collisions and duplicate pane identities remain partial and unattributed rather than choosing an agent. Terminal identity is the execution host plus the runtime-scoped terminal handle. Exact duplicate rows are deterministically deduplicated and reported partial; rows sharing that identity but conflicting on worktree, pane, or agent fields collapse to one partial record with no worktree or agent attribution. Because paired runtimes require a separate environment-selected collection, validated local and SSH rows remain usable but base listings with omitted paired-runtime host IDs are reported partial. The current Orca terminal JSON does not expose a provider session ID or prompt-origin host, so both fleet fields remain null.

The adapter retains only allowlisted placement fields. A safe terminal handle is exposed only as non-join observation metadata; it is never promoted to `session_id`. Control characters are removed before credential and URL checks, and recognizable raw token forms are rejected at the shared string boundary. Prompt text, assistant previews, tool input, terminal previews/scrollback, selectors, command stderr, credentials, and raw JSON responses are discarded. Missing CLI, unreachable runtime, non-1.x or absent Orca version, failed or malformed commands, omitted hosts, out-of-scope rows, malformed or non-canonical host IDs, mismatched row totals, truncated listings, privacy rejection, unknown host references, worktree collisions, duplicate pane identities, and records missing execution-host or agent identity are reported explicitly through source observations and partial/unavailable record status. This adapter is additive and does not change provider or Olla collection.

### Privacy and migration

Fleet records contain metadata and measured numeric telemetry only. They must not contain prompt text, terminal content or scrollback, credentials, authorization values, raw authorization headers, or arbitrary header collections. The v1 parser rejects those fields, including when nested.

This contract does not replace `ProviderEvent` or alter `--providers`. Existing adapters and nullable token/cost behavior remain unchanged. New fleet adapters should emit v1 envelopes alongside the existing provider events where both views are supported. Historical provider records must not be upgraded by guessing host, route, request, run, or session identity; unavailable fleet fields stay null. A future schema change uses a new `schema_version` and an explicit adapter rather than changing v1 interpretation in place.

---

## Cost Alert Hook

Real-time in-session spend alerts for Claude Code. Fires after each response and
**only ever warns — it never stops or blocks a turn.** Thresholds are credits, so
they mean the same thing as `--credits` and as your plan.

It warns when:
- The session crosses **0.7%, 1.4%, 3.5%, 7%, or 14% of the weekly credit cap** —
  each rung once, on the turn that crosses it. The percentages are cap-relative but
  calibrated to restore the old absolute triggers (8.4M, 16.8M, 42M, 84M, 168M
  credits) after the cap moved 166.7M → 1.2B
- **One turn's context** alone costs more than 0.0056% of the cap (~670k tokens
  of context), reporting the context size and what each further turn costs just
  to re-send it. Calibrated against a real turn, not a round number: a 1.1M-token
  context is ~110k credits, 0.0092% of a 1.2B cap
- The last 3 turns average **>3x the session's own average** (a bloat spike)
- 50 turns is reached, then every 50 after

It checkpoints (writes a resumable session summary) at **3.5% of the weekly cap** —
and on credits alone. A long-but-cheap session gets no file: turn count was the
other half of why 634 of them accumulated. A checkpoint always announces itself,
because a file nobody is told about is a file nobody reads.

**Thresholds used to be dollars, and that was the bug.** The default was $10, while
real sessions run into the hundreds — so it tripped on essentially every session
(634 unread checkpoint files on the machine this was found on) and the alert carried
no information. Dollars also can't answer the question that matters, because the cap
is metered in credits. `TOKEN_SCOPE_CHECKPOINT_AT` is retired; if it is still set the
hook ignores it and says so on stderr rather than reinterpreting a dollar figure as a
percentage.

### Install

Add to `~/.claude/settings.json` under `hooks.Stop`:

```json
{
  "type": "command",
  "command": "bash \"~/ML-AI/claude/token-scope/hooks/cost-alert.sh\"",
  "timeout": 5000
}
```

Replace the path with wherever you cloned token-scope. Requires `bun` in PATH (or set `BUN_PATH`).

### Example output

```
⚠ Crossed 1.4% of the weekly cap (16.8M credits) [16.8M credits, 1.4% of cap / 412 turns / $251.03]
⚠ Context is 1.1M tokens — re-sending it costs ~110k credits per turn (0.0092% of the week, every turn). /clear or a fresh session resets it [144k credits, 0.012% of cap / 6 turns / $2.16]
⚠ Spending is spiking: 121k credits/turn vs 34k avg [30.6M credits, 2.55% of cap / 885 turns / $459.75]
```

The context line is real output from the shipped defaults, not an illustration.
The first version of this section quoted a number 7x below the threshold it
documented, which is how a warning that could never fire got caught.

Dollars stay in the trailer because they're still useful — they're just not what
the cap is denominated in.

---

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--since <duration>` | `30d` | Time window: `Nh`, `Nd`, `Nw` |
| `--limit <n>` | `20` | Max rows per table |
| `--json` | — | Machine-readable JSON output |
| `--source <jsonl\|sqlite>` | auto | Force data source |
| `--db <path>` | auto | Override SQLite database path |
| `--projects-dir <path>` | auto | Override JSONL projects directory |
| `--cap <n>` | `1.2B` | (with `--credits`) weekly credit allowance; accepts `1200000000` or `1.2B` |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `TOKEN_SCOPE_DB` | Override SQLite database path |
| `TOKEN_SCOPE_PROJECTS_DIR` | Colon-separated JSONL project dirs |
| `TOKEN_SCOPE_PRICING_FILE` | Custom pricing JSON |
| `TOKEN_SCOPE_CREDIT_CAP` | Weekly credit cap, for `--credits` and the cost-alert hook; accepts `1200000000` or `1.2B` (`--cap` wins) |
| `TOKEN_SCOPE_CHECKPOINT_PCT` | Checkpoint at this % of the weekly cap (default `3.5`) |
| `TOKEN_SCOPE_CHECKPOINT_TURNS` | Checkpoint at this turn count (default `50`) |
| `TOKEN_SCOPE_TURN_WARN_PCT` | Warn when one turn's CONTEXT costs this % of the cap (default `0.0056`) |
| `TOKEN_SCOPE_CHECKPOINT_DIR` | Checkpoint output dir (default `~/.claude/checkpoints`) |
| `NO_COLOR` | Disable ANSI color |

## Accuracy Notes

- **One row per API response** — Claude Code writes one JSONL entry per content block and repeats the whole `usage` object on each, so a naive line-sum over-reports by ~2.1x. Every total collapses on `message.id` (#19); the sqlite store already stores one row per response.
- **Credits** — weighted-token estimate, calibrated to one metered week (0.6%). Alone among the reports, `--credits` includes subagent turns.
- **Costs** — computed from Anthropic pricing constants in `src/pricing.ts`
- **Thinking tokens** — character-ratio estimates (±15–30% error), prefixed with `~`
- **Cache savings** — estimated from cache read vs full input pricing differential
- **Tool attribution** — `--tools` report counts ALL tool_use blocks per turn and splits cost proportionally by input payload size. Other reports use per-turn dominant tool (largest input).

## Development

**Mutation checking.** When adding or modifying a test that guards a fix, verify the test actually fails when the fix is reverted. Use `scripts/mutation-check.sh` — it is the only sanctioned method. Do not use `git checkout`, `git restore`, or `sed -i` against `src/` in the working tree; those can wipe unstaged work and have done so in this repo (#49).

The script detaches a temporary worktree, applies the mutation there, runs the test suite, and requires failure. The working tree is never touched.

```bash
# Verify a fix is actually guarded by its test
scripts/mutation-check.sh \
  'sed -i "" "s/return collected.events.filter((e) => tsMs(e) === null).length;/return 0;/" src/reports/providers.ts' \
  bun test tests/providers.test.ts

# Or via bun run
bun run mutation-check \
  'sed -i "" "s/return collected.events.filter((e) => tsMs(e) === null).length;/return 0;/" src/reports/providers.ts' \
  bun test tests/providers.test.ts
```

The script exits 0 when tests fail under mutation (correct), exits 1 when tests pass (the test does not guard the fix), and exits 2 when the mutation command itself fails or is a no-op.

## Roadmap

- **Phase 1:** Core terminal reports (summary, tool, project, session, thinking) — shipped
- **Phase 2:** Cost efficiency analytics (cache, efficiency, context bloat, per-project thinking) — shipped
- **Phase 3:** Tooling analysis by layer with proportional cost attribution — shipped
- **Phase 4:** Context contributors, base load, cache-growth waterfall, session budget — shipped
- **Phase 5:** Artifact lifecycle analytics (per-file Write/Edit cost, MD/HTML compare) — shipped
- **Phase 6:** context-loop plugin ROI analytics — shipped
- **Next:** Export any report to Markdown / Obsidian

## License

MIT
