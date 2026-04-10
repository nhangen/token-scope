import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatUsd, formatPct, bold, dim } from "@/format";
import { VERSION } from "@/version";

interface Options { since: number; limit: number; json: boolean }

export function renderSummary(reader: Reader, opts: Options): void {
  const totals = reader.querySummaryTotals(opts.since);
  const byTool = reader.queryByTool(opts.since, opts.limit);
  const byProject = reader.queryByProject(opts.since, opts.limit);
  const weekly = reader.queryWeeklyTrend(opts.since);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: VERSION },
      report: "summary", totals, byTool, byProject, weeklyTrend: weekly,
    }, null, 2));
    return;
  }

  const sinceDate = new Date(opts.since * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  console.log(renderHeader(`token-scope — Summary  (${sinceDate} → now)`));
  console.log(`  Sessions: ${bold(String(totals.sessionCount))}   Turns: ${bold(String(totals.turnCount))}\n`);

  console.log(bold("  Totals"));
  console.log(renderKV([
    ["Output Tokens", formatTokens(totals.totalOutputTokens)],
    ["Input Tokens", formatTokens(totals.totalInputTokens)],
    ["Cache Read Tokens", formatTokens(totals.totalCacheReadTokens)],
    ["Cache Write Tokens", formatTokens(totals.totalCacheWriteTokens)],
    ["Total Cost", formatUsd(totals.totalCostUsd)],
    ["Avg Cost / Session", formatUsd(totals.avgCostPerSession)],
    ["Avg Cost / Turn", formatUsd(totals.avgCostPerTurn)],
  ]));

  const totalKnownCost = (totals.outputCostUsd ?? 0) + (totals.inputCostUsd ?? 0)
    + (totals.cacheReadCostUsd ?? 0) + (totals.cacheWriteCostUsd ?? 0);
  if (totalKnownCost > 0) {
    console.log(`\n${bold("  Cost by Token Type")}`);
    console.log(renderKV([
      ["Output (generation)", `${formatUsd(totals.outputCostUsd)} (${formatPct((totals.outputCostUsd ?? 0) / totalKnownCost * 100)})`],
      ["Input (non-cached)", `${formatUsd(totals.inputCostUsd)} (${formatPct((totals.inputCostUsd ?? 0) / totalKnownCost * 100)})`],
      ["Cache Read", `${formatUsd(totals.cacheReadCostUsd)} (${formatPct((totals.cacheReadCostUsd ?? 0) / totalKnownCost * 100)})`],
      ["Cache Write", `${formatUsd(totals.cacheWriteCostUsd)} (${formatPct((totals.cacheWriteCostUsd ?? 0) / totalKnownCost * 100)})`],
    ]));
  }

  const cacheHitRate = totals.totalInputTokens + totals.totalCacheReadTokens > 0
    ? (totals.totalCacheReadTokens / (totals.totalInputTokens + totals.totalCacheReadTokens)) * 100
    : null;

  console.log(`\n${bold("  Cache Efficiency")}`);
  console.log(renderKV([
    ["Cache Hit Rate", formatPct(cacheHitRate)],
  ]));

  console.log(`\n${bold("  Cost by Tool")} ${dim("(dominant tool per turn)")}`);
  console.log(renderTable(
    [
      { header: "Tool", align: "left" },
      { header: "Turns", align: "right", width: 7 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Total Cost", align: "right", width: 11 },
      { header: "Cost %", align: "right", width: 7 },
      { header: "Avg Cost/Turn", align: "right", width: 13 },
    ],
    byTool.map((r) => [r.tool, String(r.turns), formatTokens(r.outputTokens), formatUsd(r.totalCostUsd), formatPct(r.costPct), formatUsd(r.totalCostUsd != null && r.turns > 0 ? r.totalCostUsd / r.turns : null)])
  ));
  console.log(renderFootnote("Cost includes input + output + cache tokens for each turn. Turn attributed to dominant tool by input payload size."));

  console.log(`\n${bold("  Output Tokens by Project")}`);
  console.log(renderTable(
    [
      { header: "Project", align: "left" },
      { header: "Sessions", align: "right", width: 9 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Total Cost", align: "right", width: 11 },
      { header: "Avg Session Cost", align: "right", width: 17 },
    ],
    byProject.map((r) => [r.cwd ?? "(unknown)", String(r.sessions), String(r.turns), formatTokens(r.outputTokens), formatUsd(r.totalCostUsd), formatUsd(r.avgSessionCost)])
  ));

  if (weekly.length > 0) {
    console.log(`\n${bold("  Weekly Trend")}`);
    console.log(renderTable(
      [
        { header: "Week", align: "left", width: 10 },
        { header: "Sessions", align: "right", width: 9 },
        { header: "Turns", align: "right", width: 7 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Total Cost", align: "right", width: 11 },
      ],
      weekly.map((r) => [r.weekLabel, String(r.sessions), String(r.turns), formatTokens(r.outputTokens), formatUsd(r.totalCostUsd, 2)])
    ));
  }

  console.log("");
}
