#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const file = process.argv[2]!;
const checkpointDir = process.argv[3]!;
const checkpointAt = parseFloat(process.argv[4] ?? "10");
const checkpointTurns = parseInt(process.argv[5] ?? "50");

let raw: string;
try { raw = readFileSync(file, "utf8"); } catch { console.log("{}"); process.exit(0); }
const lines = raw.split("\n").filter(Boolean);

let totalCost = 0;
let turnCount = 0;
const turnCosts: number[] = [];
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

  const model = String(msg["model"] ?? "");
  let inR = 3.0, crR = 0.3, cwR = 3.75, outR = 15.0;
  if (model.includes("opus")) { inR = 15.0; crR = 1.5; cwR = 18.75; outR = 75.0; }
  else if (model.includes("haiku")) { inR = 0.8; crR = 0.08; cwR = 1.0; outR = 4.0; }

  const cost = (out * outR + (usage["input_tokens"] ?? 0) * inR +
    (usage["cache_read_input_tokens"] ?? 0) * crR +
    (usage["cache_creation_input_tokens"] ?? 0) * cwR) / 1_000_000;

  totalCost += cost;
  turnCount++;
  turnCosts.push(cost);
}

if (turnCount === 0) { console.log("{}"); process.exit(0); }

const avgCost = totalCost / turnCount;
const lastCost = turnCosts.at(-1) ?? 0;
const last3Avg = turnCosts.length >= 3
  ? turnCosts.slice(-3).reduce((a, b) => a + b, 0) / 3
  : lastCost;

const alerts: string[] = [];
let shouldCheckpoint = false;

for (const t of [50, 25, 10, 5]) {
  if (totalCost >= t && (totalCost - lastCost) < t) {
    alerts.push(`Session crossed $${t}`);
    if (t >= checkpointAt) shouldCheckpoint = true;
    break;
  }
}

if (turnCount >= 10 && last3Avg > avgCost * 3) {
  alerts.push(`Cost spiking: $${last3Avg.toFixed(3)}/turn vs $${avgCost.toFixed(3)} avg`);
}

if (turnCount >= checkpointTurns) {
  shouldCheckpoint = true;
  if (turnCount === checkpointTurns) alerts.push(`${turnCount} turns reached`);
}

if (totalCost >= checkpointAt) {
  shouldCheckpoint = true;
}

const checkpointFile = join(checkpointDir, (sessionId || "unknown") + ".md");
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
      `cost: ${totalCost.toFixed(2)}`,
      `turns: ${turnCount}`,
      `cwd: ${cwd}`,
      `branch: ${gitBranch}`,
      "---",
      "",
      "# Session Checkpoint",
      "",
      `**Cost:** $${totalCost.toFixed(2)} across ${turnCount} turns ($${avgCost.toFixed(4)}/turn avg)`,
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
  } catch {}
}

const result: Record<string, string> = {};
if (alerts.length > 0) {
  let msg = alerts.join(" | ") + ` [$${totalCost.toFixed(2)} / ${turnCount} turns]`;
  if (shouldCheckpoint && existsSync(checkpointFile)) {
    msg += " — Context checkpointed. Consider starting fresh.";
  }
  result["statusMessage"] = msg;
}
console.log(JSON.stringify(result));
