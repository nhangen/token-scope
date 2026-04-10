import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, bold, renderFootnote } from "@/format";

export function renderCacheGrowthReport(reader: Reader, sessionId: string, json: boolean, sinceStr: string): void {
  const rows = reader.queryCacheGrowth(sessionId);

  if (json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), session_id: sessionId, token_scope_version: "1.0.0" },
      report: "cache-growth", rows,
    }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No turns found for session "${sessionId}".`);
    return;
  }

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const totalCost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const bloat = first.totalContext > 0 ? last.totalContext / first.totalContext : null;

  console.log(renderHeader(`token-scope — Cache Growth: ${sessionId.slice(0, 12)}…`));
  console.log(renderKV([
    ["Turns", String(rows.length)],
    ["Start Context", formatTokens(first.totalContext) + " tokens"],
    ["End Context", formatTokens(last.totalContext) + " tokens"],
    ["Growth", bloat != null ? `${bloat.toFixed(1)}×` : "—"],
    ["Total Cost", formatUsd(totalCost)],
  ]));

  console.log(`\n${bold("  Turn-by-Turn Waterfall")}`);
  console.log(renderTable(
    [
      { header: "Turn", align: "right", width: 5 },
      { header: "Total Context", align: "right", width: 14 },
      { header: "Cache Read", align: "right", width: 11 },
      { header: "Cache Write", align: "right", width: 12 },
      { header: "Delta", align: "right", width: 8 },
      { header: "Cost", align: "right", width: 8 },
      { header: "Tool", align: "left", width: 20 },
    ],
    rows.map((r) => [
      String(r.turn),
      formatTokens(r.totalContext),
      formatTokens(r.cacheRead),
      formatTokens(r.cacheWrite),
      r.turn === 1 ? "—" : (r.delta >= 0 ? `+${formatTokens(r.delta)}` : formatTokens(r.delta)),
      formatUsd(r.costUsd),
      r.tool,
    ])
  ));

  const spikes = rows.filter(r => r.turn > 1).sort((a, b) => b.cacheWrite - a.cacheWrite).slice(0, 5);
  if (spikes.length > 0) {
    console.log(`\n${bold("  Top 5 Context Spikes")}`);
    console.log(renderTable(
      [
        { header: "Turn", align: "right", width: 5 },
        { header: "Cache Write", align: "right", width: 12 },
        { header: "Tool", align: "left", width: 20 },
      ],
      spikes.map((r) => [
        String(r.turn),
        formatTokens(r.cacheWrite),
        r.tool,
      ])
    ));
  }

  console.log(renderFootnote("Delta = change in total context from previous turn. Large cache writes indicate new content entering context."));
  console.log("");
}
