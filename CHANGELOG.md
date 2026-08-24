# Changelog

All notable changes to token-scope are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **The weekly credit cap was measured instead of assumed.** `DEFAULT_WEEKLY_CAP` shipped as 166.7M, described as Max 20x and never checked against the meter. Read against Claude Code's `/usage` — 7% of a weekly limit on a Max 5x plan over a window measuring 126.8M credits — it is ~1.2B, so both the value and the tier label were wrong. Four consecutive real weeks used to report 1.77x-4.74x of cap, which would have meant sustained lockout that never happened; they now read 0.25x-0.66x. Max 20x scales to roughly 4.8B, but that is inferred and unmeasured.
- **Two thresholds moved with it, because both are shares of the cap.** `TOKEN_SCOPE_TURN_WARN_PCT` is now `0.0056` (was `0.04`): its calibration target is a concrete ~1.1M-token turn, and at 0.04% of 1.2B that turn stopped firing. `TOKEN_SCOPE_CHECKPOINT_PCT` is now `3.5` (was `25`): 25% of 1.2B is 300M credits in one session, which fired on 1 of 963 real sessions against 18 for the old trigger — a checkpoint that never fires is indistinguishable from no session being heavy enough.
- **The rung ladder rescaled with the cap.** `RUNG_PCTS` moved from `[100, 50, 25, 10, 5]` to `[14, 7, 3.5, 1.4, 0.7]`, restoring the old absolute triggers (168M, 84M, 42M, 16.8M, 8.4M credits). Measured across 963 real sessions: the old ladder against 1.2B fired on 1/1/1/14 sessions respectively; the new ladder fires on 5/13/18/~37, matching the pre-rescale incidence. A rung that never fires is indistinguishable from "no session was heavy enough."
- `cost-alert-worker.ts` no longer keeps its own copy of the cap default, and `cost-alert.sh`'s header no longer documents any threshold defaults. Both were second copies that had already drifted, under a comment explaining why second copies must not exist.

### Added
- `computeWindows()` buckets turns into **rolling 5-hour windows**, the limit that actually binds a heavy user — `/usage` showed 64% of a 5h window consumed in twenty minutes while the same week sat at 7%. Pure and tested; not yet wired into the `--credits` report.

## [1.5.0] — 2026-08-12

### Changed
- **cost-alert hook thresholds are credits, not dollars.** The old $10 default tripped on essentially every real session (634 unread checkpoints on one machine), and dollars can't answer whether a session is a rounding error or a fifth of the week — the cap is metered in credits. Rungs are now 5/10/25/50/100% of `TOKEN_SCOPE_CREDIT_CAP`, each firing once on the turn that crosses it. New: `TOKEN_SCOPE_CHECKPOINT_PCT` (default 25), `TOKEN_SCOPE_TURN_WARN_PCT` (default 0.5). `TOKEN_SCOPE_CHECKPOINT_AT` is retired — the hook ignores it and says so on stderr rather than silently reading a dollar figure as a percentage.
- The hook now warns on **context size**, the thing that actually drives the bill: when one turn's context costs more than 0.04% of the cap (~800k tokens), it reports the context and what each further turn costs just to re-send it. The threshold is calibrated against a real turn — 0.5% needed 8.3M tokens of context against a 1M window and could never fire.
- **Turn count no longer writes a checkpoint.** That trigger, not the dollar threshold, was the other half of why 634 checkpoint files accumulated: a long-but-cheap session got a file, and once the credit rungs went quiet it got one silently. Checkpoints are credit-driven, and always announce themselves.
- `TOKEN_SCOPE_CREDIT_CAP` accepts a `K`/`M`/`B` suffix in the hook, matching what `--credits` already accepted through the same variable. The hook used to reject `166.7M` and silently disable all alerting, so one variable meant two things to two consumers.
- Threshold defaults now live only in `cost-alert-worker.ts`; `cost-alert.sh` passes an empty argument when a variable is unset. Writing them in both files is how the context threshold stayed at 0.5% in production after the worker moved to 0.04% — every worker-level test passed while the warning could never fire.
- `.claude-plugin/plugin.json` now carries the same version as `package.json`, with a test asserting it. The 1.4.0 release bumped `package.json` and `src/version.ts` but not the manifest, so the marketplace kept installing 1.3.2 and every fix stayed undelivered.
- Removed the "escalating cost warning" that fired on every turn once a session passed 5x the threshold. A warning that repeats forever is one the reader learns to ignore, which cost the other rungs their meaning too.
- Credit weights, the cap, and `parseCap` moved to `src/credits.ts`, shared by the report and the hook so the two can't drift into different units.

