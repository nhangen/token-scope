import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatPct, truncate, bold } from "@/format";
import { parseContentBlocks, resolveDominantTool, categorizeBashCommand } from "@/parse";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderToolDrillDown(reader: Reader, toolName: string, opts: Options): void {
  const normalizedName = toolName.charAt(0).toUpperCase() + toolName.slice(1).toLowerCase();
  const allTurns = reader.queryRawTurnsForTool(opts.since);
  const allTotals = reader.querySummaryTotals(opts.since);

  const toolTurns = allTurns.filter((t) => resolveDominantTool(parseContentBlocks(t.message)).toLowerCase() === toolName.toLowerCase());

  if (toolTurns.length === 0) {
    console.log(`No turns found for tool "${normalizedName}" in the last ${opts.sinceStr}.`);
    return;
  }

  const totalOutput = toolTurns.reduce((s, t) => s + t.outputTokens, 0);
  const totalCost = toolTurns.reduce((s, t) => s + (t.costUsd ?? 0), 0);
  const sorted = [...toolTurns].sort((a, b) => a.outputTokens - b.outputTokens);
  const p50 = sorted[Math.floor(sorted.length * 0.5)]?.outputTokens ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]?.outputTokens ?? 0;
  const shareOutput = allTotals.totalOutputTokens > 0 ? (totalOutput / allTotals.totalOutputTokens) * 100 : 0;
  const shareCost = (allTotals.totalCostUsd ?? 0) > 0 ? (totalCost / (allTotals.totalCostUsd ?? 1)) * 100 : 0;

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "tool", toolName: normalizedName,
      overview: { turns: toolTurns.length, totalOutputTokens: totalOutput, totalCostUsd: totalCost, shareOutputPct: shareOutput, shareCostPct: shareCost },
    }, null, 2));
    return;
  }

  console.log(renderHeader(`token-scope — Tool: ${bold(normalizedName)}`));
  console.log(renderKV([
    ["Turns (dominant)", String(toolTurns.length)],
    ["Total Output Tokens", formatTokens(totalOutput)],
    ["Total Cost", formatUsd(totalCost)],
    ["Share of All Output", formatPct(shareOutput)],
    ["Share of All Cost", formatPct(shareCost)],
    ["Avg Output / Turn", formatTokens(totalOutput / toolTurns.length)],
    ["Distribution (p50/p95/max)", `${formatTokens(p50)} / ${formatTokens(p95)} / ${formatTokens(sorted.at(-1)?.outputTokens)}`],
  ]));

  if (toolName.toLowerCase() === "bash") {
    const bashTurns = reader.queryBashTurns(opts.since);
    const categories = new Map<string, { turns: number; outputTokens: number; costUsd: number }>();
    for (const t of bashTurns) {
      const cat = categorizeBashCommand(t.command ?? "");
      const e = categories.get(cat) ?? { turns: 0, outputTokens: 0, costUsd: 0 };
      categories.set(cat, { turns: e.turns + 1, outputTokens: e.outputTokens + t.outputTokens, costUsd: e.costUsd + (t.costUsd ?? 0) });
    }

    const catRows = Array.from(categories.entries())
      .sort((a, b) => b[1].outputTokens - a[1].outputTokens)
      .map(([cat, d]) => [cat, String(d.turns), formatTokens(d.outputTokens), formatTokens(d.outputTokens / d.turns), formatUsd(d.costUsd)]);

    console.log(`\n${bold("  Command Categories")}`);
    console.log(renderTable(
      [
        { header: "Category", align: "left" },
        { header: "Turns", align: "right", width: 7 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Avg/Turn", align: "right", width: 10 },
        { header: "Total Cost", align: "right", width: 11 },
      ],
      catRows
    ));

    const topCommands = [...bashTurns].sort((a, b) => b.outputTokens - a.outputTokens).slice(0, opts.limit);
    console.log(`\n${bold("  Most Expensive Commands")}`);
    console.log(renderTable(
      [
        { header: "Command", align: "left", width: 60 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Cost", align: "right", width: 10 },
      ],
      topCommands.map((t) => [truncate(t.command ?? "(none)", 60), formatTokens(t.outputTokens), formatUsd(t.costUsd)])
    ));
  }

  console.log("");
}
