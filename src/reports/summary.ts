import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatUsd, formatPct, bold } from "@/format";

interface Options { since: number; limit: number; json: boolean }

export function renderSummary(reader: Reader, opts: Options): void {
  const totals = reader.querySummaryTotals(opts.since);
  const byTool = reader.queryByTool(opts.since, opts.limit);
  const byProject = reader.queryByProject(opts.since, opts.limit);
  const weekly = reader.queryWeeklyTrend(opts.since);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
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

  const cacheHitRate = totals.totalInputTokens + totals.totalCacheReadTokens > 0
    ? (totals.totalCacheReadTokens / (totals.totalInputTokens + totals.totalCacheReadTokens)) * 100
    : null;

  console.log(`\n${bold("  Cache Efficiency")}`);
  console.log(renderKV([
    ["Cache Hit Rate", formatPct(cacheHitRate)],
    ["Est. Cache Savings", "— (requires model breakdown)"],
  ]));

  console.log(`\n${bold("  Output Tokens by Tool")}`);
  console.log(renderTable(
    [
      { header: "Tool", align: "left" },
      { header: "Turns", align: "right", width: 7 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Output %", align: "right", width: 9 },
      { header: "Avg/Turn", align: "right", width: 10 },
      { header: "Total Cost", align: "right", width: 11 },
      { header: "Cost %", align: "right", width: 7 },
    ],
    byTool.map((r) => [r.tool, String(r.turns), formatTokens(r.outputTokens), formatPct(r.outputPct), formatTokens(r.avgOutputPerTurn), formatUsd(r.totalCostUsd), formatPct(r.costPct)])
  ));
  console.log(renderFootnote("Each turn attributed to its dominant tool by input character size. Output tokens are turn-level totals."));

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
