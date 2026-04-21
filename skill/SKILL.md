---
name: token-scope
description: Analyze Claude Code output token spend — by tool, project, session, and thinking blocks. Reads ~/.claude/__store.db in read-only mode.
version: 1.0.0
author: nhangen
---

# token-scope

Analyze your Claude Code output token spend without leaving the terminal.

## Prerequisites

Bun 1.1.0+ — install from https://bun.sh

## Setup

```bash
git clone https://github.com/nhangen/token-scope ~/ML-AI/token-scope
cd ~/ML-AI/token-scope
bun install
claude skill add ~/ML-AI/token-scope/skill/SKILL.md
```

## Usage

```
token-scope                        # Summary by-tool, by-project, weekly trend
token-scope --tool bash            # Bash command breakdown
token-scope --project wp-content   # Filter to one project
token-scope --sessions             # List recent sessions
token-scope --session <id>         # Turn-by-turn breakdown
token-scope --thinking             # Thinking token analysis
token-scope --since 7d --json      # JSON output
```

## execute

```bash
PLUGIN_BASE="$HOME/.claude/plugins/cache/nhangen-tools/token-scope"
REPO_DIR=$(ls -1d "$PLUGIN_BASE"/*/ 2>/dev/null | sort -V | tail -1)

if [ -z "$REPO_DIR" ]; then
  echo "Error: token-scope plugin not found in $PLUGIN_BASE"
  exit 1
fi

BUN="${BUN_PATH:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"
if [ ! -x "$BUN" ]; then
  echo "Error: bun is not installed. Install from https://bun.sh and re-run."
  exit 1
fi

"$BUN" run "${REPO_DIR}src/cli.ts" "$@"
exit $?
```
