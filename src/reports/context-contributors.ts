import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatPct, bold, renderFootnote } from "@/format";
import { VERSION } from "@/version";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderContributorsReport(reader: Reader, opts: Options, projectFragment?: string): void {
  const rows = reader.queryContextContributors(opts.since, opts.limit, projectFragment);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: VERSION },
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

  const title = projectFragment
    ? `token-scope — Context Contributors (project: ${projectFragment})`
    : "token-scope — Context Contributors";
  console.log(renderHeader(title));
  const kvPairs: [string, string][] = [
    ["Total Cache Writes", formatTokens(totalCW)],
    ["Turns Analyzed", String(totalTurns)],
  ];
  if (projectFragment) kvPairs.push(["Project Filter", projectFragment]);
  console.log(renderKV(kvPairs));

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

  const topContributor = rows[0];
  if (topContributor && topContributor.pctOfTotal > 25) {
    console.log(`\n${bold("  Recommendations")}`);
    const toolName = topContributor.tool;
    if (toolName === "Read") {
      console.log(`  - Read operations contribute ${topContributor.pctOfTotal.toFixed(0)}% of context growth. Use offset/limit to read smaller file slices.`);
    } else if (toolName === "Agent") {
      console.log(`  - Agent subagent results contribute ${topContributor.pctOfTotal.toFixed(0)}% of context growth. Consider whether results can be summarized.`);
    } else if (toolName === "Edit") {
      console.log(`  - Edit operations contribute ${topContributor.pctOfTotal.toFixed(0)}% of context growth. Large edits add significant context.`);
    } else if (toolName === "Bash") {
      console.log(`  - Bash output contributes ${topContributor.pctOfTotal.toFixed(0)}% of context growth. Use RTK or filter verbose output.`);
    } else if (toolName === "(text only)") {
      console.log(`  - Text-only turns contribute ${topContributor.pctOfTotal.toFixed(0)}% of context growth. Long conversations without tool use still accumulate context.`);
    } else {
      console.log(`  - ${toolName} contributes ${topContributor.pctOfTotal.toFixed(0)}% of context growth.`);
    }
  }

  console.log(renderFootnote("Cache writes = new content entering context each turn. Reducing large contributors shrinks cumulative cache reads."));
  console.log("");
}
