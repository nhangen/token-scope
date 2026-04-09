#!/bin/bash
# token-scope cost alert + auto-checkpoint hook for Claude Code
#
# Fires on the Stop event. Tracks session cost, warns on thresholds/spikes,
# and writes a checkpoint file when cost or turn limits are crossed.
#
# Config (env vars):
#   TOKEN_SCOPE_CHECKPOINT_DIR   — default: ~/.claude/checkpoints
#   TOKEN_SCOPE_CHECKPOINT_AT    — dollar threshold, default: 10
#   TOKEN_SCOPE_CHECKPOINT_TURNS — turn threshold, default: 50
#
# Install: add to ~/.claude/settings.json under hooks.Stop:
#   { "type": "command", "command": "bash \"<path>/hooks/cost-alert.sh\"", "timeout": 5000 }

set -euo pipefail

INPUT=$(cat)

JSONL_FILE=$(echo "$INPUT" | /usr/bin/jq -r '.transcript_path // empty' 2>/dev/null)

if [ -z "$JSONL_FILE" ] || [ ! -f "$JSONL_FILE" ]; then
  SESSION_ID=$(echo "$INPUT" | /usr/bin/jq -r '.session_id // empty' 2>/dev/null)
  if [ -z "$SESSION_ID" ]; then
    echo '{}'
    exit 0
  fi
  for dir in "$HOME/.claude/projects"/*/; do
    candidate="${dir}${SESSION_ID}.jsonl"
    if [ -f "$candidate" ]; then
      JSONL_FILE="$candidate"
      break
    fi
  done
fi

if [ -z "$JSONL_FILE" ] || [ ! -f "$JSONL_FILE" ]; then
  echo '{}'
  exit 0
fi

BUN="${BUN_PATH:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"
if [ ! -x "$BUN" ]; then
  echo '{}'
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKPOINT_DIR="${TOKEN_SCOPE_CHECKPOINT_DIR:-$HOME/.claude/checkpoints}"
CHECKPOINT_AT="${TOKEN_SCOPE_CHECKPOINT_AT:-10}"
CHECKPOINT_TURNS="${TOKEN_SCOPE_CHECKPOINT_TURNS:-50}"

"$BUN" "$HOOK_DIR/cost-alert-worker.ts" "$JSONL_FILE" "$CHECKPOINT_DIR" "$CHECKPOINT_AT" "$CHECKPOINT_TURNS" 2>/dev/null || echo '{}'
