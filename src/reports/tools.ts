import type { Reader } from "@/reader";
import { analyzeTooling } from "@/tools";
import type { ToolLayer } from "@/tools";
import { renderHeader, renderKV, renderTable, formatUsd, formatPct, bold, dim, renderFootnote } from "@/format";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderToolingReport(reader: Reader, opts: Options): void {
  const turns = reader.queryRawTurnsForTool(opts.since);
  const analysis = analyzeTooling(turns);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "tools",
      summary: analysis.summary,
      layers: analysis.layers,
      byTool: analysis.byTool,
      unclassified: analysis.unclassified,
    }, null, 2));
    return;
  }

  if (analysis.summary.totalCalls === 0) {
    console.log(`No tool calls found in the last ${opts.sinceStr}.`);
    return;
  }

  console.log(renderHeader("token-scope — Tooling Analysis"));
  console.log(renderKV([
    ["Total Tool Calls", String(analysis.summary.totalCalls)],
    ["Distinct Tools", String(analysis.summary.distinctTools)],
    ["Layers Active", `${analysis.summary.activeLayers} of 5`],
    ["Unclassified Tools", String(analysis.summary.unclassifiedCount)],
  ]));

  const layerLabel = (l: string) => {
    switch (l) {
      case "builtin": return "Built-in";
      case "mcp": return "MCP";
      case "plugin": return "Plugin";
      case "skill": return "Skill";
      case "meta": return "Meta";
      default: return l;
    }
  };

  console.log(`\n${bold("  Cost by Layer")}`);
  console.log(renderTable(
    [
      { header: "Layer", align: "left", width: 12 },
      { header: "Calls", align: "right", width: 7 },
      { header: "Attributed Cost", align: "right", width: 16 },
      { header: "Cost %", align: "right", width: 8 },
      { header: "Avg/Call", align: "right", width: 10 },
    ],
    analysis.layers.map((l) => [
      layerLabel(l.layer),
      String(l.calls),
      formatUsd(l.attributedCost),
      formatPct(l.costPct),
      formatUsd(l.avgCostPerCall),
    ])
  ));

  const renderLayerSection = (layer: ToolLayer | "(no tool)", title: string, showServer: boolean) => {
    const tools = analysis.byTool.filter((t) => t.layer === layer).slice(0, opts.limit);
    if (tools.length === 0) return;

    console.log(`\n${bold(`  ── ${title} ──`)}`);
    if (showServer) {
      console.log(renderTable(
        [
          { header: "Server", align: "left", width: 18 },
          { header: "Tool", align: "left", width: 24 },
          { header: "Calls", align: "right", width: 7 },
          { header: "Attributed Cost", align: "right", width: 16 },
        ],
        tools.map((t) => [t.server ?? "—", t.shortName ?? t.name, String(t.calls), formatUsd(t.attributedCost)])
      ));
    } else {
      console.log(renderTable(
        [
          { header: "Tool", align: "left", width: 24 },
          { header: "Calls", align: "right", width: 7 },
          { header: "Attributed Cost", align: "right", width: 16 },
          { header: "Avg/Call", align: "right", width: 10 },
        ],
        tools.map((t) => [t.shortName ?? t.name, String(t.calls), formatUsd(t.attributedCost), formatUsd(t.calls > 0 ? t.attributedCost / t.calls : 0)])
      ));
    }
  };

  renderLayerSection("builtin", "Built-in Tools", false);
  renderLayerSection("mcp", "MCP Servers", true);
  renderLayerSection("plugin", "Plugins", true);
  renderLayerSection("skill", "Skills", false);
  renderLayerSection("meta", "Meta / Orchestration", false);

  console.log(renderFootnote("Hooks run as shell commands, not tool_use blocks — invisible here."));
  console.log(renderFootnote("Cost attributed proportionally by input payload size per turn."));

  if (analysis.unclassified.length > 0) {
    console.log(`\n${bold("  Unclassified Tools")}`);
    for (const name of analysis.unclassified) {
      console.log(`    ${name}`);
    }
  }

  console.log("");
}
