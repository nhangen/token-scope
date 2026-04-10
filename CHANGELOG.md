# Changelog

All notable changes to token-scope are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Phase 1: terminal reports (summary, tool, project, session, thinking, sessions list)
- Read-only access to `~/.claude/__store.db` via `bun:sqlite`
- `--since`, `--limit`, `--json`, `--db`, `--version`, `--help` flags
- Claude Code skill wrapper (`skill/SKILL.md`)
- Pricing constants for cache savings estimation (`src/pricing.ts`)
- Full test suite with fixture database
- CI via GitHub Actions
