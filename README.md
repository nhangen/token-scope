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
token-scope --savings --ledger /path/to/runs.jsonl     # explicit ledger location
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
  delegation (the same direct + subagent rollup `--spend` computes): the real cost of
  Claude playing project-manager (writing tests, auditing, steering).

A **positive net means delegation saved money.** Runs with no attributable Claude session
(null `session_id`, or a session not in the local transcripts) are counted for token volume
but excluded from the net headline. `--since` floors by ledger timestamp when set.

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

## Cost Alert Hook

Real-time in-session cost alerts for Claude Code. Fires after each response and warns when:
- Session cost crosses **$5, $10, $25, or $50**
- Last 3 turns cost **>3× the session average** (context bloat spike)

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
⚠ Cost spiking: $0.467/turn vs $0.135 avg [$150.06 / 1112 turns]
⚠ Session crossed $25 [$25.18 / 247 turns]
```

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

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `TOKEN_SCOPE_DB` | Override SQLite database path |
| `TOKEN_SCOPE_PROJECTS_DIR` | Colon-separated JSONL project dirs |
| `TOKEN_SCOPE_PRICING_FILE` | Custom pricing JSON |
| `NO_COLOR` | Disable ANSI color |

## Accuracy Notes

- **Costs** — computed from Anthropic pricing constants in `src/pricing.ts`
- **Thinking tokens** — character-ratio estimates (±15–30% error), prefixed with `~`
- **Cache savings** — estimated from cache read vs full input pricing differential
- **Tool attribution** — `--tools` report counts ALL tool_use blocks per turn and splits cost proportionally by input payload size. Other reports use per-turn dominant tool (largest input).

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
