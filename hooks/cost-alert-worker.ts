#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { creditsOf, fmtCredits, CREDIT_WEIGHTS, DEFAULT_WEEKLY_CAP } from "../src/credits";

// Defaults live HERE and only here. cost-alert.sh passes an empty argument when
// the corresponding env var is unset, so a default written in both files cannot
// silently disagree — which it did: the wrapper kept passing the old 0.5% context
// threshold after this file moved to 0.04%, so the warning still could not fire
// in production while every worker-level test said it could.
//
// Thresholds are a share of the WEEKLY CREDIT CAP, not dollars. The plan is
// metered in credits, so dollars can't say whether a session is a rounding error
// or a fifth of the week's allowance. The old $10 default was the concrete
// failure: real sessions run hundreds of dollars, so it tripped on essentially
// every session (634 checkpoint files on this machine) and the signal was noise.
const file = process.argv[2]!;
const checkpointDir = process.argv[3]!;
/**
 * Weekly credit allowance this session's share is measured against.
 *
 * Imported rather than written out, because this file's own header rule — a
 * default written in two places silently disagrees — applied to the cap too and
 * was not being followed: this line carried its own copy of 166.7M, so
 * correcting DEFAULT_WEEKLY_CAP would have moved the report while leaving every
 * hook threshold on the old number.
 */
const weeklyCap = parseFloat(process.argv[4] || String(DEFAULT_WEEKLY_CAP));
const checkpointTurns = parseInt(process.argv[5] || "50");
/**
 * Checkpoint once a session has consumed this share of the weekly cap.
 *
 * Rescaled with the cap, like turnWarnPct below, because both are shares and
 * raising the cap 7.2x made each one that much harder to trip. 25% of 1.2B is
 * 300M credits in a single session: measured across 963 real sessions, the old
 * 41.7M trigger fired on 18 of them and 300M fires on exactly 1. A checkpoint
 * that never fires is indistinguishable from "no session was heavy enough",
 * since nothing is written and nothing is said.
 *
 * 3.5% restores that 41.7M trigger, which is the value the behaviour was
 * actually tuned against. An earlier revision kept 25% on the theory that a
 * scaled value made the checkpoint displace the context warning — that was
 * wrong. The checkpoint line is pushed only when `alerts` is already empty, so
 * it is the displaced, never the displacer; the real cause of what was observed
 * was turnWarnPct, fixed separately.
 */
const checkpointPct = parseFloat(process.argv[6] || "3.5");
/**
 * Warn when a single turn's CONTEXT costs this share of the weekly cap. The
 * default is calibrated against a real turn rather than picked round: a ~1.1M
 * token context costs ~110k credits, which is 0.0092% of a 1.2B cap. The first
 * cut used 0.5%, needing 8.3M tokens of context against a 1M window — it could
 * never fire, and the README example it shipped with was 7x below its own
 * threshold, which is how the mistake was caught.
 */
const turnWarnPct = parseFloat(process.argv[7] || "0.0056");

// A malformed value must not silently become 0 and fire every rung at once.
for (const [name, v] of [["cap", weeklyCap], ["checkpoint-pct", checkpointPct], ["turn-warn-pct", turnWarnPct], ["turns", checkpointTurns]] as const) {
  if (!Number.isFinite(v) || v <= 0) {
    process.stderr.write(`cost-alert: ${name} must be a positive number (got ${v})\n`);
    console.log("{}");
    process.exit(0);
  }
}

let raw: string;
try { raw = readFileSync(file, "utf8"); } catch { console.log("{}"); process.exit(0); }
const lines = raw.split("\n").filter(Boolean);

let totalCost = 0;
let totalCredits = 0;
let turnCount = 0;
const turnCosts: number[] = [];
const turnCredits: number[] = [];
/** Context carried into each turn — cache reads are its size, and its price. */
const turnContext: number[] = [];
const countedTurns = new Set<string>();
let sessionId = "";
let cwd = "";
const filesModified = new Set<string>();
const toolsUsed = new Map<string, number>();
let lastUserMsg = "";
let gitBranch = "";

