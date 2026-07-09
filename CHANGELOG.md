# Changelog

All notable changes to token-scope are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- `--savings` report: estimated ollama delegation ROI. Reads the ollama-agent run ledger (`$XDG_STATE_HOME/ollama-agent/runs.jsonl`, or `$OLLAMA_AGENT_LEDGER`; `--ledger` override), values its local token volume at Claude prices (`--counterfactual-model`, default `claude-opus-4-8`), subtracts the session's actual billed Claude spend as PM overhead, and headlines the **net savings** (Counterfactual − PM overhead). Runs with no attributable Claude session are excluded from the net. `--session` scopes to one delegation session; `--since` floors by ledger timestamp.
- `--spend` report: per-turn + per-range Claude (billed) token accounting for one session (output/input/cache-read/cache-write + derived cost), with `--turns N..M` task-slice and `--since` timestamp floor. Rolls up subagent (Task/Agent) overhead so PM-loop cost is visible. Subagent attribution is JSONL-only and session-wide in v1. (#10)
- Phase 1: terminal reports (summary, tool, project, session, thinking, sessions list)
- Read-only access to `~/.claude/__store.db` via `bun:sqlite`
- `--since`, `--limit`, `--json`, `--db`, `--version`, `--help` flags
- Claude Code skill wrapper (`skill/SKILL.md`)
- Pricing constants for cache savings estimation (`src/pricing.ts`)
- Full test suite with fixture database
- CI via GitHub Actions
