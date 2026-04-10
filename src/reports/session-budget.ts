import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatUsd, bold, renderFootnote } from "@/format";
import { VERSION } from "@/version";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderSessionBudgetReport(reader: Reader, opts: Options): void {
  const rows = reader.querySessionBudgets(opts.since, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: VERSION },
      report: "budget", rows,
    }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No sessions with 10+ turns found in the last ${opts.sinceStr}.`);
    return;
  }

  const avgAccel = rows.reduce((s, r) => s + (r.costAccelerationRatio ?? 0), 0) / rows.length;

  console.log(renderHeader("token-scope — Session Budget Analysis"));
  console.log(renderKV([
    ["Sessions Analyzed", String(rows.length)],
    ["Avg Cost Acceleration", `${avgAccel.toFixed(1)}× (last 10 turns cost ${avgAccel.toFixed(1)}× more than first 10)`],
  ]));

  if (avgAccel > 1.5) {
    const avgTurns = rows.reduce((s, r) => s + r.turnCount, 0) / rows.length;
    const suggestedClear = Math.round(avgTurns * 0.4);
    console.log(`\n${bold("  Optimal Reset Point")}`);
    console.log(`  Based on your usage patterns, consider /clear after ~${suggestedClear} turns.`);
    console.log(`  Sessions averaging ${Math.round(avgTurns)} turns show ${avgAccel.toFixed(1)}\u00d7 cost acceleration.`);
  }

  console.log(`\n${bold("  Sessions by Cost Acceleration")}`);
  console.log(renderTable(
    [
      { header: "Session", align: "left", width: 14 },
      { header: "Project", align: "left", width: 20 },
      { header: "Turns", align: "right", width: 6 },
      { header: "Total Cost", align: "right", width: 11 },
      { header: "@T10", align: "right", width: 8 },
      { header: "@T25", align: "right", width: 8 },
      { header: "@T50", align: "right", width: 8 },
      { header: "Accel", align: "right", width: 6 },
    ],
    rows.map((r) => [
      r.sessionId.slice(0, 14),
      (r.cwd ?? "(unknown)").split("/").at(-1) ?? "(unknown)",
      String(r.turnCount),
      formatUsd(r.totalCostUsd),
      formatUsd(r.costAtTurn10),
      formatUsd(r.costAtTurn25),
      formatUsd(r.costAtTurn50),
      r.costAccelerationRatio != null ? `${r.costAccelerationRatio.toFixed(1)}×` : "—",
    ])
  ));

  console.log(renderFootnote("Acceleration = avg cost of last 10 turns ÷ avg cost of first 10 turns. Higher = more context bloat cost. Consider /clear when acceleration exceeds 3×."));
  console.log("");
}