for (const line of lines) {
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(line); } catch { continue; }

  if (!sessionId && obj["sessionId"]) sessionId = String(obj["sessionId"]);
  if (obj["cwd"]) cwd = String(obj["cwd"]);
  if (obj["gitBranch"]) gitBranch = String(obj["gitBranch"]);

  if (obj["type"] === "user") {
    const content = (obj["message"] as Record<string, unknown>)?.["content"];
    if (typeof content === "string" && content.length > 0) lastUserMsg = content.slice(0, 200);
    else if (Array.isArray(content)) {
      const text = content.find((b: Record<string, unknown>) => b["type"] === "text") as Record<string, unknown> | undefined;
      if (text?.["text"]) lastUserMsg = String(text["text"]).slice(0, 200);
    }
    continue;
  }

  if (obj["type"] !== "assistant") continue;
  const msg = obj["message"] as Record<string, unknown> | undefined;
  if (!msg) continue;
  const usage = msg["usage"] as Record<string, number> | undefined;
  if (!usage) continue;
  const out = usage["output_tokens"] ?? 0;
  if (out <= 0) continue;

  if (Array.isArray(msg["content"])) {
    for (const block of msg["content"] as Array<Record<string, unknown>>) {
      if (block["type"] !== "tool_use" || !block["name"]) continue;
      const name = String(block["name"]);
      toolsUsed.set(name, (toolsUsed.get(name) ?? 0) + 1);
      const inp = (block["input"] ?? {}) as Record<string, unknown>;
      if (inp["file_path"]) {
        if (name === "Edit" || name === "Write") filesModified.add(String(inp["file_path"]));
      }
    }
  }

  // Every content-block entry of one response repeats the same `usage` object,
  // so cost and turn count collapse on message.id (#19) — but the tool_use walk
  // above must NOT, since each entry carries a different block. Skipping the
  // whole iteration would drop every tool after the first.
  const turnKey = typeof msg["id"] === "string" && msg["id"] !== ""
    ? `id:${msg["id"]}`
    : `uuid:${String(obj["uuid"] ?? "")}`;
  if (countedTurns.has(turnKey)) continue;
  countedTurns.add(turnKey);

  const model = String(msg["model"] ?? "");
  let inR = 3.0, crR = 0.3, cwR = 3.75, outR = 15.0;
  if (model.includes("opus")) { inR = 15.0; crR = 1.5; cwR = 18.75; outR = 75.0; }
  else if (model.includes("haiku")) { inR = 0.8; crR = 0.08; cwR = 1.0; outR = 4.0; }

  const inputTokens = usage["input_tokens"] ?? 0;
  const cacheReadTokens = usage["cache_read_input_tokens"] ?? 0;
  const cacheWriteTokens = usage["cache_creation_input_tokens"] ?? 0;

  const cost = (out * outR + inputTokens * inR +
    cacheReadTokens * crR + cacheWriteTokens * cwR) / 1_000_000;
  const credits = creditsOf({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens: out });

  totalCost += cost;
  totalCredits += credits;
  turnCount++;
  turnCosts.push(cost);
  turnCredits.push(credits);
  turnContext.push(inputTokens + cacheReadTokens + cacheWriteTokens);
}

if (turnCount === 0) { console.log("{}"); process.exit(0); }

const avgCost = totalCost / turnCount;
const lastCredits = turnCredits.at(-1) ?? 0;
const avgCredits = totalCredits / turnCount;
const last3Avg = turnCredits.length >= 3
  ? turnCredits.slice(-3).reduce((a, b) => a + b, 0) / 3
  : lastCredits;
const context = turnContext.at(-1) ?? 0;
/**
 * Credits attributable to re-sending context, per turn. Separate from the turn's
 * total because output-driven cost is real but /clear does nothing for it, and a
 * warning that says "context" while measuring output sends the reader to the
 * wrong lever.
 */
// Cache-read weight only: cache WRITES are context being established, which
// /clear also resets, but they are one-off per prefix — folding them in would
// make a fresh session look like a bloated one.
const contextCredits = turnContext.map((c) => c * CREDIT_WEIGHTS.cacheRead);
const lastContextCredits = contextCredits.at(-1) ?? 0;
/** Highest so far, so the warning fires once ever — not again on every dip and rise. */
const priorContextPeak = contextCredits.length > 1
  ? Math.max(...contextCredits.slice(0, -1))
  : 0;
const capPct = (totalCredits / weeklyCap) * 100;

const alerts: string[] = [];
let shouldCheckpoint = false;

// Rungs are shares of the weekly cap. Each fires only on the turn that crosses
// it — `totalCredits - lastCredits` is where the session stood one turn ago — so
// a rung announces itself once and then stays quiet. Descending, first match
// wins, so crossing several rungs in one expensive turn reports the highest.
//
// Rescaled with the cap, like checkpointPct and turnWarnPct above, because all
// three are shares and raising the cap 7.2x made each one that much harder to
// trip. Measured across 963 real sessions (#28): the old [100, 50, 25, 10, 5]
// rungs against a 166.7M cap fired on 5/13/18/~37 sessions respectively; the
// same percentages against 1.2B fire on 1/1/1/14 sessions. A rung that never
// fires is indistinguishable from "no session was heavy enough".
//
// The new percentages restore the old absolute triggers:
//   14% of 1.2B = 168M ≈ old 100% (166.7M)
//    7% of 1.2B =  84M ≈ old  50% (83.4M)
//  3.5% of 1.2B =  42M ≈ old  25% (41.7M)
//  1.4% of 1.2B = 16.8M ≈ old  10% (16.7M)
//  0.7% of 1.2B = 8.4M  ≈ old   5% (8.34M)
const RUNG_PCTS = [14, 7, 3.5, 1.4, 0.7];
for (const pct of RUNG_PCTS) {
  const rung = weeklyCap * (pct / 100);
  if (totalCredits >= rung && (totalCredits - lastCredits) < rung) {
    alerts.push(`Crossed ${pct}% of the weekly cap (${fmtCredits(totalCredits)} credits)`);
    break;
  }
}

