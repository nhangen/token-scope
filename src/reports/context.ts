import type { Reader, ContextStatRow } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, bold, dim } from "@/format";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderContextReport(reader: Reader, opts: Options): void {
  const rows = reader.queryContextStats(opts.since, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "context", rows,
    }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No sessions with 6+ turns found in the last ${opts.sinceStr}.`);
    return;
  }

  const sorted = rows.slice().sort((a, b) => (a.bloatRatio ?? 0) - (b.bloatRatio ?? 0));
  const medianRatio = sorted[Math.floor(sorted.length / 2)]?.bloatRatio ?? null;
  const maxRatio = rows[0]?.bloatRatio ?? null;

  console.log(renderHeader("token-scope — Context Bloat Analysis"));
  console.log(renderKV([
    ["Sessions Analyzed", String(rows.length)],
    ["Max Bloat Ratio", maxRatio != null ? `${maxRatio.toFixed(1)}×` : "—"],
    ["Median Bloat Ratio", medianRatio != null ? `${medianRatio.toFixed(1)}×` : "—"],
  ]));

  console.log(`\n${bold("  Sessions Ranked by Bloat")} ${dim("(early = avg of first 3 turns, late = avg of last 3 turns)")}`);
  console.log(renderTable(
    [
      { header: "Session", align: "left", width: 14 },
      { header: "Project", align: "left", width: 25 },
      { header: "Turns", align: "right", width: 6 },
      { header: "Early Avg Input", align: "right", width: 16 },
      { header: "Late Avg Input", align: "right", width: 15 },
      { header: "Bloat", align: "right", width: 8 },
    ],
    rows.map((r) => [
      r.sessionId.slice(0, 14),
      (r.cwd ?? "(unknown)").split("/").at(-1) ?? "(unknown)",
      String(r.turnCount),
      formatTokens(Math.round(r.avgEarlyInput)),
      formatTokens(Math.round(r.avgLateInput)),
      r.bloatRatio != null ? `${r.bloatRatio.toFixed(1)}×` : "—",
    ])
  ));

  console.log("");
}
