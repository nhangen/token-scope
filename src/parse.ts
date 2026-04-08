export interface ContentBlock {
  type: "text" | "tool_use" | "thinking" | string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  thinking?: string;
}

/**
 * Returns the dominant tool in a turn (tool_use block with largest JSON.stringify(input) length).
 * Ties broken alphabetically. Returns "(text only)" when no tool_use blocks present.
 */
export function resolveDominantTool(blocks: ContentBlock[]): string {
  const toolBlocks = blocks.filter((b) => b.type === "tool_use" && b.name);
  if (toolBlocks.length === 0) return "(text only)";

  let dominant = toolBlocks[0]!;
  let dominantSize = JSON.stringify(dominant.input ?? {}).length;

  for (let i = 1; i < toolBlocks.length; i++) {
    const block = toolBlocks[i]!;
    const size = JSON.stringify(block.input ?? {}).length;
    if (size > dominantSize || (size === dominantSize && (block.name ?? "") < (dominant.name ?? ""))) {
      dominant = block;
      dominantSize = size;
    }
  }

  return dominant.name ?? "(text only)";
}

/**
 * Estimates thinking tokens using a character-ratio proxy (±15-30% error).
 * Returns null for tool-only turns (both chars zero).
 * Returns 0 when thinkingChars is zero.
 * All callers must prefix output with "~".
 */
export function estimateThinkingTokens(
  thinkingChars: number,
  textChars: number,
  outputTokens: number
): number | null {
  if (thinkingChars === 0 && textChars === 0) return null;
  if (thinkingChars === 0) return 0;
  const ratio = thinkingChars / (thinkingChars + textChars);
  return Math.round(ratio * outputTokens);
}

const BASH_CATEGORIES: Array<[RegExp, string]> = [
  [/^git\b/, "Version Control"],
  [/^(npm|npx|yarn|pnpm|bun)\b/, "JS Tooling"],
  [/^(composer|php\b|phpunit|phpspec)\b/, "PHP Tooling"],
  [/^(curl|wget)\b/, "HTTP / Network"],
  [/^(docker|kubectl)\b/, "Containers"],
  [/^(python|python3|pytest)\b/, "Python Tooling"],
  [/^(ls|find|cat|grep|rg)\b/, "File Inspection"],
  [/^(mkdir|rm|cp|mv|chmod)\b/, "File Mutation"],
];

/**
 * Categorizes a Bash command by its first meaningful token.
 * Strips: "cd /path &&", "export VAR=val;", "sudo".
 * Multi-command chains categorized by first command.
 */
export function categorizeBashCommand(command: string): string {
  if (!command.trim()) return "Other";
  let segment = command;
  segment = segment.trim();
  let prev = "";
  while (prev !== segment) { prev = segment; segment = segment.replace(/^(export\s+)?[A-Z_][A-Z0-9_]*=[^\s;]+\s*;?\s*/gi, "").trim(); }
  segment = segment.replace(/^cd\s+\S+\s*&&\s*/, "").trim();
  segment = segment.replace(/^sudo\s+/, "").trim();
  const firstToken = segment.split(/\s+/)[0] ?? "";
  for (const [pattern, category] of BASH_CATEGORIES) {
    if (pattern.test(firstToken)) return category;
  }
  return "Other";
}

/** Parses content blocks from raw message JSON. Returns [] on failure. */
export function parseContentBlocks(messageJson: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(messageJson) as { content?: unknown };
    if (!Array.isArray(parsed.content)) return [];
    return parsed.content as ContentBlock[];
  } catch {
    return [];
  }
}

/** Extracts usage fields from raw message JSON. Returns zeros on failure. */
export function parseUsage(messageJson: string): {
  outputTokens: number; inputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
} {
  const defaults = { outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  try {
    const parsed = JSON.parse(messageJson) as { usage?: Record<string, number> };
    const u = parsed.usage ?? {};
    return {
      outputTokens: u["output_tokens"] ?? 0,
      inputTokens: u["input_tokens"] ?? 0,
      cacheReadTokens: u["cache_read_input_tokens"] ?? 0,
      cacheWriteTokens: u["cache_creation_input_tokens"] ?? 0,
    };
  } catch {
    return defaults;
  }
}