## [1.4.0] — 2026-08-12

### Added
- `--credits` — weekly consumption in credits (weighted tokens) against the plan cap, with an end-of-week projection for the week in progress (suppressed below 20% elapsed, where extrapolation is noise). `--cap` / `TOKEN_SCOPE_CREDIT_CAP` set the allowance. Alone among the reports it includes subagent turns, which spend the same allowance, and prices their share rather than only counting them. Weeks whose start falls outside `--since` are marked `partial (window)` and excluded from the average, so a half-observed week can't be read as a whole one.

### Fixed
- Every JSONL total over-reported by ~2.1x. Claude Code writes one entry per content block and repeats the whole `usage` object on each; the reader summed lines. Totals now collapse on `message.id` (#19, #20). Affects tokens, cost, and turn counts — a trailing week previously read $1,456 / 14,378 turns against a real $603 / 7,108.
- `hooks/cost-alert-worker.ts` had the same bug independently, so its thresholds fired at roughly half the intended spend and checkpointed at half the intended turn count.

## [1.2.0] — 2026-04-21

### Fixed
- Skill execute block used `BASH_SOURCE[0]` which is empty when Claude Code runs it — skill produced no output
- Skill and hook now resolve plugin install path dynamically via `sort -V | tail -1` so version bumps don't break them
- Bun path resolution uses `BUN_PATH` env, `command -v`, then `~/.bun/bin/bun` fallback

## [1.1.0] — 2026-04-09

### Added
- Phase 4: Cache Intelligence reports
  - `--base-load` — system prompt tax per project (turn 1 context size)
  - `--cache-growth <id>` — turn-by-turn cache waterfall for a session with spike detection
  - `--contributors` — cache_write aggregated by tool type (what bloats context fastest)
  - `--budget` — session cost acceleration analysis with optimal reset point guidance
- Enhanced `--context` report with cache breakdown columns (Avg CW/Turn, Total CW)

### Fixed
- Context bloat report now measures total context (input + cache_read + cache_write) instead of just uncached input_tokens, which was always 1-5 tokens with prompt caching (v1.0.1)

## [Unreleased]

### Added
- `--savings --pm-cost <usd>`: use a caller-measured dollar figure as PM overhead (requires `--session`, mutually exclusive with `--pm-turns`) — the honest denominator when the PM was a subagent, whose cost neither whole-session nor turn-scoped views can isolate (subagent spend is session-wide in v1). No transcript lookup: also attributes sessions absent from local transcripts. JSON `pm_scope` gains `{mode: "measured", cost_usd}`. (#16)
- `--savings --pm-turns N..M`: scope PM overhead to the delegation's orchestration turns (1-indexed inclusive, requires `--session`) instead of the whole session — the only way to get a meaningful per-task net. Turn-scoped PM excludes session-wide subagent cost (a floor); JSON gains a `pm_scope` field. The ledger has no delegation-start marker, so the window is caller-isolated (as with `--spend --turns`), not auto-derived.
- `--savings` report: estimated ollama delegation ROI. Reads the ollama-agent run ledger (`$XDG_STATE_HOME/ollama-agent/runs.jsonl`, or `$OLLAMA_AGENT_LEDGER`; `--ledger` override), values its local token volume at Claude prices (`--counterfactual-model`, default `claude-opus-4-8`), subtracts the session's actual billed Claude spend as PM overhead, and headlines the **net savings** (Counterfactual − PM overhead). Runs with no attributable Claude session are excluded from the net. `--session` scopes to one delegation session; `--since` floors by ledger timestamp.
- `--spend` report: per-turn + per-range Claude (billed) token accounting for one session (output/input/cache-read/cache-write + derived cost), with `--turns N..M` task-slice and `--since` timestamp floor. Rolls up subagent (Task/Agent) overhead so PM-loop cost is visible. Subagent attribution is JSONL-only and session-wide in v1. (#10)
- Phase 1: terminal reports (summary, tool, project, session, thinking, sessions list)
- Read-only access to `~/.claude/__store.db` via `bun:sqlite`
- `--since`, `--limit`, `--json`, `--db`, `--version`, `--help` flags
- Claude Code skill wrapper (`skill/SKILL.md`)
- Pricing constants for cache savings estimation (`src/pricing.ts`)
- Full test suite with fixture database
- CI via GitHub Actions
