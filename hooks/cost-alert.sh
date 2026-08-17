#!/bin/bash
# token-scope cost alert + auto-checkpoint hook for Claude Code
#
# Fires on the Stop event. Tracks session cost, warns on thresholds/spikes,
# and writes a checkpoint file when cost or turn limits are crossed.
#
# Config (env vars):
#   TOKEN_SCOPE_CHECKPOINT_DIR   — default: ~/.claude/checkpoints
#   TOKEN_SCOPE_CREDIT_CAP       — weekly credit allowance, default: 1.2B
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
# Deliberately NOT defaulted here — an unset variable is passed through as empty
# and cost-alert-worker.ts applies its own default. Duplicating the numbers in
# both files is how the context threshold ended up stuck at the old 0.5% after the
# worker moved to 0.04%: every worker test passed, and production never warned.
CREDIT_CAP="${TOKEN_SCOPE_CREDIT_CAP:-}"
CHECKPOINT_TURNS="${TOKEN_SCOPE_CHECKPOINT_TURNS:-}"
CHECKPOINT_PCT="${TOKEN_SCOPE_CHECKPOINT_PCT:-}"
TURN_WARN_PCT="${TOKEN_SCOPE_TURN_WARN_PCT:-}"

# TOKEN_SCOPE_CREDIT_CAP is read by `--credits` too, through parseCap, which
# accepts a K/M/B suffix — so `166.7M` is a legal value of this variable. Expand
# it to the same number here or the two consumers disagree about what the user's
# own config means, which is exactly the drift src/credits.ts exists to prevent.
case "${CREDIT_CAP:-x}" in
  x) CAP_MULT=1 ;;
  *[kK]) CREDIT_CAP="${CREDIT_CAP%[kK]}"; CAP_MULT=1000 ;;
  *[mM]) CREDIT_CAP="${CREDIT_CAP%[mM]}"; CAP_MULT=1000000 ;;
  *[bB]) CREDIT_CAP="${CREDIT_CAP%[bB]}"; CAP_MULT=1000000000 ;;
  *)     CAP_MULT=1 ;;
esac

# The worker also validates these, but cost-alert.sh discards its stderr, so a
# typo'd value would silently disable all alerting with no diagnostic anywhere.
# Check here, where the message survives.
for pair in "TOKEN_SCOPE_CREDIT_CAP:$CREDIT_CAP" "TOKEN_SCOPE_CHECKPOINT_PCT:$CHECKPOINT_PCT" \
            "TOKEN_SCOPE_TURN_WARN_PCT:$TURN_WARN_PCT" "TOKEN_SCOPE_CHECKPOINT_TURNS:$CHECKPOINT_TURNS"; do
  name="${pair%%:*}"; value="${pair#*:}"
  [ -z "$value" ] && continue      # unset: the worker's own default applies
  case "$value" in
    .|*[!0-9.]*|*.*.*) echo "[cost-alert] $name must be a positive number, optionally suffixed K/M/B (got '$value') — alerts disabled this turn" >&2
      echo '{}'; exit 0 ;;
  esac
  # Reject zero in any spelling without arithmetic: 0, 0.0, .0, 00 ...
  case "${value//0/}" in ''|.) echo "[cost-alert] $name must be greater than zero — alerts disabled this turn" >&2
      echo '{}'; exit 0 ;;
  esac
done

[ -n "$CREDIT_CAP" ] && CREDIT_CAP=$(awk -v n="$CREDIT_CAP" -v m="$CAP_MULT" 'BEGIN { printf "%.0f", n * m }')

if [ -n "${TOKEN_SCOPE_CHECKPOINT_AT:-}" ]; then
  echo "[cost-alert] TOKEN_SCOPE_CHECKPOINT_AT is retired (it was a dollar threshold); use TOKEN_SCOPE_CHECKPOINT_PCT — a percentage of TOKEN_SCOPE_CREDIT_CAP. Ignoring it." >&2
fi

"$BUN" "$HOOK_DIR/cost-alert-worker.ts" "$JSONL_FILE" "$CHECKPOINT_DIR" \
  "$CREDIT_CAP" "$CHECKPOINT_TURNS" "$CHECKPOINT_PCT" "$TURN_WARN_PCT" 2>/dev/null || echo '{}'
