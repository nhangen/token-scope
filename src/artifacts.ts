import { parseContentBlocks } from "@/parse";
import type { ContentBlock } from "@/parse";
import type { RawTurnForTool } from "@/db";

export type ArtifactFormat =
  | "md" | "html" | "json" | "yaml" | "toml"
  | "ts" | "tsx" | "js" | "jsx" | "py" | "rb" | "php" | "go" | "rs" | "java"
  | "sh" | "bash" | "zsh"
  | "css" | "scss"
  | "sql"
  | "txt"
  | "other";

const EXTENSION_MAP: Record<string, ArtifactFormat> = {
  md: "md", markdown: "md", mdx: "md",
  html: "html", htm: "html",
  json: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  ts: "ts", tsx: "tsx", mts: "ts", cts: "ts",
  js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  py: "py",
  rb: "rb",
  php: "php",
  go: "go",
  rs: "rs",
  java: "java",
  sh: "sh", bash: "bash", zsh: "zsh",
  css: "css", scss: "scss", sass: "scss",
  sql: "sql",
  txt: "txt",
};

export function classifyFormat(filePath: string): ArtifactFormat {
  const lastDot = filePath.lastIndexOf(".");
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastDot < 0 || lastDot < lastSlash) return "other";
  const ext = filePath.slice(lastDot + 1).toLowerCase();
  return EXTENSION_MAP[ext] ?? "other";
}

export interface ArtifactEntry {
  path: string;
  format: ArtifactFormat;
  edits: number;            // number of distinct turns containing a Write/Edit on this path
  firstSeen: number;        // earliest assistant_messages.timestamp (epoch seconds)
  lastSeen: number;
  attributedCost: number;   // proportional cost USD across all writes/edits
  outputTokens: number;     // proportional output tokens
  sessions: number;         // number of distinct sessions touching this artifact
}

export interface ArtifactAnalysis {
  summary: {
    distinctArtifacts: number;
    totalWrites: number;
    totalCost: number;
    formats: Array<{ format: ArtifactFormat; artifacts: number; cost: number }>;
  };
  byArtifact: ArtifactEntry[];
}

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

interface AccumulatorEntry {
  path: string;
  format: ArtifactFormat;
  turns: Set<string>;
  sessions: Set<string>;
  firstSeen: number;
  lastSeen: number;
  attributedCost: number;
  outputTokens: number;
}

export function analyzeArtifacts(
  turns: Array<RawTurnForTool & { timestamp?: number }>
): ArtifactAnalysis {
  const map = new Map<string, AccumulatorEntry>();

  for (const turn of turns) {
    const blocks = parseContentBlocks(turn.message);
    const writeBlocks = blocks.filter((b): b is ContentBlock & { name: string; input: Record<string, unknown> } =>
      b.type === "tool_use" &&
      typeof b.name === "string" &&
      WRITE_TOOLS.has(b.name) &&
      typeof b.input === "object" &&
      b.input !== null &&
      typeof (b.input as Record<string, unknown>).file_path === "string"
    );

    if (writeBlocks.length === 0) continue;

    const allBlocks = blocks.filter((b) => b.type === "tool_use" && typeof b.name === "string");
    const allSizes = allBlocks.map((b) => JSON.stringify(b.input ?? {}).length);
    const allTotalSize = allSizes.reduce((s, n) => s + n, 0);

    const ts = turn.timestamp ?? 0;

    for (let i = 0; i < writeBlocks.length; i++) {
      const block = writeBlocks[i]!;
      const path = String(block.input.file_path);
      const format = classifyFormat(path);

      const blockSize = JSON.stringify(block.input ?? {}).length;
      const proportion = allTotalSize > 0 ? blockSize / allTotalSize : 1 / allBlocks.length;
      const cost = (turn.costUsd ?? 0) * proportion;
      const tokens = turn.outputTokens * proportion;

      const entry = map.get(path) ?? {
        path,
        format,
        turns: new Set<string>(),
        sessions: new Set<string>(),
        firstSeen: ts || Number.MAX_SAFE_INTEGER,
        lastSeen: ts,
        attributedCost: 0,
        outputTokens: 0,
      };
      entry.turns.add(turn.uuid);
      entry.sessions.add(turn.sessionId);
      if (ts > 0 && ts < entry.firstSeen) entry.firstSeen = ts;
      if (ts > entry.lastSeen) entry.lastSeen = ts;
      entry.attributedCost += cost;
      entry.outputTokens += tokens;
      map.set(path, entry);
    }
  }

  const byArtifact: ArtifactEntry[] = Array.from(map.values())
    .map((e) => ({
      path: e.path,
      format: e.format,
      edits: e.turns.size,
      firstSeen: e.firstSeen === Number.MAX_SAFE_INTEGER ? 0 : e.firstSeen,
      lastSeen: e.lastSeen,
      attributedCost: e.attributedCost,
      outputTokens: Math.round(e.outputTokens),
      sessions: e.sessions.size,
    }))
    .sort((a, b) => (b.attributedCost - a.attributedCost) || (b.outputTokens - a.outputTokens));

  const formatMap = new Map<ArtifactFormat, { artifacts: number; cost: number }>();
  for (const a of byArtifact) {
    const e = formatMap.get(a.format) ?? { artifacts: 0, cost: 0 };
    e.artifacts += 1;
    e.cost += a.attributedCost;
    formatMap.set(a.format, e);
  }

  return {
    summary: {
      distinctArtifacts: byArtifact.length,
      totalWrites: byArtifact.reduce((s, a) => s + a.edits, 0),
      totalCost: byArtifact.reduce((s, a) => s + a.attributedCost, 0),
      formats: Array.from(formatMap.entries())
        .map(([format, d]) => ({ format, artifacts: d.artifacts, cost: d.cost }))
        .sort((a, b) => b.cost - a.cost),
    },
    byArtifact,
  };
}
