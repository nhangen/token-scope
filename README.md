# token-scope

**Google Analytics for Claude Code output tokens.**

Reads Claude Code's `~/.claude/__store.db` in read-only mode and shows exactly where your output tokens go — by tool, project, session, and thinking blocks.

## Why

Claude Code users have no built-in visibility into output token spend. `token-scope` fills that gap retroactively, with no proxy, no tokenizer, and no daemon. The data is already in `__store.db`.

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
```

As a Claude Code skill:
```bash
claude skill add ~/ML-AI/token-scope/skill/SKILL.md
```

Direct invocation:
```bash
bun run ~/ML-AI/token-scope/src/cli.ts
```

## Usage

| Command | What it shows |
|---------|--------------|
| `token-scope` | Summary: totals, by-tool, by-project, weekly trend |
| `token-scope --tool bash` | Bash command category breakdown |
| `token-scope --tool agent` | Agent task breakdown |
| `token-scope --project wp-content` | Filtered to one project |
| `token-scope --sessions` | Sessions list sorted by cost |
| `token-scope --session abc123` | Turn-by-turn breakdown |
| `token-scope --thinking` | Thinking token analysis |
| `token-scope --since 7d --json` | Last 7 days as JSON |

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--since <Nd>` | `30d` | Time window: Nh, Nd, Nw |
| `--limit <n>` | `20` | Max rows per table |
| `--json` | — | Machine-readable JSON |
| `--db <path>` | `~/.claude/__store.db` | Override DB path |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `TOKEN_SCOPE_DB` | Override database path |
| `TOKEN_SCOPE_PRICING_FILE` | Custom pricing JSON (same schema as `src/pricing.ts`) |
| `NO_COLOR` | Disable ANSI color |

## Accuracy Notes

- **Costs** — read from `cost_usd` column in the database (exact)
- **Thinking tokens** — character-ratio estimates (±15–30% error), prefixed with `~`
- **Cache savings** — estimated using pricing constants in `src/pricing.ts`
- **Tool attribution** — per-turn dominant tool (largest input character count); no double-counting

## Roadmap

- **Phase 1 (now):** Terminal reports
- **Phase 2:** Compiled binaries, Homebrew, HTML dashboard
- **Phase 3:** Optimization recommendations

## License

MIT
