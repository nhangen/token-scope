import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, bold, renderFootnote } from "@/format";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderBaseLoadReport(reader: Reader, opts: Options): void {
  const rows = reader.queryBaseLoad(opts.since, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "base-load", rows,
    }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No sessions found in the last ${opts.sinceStr}.`);
    return;
  }

  const heaviest = rows[0]?.avgBaseTokens ?? 0;
  const lightest = rows[rows.length - 1]?.avgBaseTokens ?? 0;

  console.log(renderHeader("token-scope — Base Load (System Prompt Tax)"));
  console.log(renderKV([
    ["Projects", String(rows.length)],
    ["Heaviest Base Load", formatTokens(heaviest) + " tokens"],
    ["Lightest Base Load", formatTokens(lightest) + " tokens"],
  ]));

  console.log(`\n${bold("  By Project")}`);
  console.log(renderTable(
    [
      { header: "Project", align: "left", width: 30 },
      { header: "Sessions", align: "right", width: 9 },
      { header: "Avg Base", align: "right", width: 10 },
      { header: "Min", align: "right", width: 8 },
      { header: "Max", align: "right", width: 8 },
      { header: "Est. Cost", align: "right", width: 10 },
    ],
    rows.map((r) => [
      r.cwd.split("/").at(-1) ?? r.cwd,
      String(r.sessions),
      formatTokens(r.avgBaseTokens),
      formatTokens(r.minBaseTokens),
      formatTokens(r.maxBaseTokens),
      formatUsd(r.estimatedBaseCostUsd),
    ])
  ));

  console.log(renderFootnote("Base load = turn 1 context size (system prompt + CLAUDE.md + rules + MCP instructions). Reducing these reduces the fixed cost of every session."));
  console.log("");
}
