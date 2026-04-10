import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatPct, bold, renderFootnote } from "@/format";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderContributorsReport(reader: Reader, opts: Options): void {
  const rows = reader.queryContextContributors(opts.since, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "contributors", rows,
    }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No data found in the last ${opts.sinceStr}.`);
    return;
  }

  const totalCW = rows.reduce((s, r) => s + r.totalCacheWrite, 0);
  const totalTurns = rows.reduce((s, r) => s + r.turns, 0);

  console.log(renderHeader("token-scope — Context Contributors"));
  console.log(renderKV([
    ["Total Cache Writes", formatTokens(totalCW)],
    ["Turns Analyzed", String(totalTurns)],
  ]));

  console.log(`\n${bold("  By Tool")} (what adds the most to your context window)`);
  console.log(renderTable(
    [
      { header: "Tool", align: "left", width: 20 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Total Added", align: "right", width: 13 },
      { header: "Avg/Turn", align: "right", width: 10 },
      { header: "Max Spike", align: "right", width: 10 },
      { header: "Share", align: "right", width: 7 },
      { header: "Est. Cost", align: "right", width: 10 },
    ],
    rows.map((r) => [
      r.tool,
      String(r.turns),
      formatTokens(r.totalCacheWrite),
      formatTokens(Math.round(r.avgCacheWrite)),
      formatTokens(r.maxCacheWrite),
      formatPct(r.pctOfTotal),
      formatUsd(r.estimatedCostUsd),
    ])
  ));

  console.log(renderFootnote("Cache writes = new content entering context each turn. Reducing large contributors shrinks cumulative cache reads."));
  console.log("");
}
