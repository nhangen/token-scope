# Changelog

All notable changes to token-scope are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Phase 1: terminal reports (summary, tool, project, session, thinking, sessions list)
- Read-only access to `~/.claude/__store.db` via `bun:sqlite`
- `--since`, `--limit`, `--json`, `--db`, `--version`, `--help` flags
- Claude Code skill wrapper (`skill/SKILL.md`)
- Pricing constants for cache savings estimation (`src/pricing.ts`)
- Full test suite with fixture database
- CI via GitHub Actions
