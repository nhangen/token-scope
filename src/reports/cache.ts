import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatPct, bold } from "@/format";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderCacheReport(reader: Reader, opts: Options): void {
  const rows = reader.queryCacheStats(opts.since, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "cache", rows,
    }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No cache data found in the last ${opts.sinceStr}.`);
    return;
  }

  const totalSavings = rows.reduce((s, r) => s + (r.estimatedSavingsUsd ?? 0), 0);
  const totalCacheRead = rows.reduce((s, r) => s + r.totalCacheReadTokens, 0);
  const totalInput = rows.reduce((s, r) => s + r.totalInputTokens, 0);
  const overallHitPct = totalInput + totalCacheRead > 0
    ? (totalCacheRead / (totalInput + totalCacheRead)) * 100 : null;

  console.log(renderHeader("token-scope — Cache Efficiency"));
  console.log(renderKV([
    ["Projects", String(rows.length)],
    ["Overall Cache Hit %", formatPct(overallHitPct)],
    ["Est. Total Savings", formatUsd(totalSavings > 0 ? totalSavings : null)],
  ]));

  console.log(`\n${bold("  By Project")}`);
  console.log(renderTable(
    [
      { header: "Project", align: "left", width: 30 },
      { header: "Sessions", align: "right", width: 9 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Cache Hit %", align: "right", width: 12 },
      { header: "Cache Reads", align: "right", width: 13 },
      { header: "Est. Savings", align: "right", width: 13 },
    ],
    rows.map((r) => [
      r.cwd.split("/").at(-1) ?? r.cwd,
      String(r.sessions),
      String(r.turns),
      formatPct(r.cacheHitPct),
      formatTokens(r.totalCacheReadTokens),
      formatUsd(r.estimatedSavingsUsd),
    ])
  ));

  console.log("");
}
