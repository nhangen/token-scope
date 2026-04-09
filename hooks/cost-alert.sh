#!/bin/bash
# token-scope cost alert hook for Claude Code
#
# Fires on the Stop event after each complete response. Reads the session
# JSONL to track cumulative cost and warns when:
#   - Session cost crosses $5, $10, $25, or $50
#   - Last 3 turns cost >3× the session average (spike detection)
#
# Install:
#   Add to ~/.claude/settings.json under hooks.Stop:
#   {
#     "type": "command",
#     "command": "bash \"<path-to-token-scope>/hooks/cost-alert.sh\"",
#     "timeout": 5000
#   }
#
# Requires: bun (uses token-scope's pricing logic inline for speed)

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

# Resolve bun path
BUN="${BUN_PATH:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"
if [ ! -x "$BUN" ]; then
  echo '{}'
  exit 0
fi

"$BUN" -e "
const fs = require('fs');
const file = process.argv[1];
let raw;
try { raw = fs.readFileSync(file, 'utf8'); } catch { console.log('{}'); process.exit(0); }
const lines = raw.split('\n').filter(Boolean);

let totalCost = 0;
let turnCount = 0;
const turnCosts = [];

for (const line of lines) {
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  if (obj.type !== 'assistant') continue;
  const msg = obj.message;
  if (!msg?.usage) continue;
  const out = msg.usage.output_tokens ?? 0;
  if (out <= 0) continue;

  const model = msg.model ?? '';
  let inR = 3.0, crR = 0.3, cwR = 3.75, outR = 15.0;
  if (model.includes('opus')) { inR = 15.0; crR = 1.5; cwR = 18.75; outR = 75.0; }
  else if (model.includes('haiku')) { inR = 0.8; crR = 0.08; cwR = 1.0; outR = 4.0; }

  const cost = (out * outR + (msg.usage.input_tokens ?? 0) * inR +
    (msg.usage.cache_read_input_tokens ?? 0) * crR +
    (msg.usage.cache_creation_input_tokens ?? 0) * cwR) / 1_000_000;

  totalCost += cost;
  turnCount++;
  turnCosts.push(cost);
}

if (turnCount === 0) { console.log('{}'); process.exit(0); }

const avgCost = totalCost / turnCount;
const lastCost = turnCosts.at(-1) ?? 0;
const last3Avg = turnCosts.length >= 3
  ? turnCosts.slice(-3).reduce((a, b) => a + b, 0) / 3
  : lastCost;

const alerts = [];

for (const t of [50, 25, 10, 5]) {
  if (totalCost >= t && (totalCost - lastCost) < t) {
    alerts.push('Session crossed \$' + t);
    break;
  }
}

if (turnCount >= 10 && last3Avg > avgCost * 3) {
  alerts.push('Cost spiking: \$' + last3Avg.toFixed(3) + '/turn vs \$' + avgCost.toFixed(3) + ' avg');
}

const result = {};
if (alerts.length > 0) {
  result.statusMessage = alerts.join(' | ') + ' [\$' + totalCost.toFixed(2) + ' / ' + turnCount + ' turns]';
}
console.log(JSON.stringify(result));
" "$JSONL_FILE" 2>/dev/null || echo '{}'
