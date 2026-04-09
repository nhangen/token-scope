import { parseContentBlocks } from "@/parse";
import type { ContentBlock } from "@/parse";
import type { RawTurnForTool } from "@/reader";

export type ToolLayer = "plugin" | "mcp" | "skill" | "meta" | "builtin";

export interface ToolClassification {
  layer: ToolLayer;
  server?: string;
  shortName?: string;
}

const META_TOOLS = new Set([
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "Task", "TodoWrite", "EnterPlanMode", "ExitPlanMode", "ToolSearch",
]);

export function classifyTool(name: string): ToolClassification {
  if (name.startsWith("mcp__plugin_")) {
    const parts = name.split("__");
    const vendorServer = (parts[1] ?? "").replace(/^plugin_/, "");
    const serverSegments = vendorServer.split("_");
    const server = serverSegments[serverSegments.length - 1] ?? "unknown";
    const shortName = parts.slice(2).join("__") || name;
    return { layer: "plugin", server, shortName };
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const server = parts[1] ?? "unknown";
    const shortName = parts.slice(2).join("__") || name;
    return { layer: "mcp", server, shortName };
  }
  if (name === "Skill") return { layer: "skill" };
  if (META_TOOLS.has(name)) return { layer: "meta" };
  return { layer: "builtin" };
}

interface ToolEntry {
  name: string;
  layer: ToolLayer;
  server: string | null;
  shortName: string | null;
  calls: number;
  attributedCost: number;
}

interface LayerEntry {
  layer: string;
  calls: number;
  attributedCost: number;
  costPct: number;
  avgCostPerCall: number;
}

export interface ToolAnalysis {
  summary: {
    totalCalls: number;
    distinctTools: number;
    activeLayers: number;
    unclassifiedCount: number;
  };
  layers: LayerEntry[];
  byTool: ToolEntry[];
  unclassified: string[];
}

export function analyzeTooling(turns: RawTurnForTool[]): ToolAnalysis {
  const toolMap = new Map<string, ToolEntry>();
  const unclassifiedSet = new Set<string>();
  let totalCalls = 0;

  for (const turn of turns) {
    const blocks = parseContentBlocks(turn.message);
    const toolBlocks = blocks.filter((b): b is ContentBlock & { name: string } =>
      b.type === "tool_use" && typeof b.name === "string"
    );

    if (toolBlocks.length === 0) {
      const key = "(no tool)";
      const entry = toolMap.get(key) ?? { name: key, layer: "(no tool)" as ToolLayer, server: null, shortName: null, calls: 0, attributedCost: 0 };
      entry.calls++;
      entry.attributedCost += turn.costUsd ?? 0;
      toolMap.set(key, entry);
      totalCalls++;
      continue;
    }

    const sizes = toolBlocks.map((b) => JSON.stringify(b.input ?? {}).length);
    const totalSize = sizes.reduce((s, n) => s + n, 0);

    for (let i = 0; i < toolBlocks.length; i++) {
      const block = toolBlocks[i]!;
      const name = block.name;
      const proportion = totalSize > 0 ? sizes[i]! / totalSize : 1 / toolBlocks.length;
      const cost = (turn.costUsd ?? 0) * proportion;

      const classification = classifyTool(name);
      const entry = toolMap.get(name) ?? {
        name,
        layer: classification.layer,
        server: classification.server ?? null,
        shortName: classification.shortName ?? null,
        calls: 0,
        attributedCost: 0,
      };
      entry.calls++;
      entry.attributedCost += cost;
      toolMap.set(name, entry);
      totalCalls++;
    }
  }

  const byTool = Array.from(toolMap.values()).sort((a, b) => b.attributedCost - a.attributedCost);

  const layerMap = new Map<string, { calls: number; cost: number }>();
  for (const tool of byTool) {
    const key = tool.layer;
    const e = layerMap.get(key) ?? { calls: 0, cost: 0 };
    e.calls += tool.calls;
    e.cost += tool.attributedCost;
    layerMap.set(key, e);
  }

  const totalCost = byTool.reduce((s, t) => s + t.attributedCost, 0);
  const layerOrder = ["builtin", "mcp", "plugin", "skill", "meta", "(no tool)"];
  const layers = layerOrder
    .filter((l) => layerMap.has(l))
    .map((l) => {
      const d = layerMap.get(l)!;
      return {
        layer: l,
        calls: d.calls,
        attributedCost: d.cost,
        costPct: totalCost > 0 ? (d.cost / totalCost) * 100 : 0,
        avgCostPerCall: d.calls > 0 ? d.cost / d.calls : 0,
      };
    });

  const knownLayers: Set<string> = new Set(["plugin", "mcp", "skill", "meta", "builtin", "(no tool)"]);
  const activeLayers = layers.filter((l) => knownLayers.has(l.layer) && l.layer !== "(no tool)").length;

  return {
    summary: {
      totalCalls,
      distinctTools: new Set(byTool.map((t) => t.name)).size,
      activeLayers,
      unclassifiedCount: unclassifiedSet.size,
    },
    layers,
    byTool,
    unclassified: [...unclassifiedSet],
  };
}