// Context is the lever: cache reads are ~60% of a weighted week and they scale
// with how much context each turn re-sends, not with how much is said. Warn when
// one turn alone costs a meaningful slice of the week — and only on the crossing
// turn, so a long session in a big context doesn't nag every turn.
const turnWarnAt = weeklyCap * (turnWarnPct / 100);
if (lastContextCredits >= turnWarnAt && priorContextPeak < turnWarnAt) {
  alerts.push(
    `Context is ${fmtCredits(context)} tokens — re-sending it costs ~${fmtCredits(lastContextCredits)} credits ` +
    `per turn (${((lastContextCredits / weeklyCap) * 100).toFixed(2)}% of the week, every turn). ` +
    `/clear or a fresh session resets it`
  );
}

if (turnCount >= 10 && last3Avg > avgCredits * 3) {
  alerts.push(`Spending is spiking: ${fmtCredits(last3Avg)} credits/turn vs ${fmtCredits(avgCredits)} avg`);
}

// Turn count alone no longer checkpoints. That trigger, not the dollar
// threshold, is what kept the pile growing: a 60-turn session that spent almost
// nothing still got a file, and now that the credit rungs are quiet it got one
// with NO status message at all — silently, which is worse than noisily. A
// checkpoint is for a session worth resuming, and cheap-but-long is not that.
if (turnCount === checkpointTurns) alerts.push(`${turnCount} turns reached`);

if (capPct >= checkpointPct) shouldCheckpoint = true;

// Recurring turn-count reminder, every 50 turns past the checkpoint threshold.
if (turnCount > checkpointTurns && turnCount % 50 === 0) {
  const multiple = Math.round(turnCount / checkpointTurns);
  alerts.push(`${turnCount} turns (${multiple}x optimal) — consider /clear`);
}

// Deliberately absent: the old "escalating cost warning" that fired on EVERY
// subsequent turn once a session passed 5x the threshold. Past the top rung
// there is nothing new to say, and a warning that repeats forever is one the
// reader learns to ignore — which costs the rungs their meaning too.

const checkpointFile = join(checkpointDir, (sessionId || "unknown") + ".md");
let wroteCheckpoint = false;
if (shouldCheckpoint && !existsSync(checkpointFile)) {
  try {
    mkdirSync(checkpointDir, { recursive: true });
    const topTools = [...toolsUsed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const recentFiles = [...filesModified].slice(-10);
    const now = new Date().toISOString();

    const md = [
      "---",
      `session: ${sessionId}`,
      `date: ${now.split("T")[0]}`,
      `credits: ${Math.round(totalCredits)}`,
      `cap_pct: ${capPct.toFixed(1)}`,
      `cost: ${totalCost.toFixed(2)}`,
      `turns: ${turnCount}`,
      `cwd: ${cwd}`,
      `branch: ${gitBranch}`,
      "---",
      "",
      "# Session Checkpoint",
      "",
      `**Credits:** ${fmtCredits(totalCredits)} — ${capPct.toFixed(1)}% of the weekly cap, across ${turnCount} turns (${fmtCredits(avgCredits)}/turn avg)`,
      `**Context at checkpoint:** ${fmtCredits(context)} tokens, so ~${fmtCredits(context * CREDIT_WEIGHTS.cacheRead)} credits per further turn just to re-send it`,
      `**Cost:** $${totalCost.toFixed(2)} ($${avgCost.toFixed(4)}/turn avg) — secondary; the cap is metered in credits`,
      `**Working directory:** ${cwd}`,
      `**Branch:** ${gitBranch || "unknown"}`,
      `**Checkpointed:** ${now}`,
      "",
      "## Recent Files Modified",
      ...(recentFiles.length > 0 ? recentFiles.map(f => `- ${f}`) : ["- (none tracked)"]),
      "",
      "## Tools Used",
      ...topTools.map(([t, c]) => `- ${t} (${c} calls)`),
      "",
      "## Last User Message",
      `> ${(lastUserMsg || "(none)").replace(/\n/g, " ")}`,
      "",
      "## Resume",
      "Start a fresh session in the same directory. This checkpoint is at:",
      `\`${checkpointFile}\``,
    ].join("\n");

    writeFileSync(checkpointFile, md);
    wroteCheckpoint = true;
  } catch {}
}

// A checkpoint the user is never told about is a file that accumulates unread —
// 634 of them did. Announce the write, and only the write: keying this on
// `shouldCheckpoint` would re-announce on every later turn, which is the
// every-turn nag this change exists to remove.
if (wroteCheckpoint && alerts.length === 0) {
  alerts.push(`Checkpointed at ${capPct.toFixed(0)}% of the weekly cap`);
}

const result: Record<string, string> = {};
if (alerts.length > 0) {
  let msg = alerts.join(" | ") + ` [${fmtCredits(totalCredits)} credits, ${capPct.toFixed(1)}% of cap / ${turnCount} turns / $${totalCost.toFixed(2)}]`;
  if (shouldCheckpoint && existsSync(checkpointFile)) {
    msg += " — Context checkpointed. Consider starting fresh.";
  }
  result["statusMessage"] = msg;
}
console.log(JSON.stringify(result));
