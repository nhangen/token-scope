#!/bin/bash
# token-scope cost alert + auto-checkpoint hook for Claude Code
#
# Fires on the Stop event. Tracks session cost, warns on thresholds/spikes,
# and writes a checkpoint file when cost or turn limits are crossed.
#
# Config (env vars):
#   TOKEN_SCOPE_CHECKPOINT_DIR   — default: ~/.claude/checkpoints
#   TOKEN_SCOPE_CREDIT_CAP       — weekly credit allowance, default: 166.7M
#                                  (same variable --credits reads)
#   TOKEN_SCOPE_CHECKPOINT_PCT   — checkpoint at this % of the weekly cap, default: 25
#   TOKEN_SCOPE_CHECKPOINT_TURNS — turn threshold, default: 50
#   TOKEN_SCOPE_TURN_WARN_PCT    — warn when ONE turn costs this % of the cap, default: 0.5
#
# Thresholds are credits, not dollars. TOKEN_SCOPE_CHECKPOINT_AT (a dollar
# threshold, default $10) is gone: real sessions run into the hundreds of
# dollars, so it tripped on nearly every session and the alert stopped carrying
# information. If it is still set in your environment this hook ignores it and
# says so on stderr rather than silently reinterpreting a dollar figure as a
# percentage.
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
CREDIT_CAP="${TOKEN_SCOPE_CREDIT_CAP:-166700000}"
CHECKPOINT_TURNS="${TOKEN_SCOPE_CHECKPOINT_TURNS:-50}"
CHECKPOINT_PCT="${TOKEN_SCOPE_CHECKPOINT_PCT:-25}"
TURN_WARN_PCT="${TOKEN_SCOPE_TURN_WARN_PCT:-0.5}"

# The worker also validates these, but cost-alert.sh discards its stderr, so a
# typo'd cap would silently disable all alerting with no diagnostic anywhere.
# Check here, where the message survives.
for pair in "TOKEN_SCOPE_CREDIT_CAP:$CREDIT_CAP" "TOKEN_SCOPE_CHECKPOINT_PCT:$CHECKPOINT_PCT" \
            "TOKEN_SCOPE_TURN_WARN_PCT:$TURN_WARN_PCT" "TOKEN_SCOPE_CHECKPOINT_TURNS:$CHECKPOINT_TURNS"; do
  name="${pair%%:*}"; value="${pair#*:}"
  case "$value" in
    ''|*[!0-9.]*|*.*.*) echo "[cost-alert] $name must be a positive number (got '$value') — alerts disabled this turn" >&2
      echo '{}'; exit 0 ;;
  esac
  case "$value" in 0|0.0|0.00) echo "[cost-alert] $name must be greater than zero — alerts disabled this turn" >&2
      echo '{}'; exit 0 ;;
  esac
done

if [ -n "${TOKEN_SCOPE_CHECKPOINT_AT:-}" ]; then
  echo "[cost-alert] TOKEN_SCOPE_CHECKPOINT_AT is retired (it was a dollar threshold); use TOKEN_SCOPE_CHECKPOINT_PCT — a percentage of TOKEN_SCOPE_CREDIT_CAP. Ignoring it." >&2
fi

"$BUN" "$HOOK_DIR/cost-alert-worker.ts" "$JSONL_FILE" "$CHECKPOINT_DIR" \
  "$CREDIT_CAP" "$CHECKPOINT_TURNS" "$CHECKPOINT_PCT" "$TURN_WARN_PCT" 2>/dev/null || echo '{}'
