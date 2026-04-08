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
git clone https://github.com/nhangen/token-scope ~/ML-AI/token-scope
cd ~/ML-AI/token-scope
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
- **Tool attribution** — per-turn dominant tool (largest input payload); MCP tools with small inputs may be outcompeted by Bash/Read/Edit in the same turn

## Roadmap

- **Phase 1:** Core terminal reports (summary, tool, project, session, thinking)
- **Phase 2 (current):** Cost efficiency analytics (cache, efficiency, context bloat, per-project thinking)
- **Phase 3:** Full MCP tool attribution; count all tool calls per turn, not just dominant

## License

MIT
