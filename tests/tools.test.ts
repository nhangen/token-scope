import { describe, expect, it } from "bun:test";
import { classifyTool, analyzeTooling } from "@/tools";
import type { ToolLayer } from "@/tools";

describe("classifyTool", () => {
  it("classifies plugin tools", () => {
    const result = classifyTool("mcp__plugin_figma_figma__get_design_context");
    expect(result.layer).toBe("plugin" as ToolLayer);
    expect(result.server).toBe("figma");
    expect(result.shortName).toBe("get_design_context");
  });

  it("classifies MCP tools", () => {
    const result = classifyTool("mcp__zenhub__getSprint");
    expect(result.layer).toBe("mcp" as ToolLayer);
    expect(result.server).toBe("zenhub");
    expect(result.shortName).toBe("getSprint");
  });

  it("classifies claude_ai MCP integrations as mcp", () => {
    const result = classifyTool("mcp__claude_ai_Figma__authenticate");
    expect(result.layer).toBe("mcp" as ToolLayer);
    expect(result.server).toBe("claude_ai_Figma");
    expect(result.shortName).toBe("authenticate");
  });

  it("classifies Skill tool", () => {
    const result = classifyTool("Skill");
    expect(result.layer).toBe("skill" as ToolLayer);
  });

  it("classifies meta tools", () => {
    for (const name of ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop", "Task", "TodoWrite", "EnterPlanMode", "ExitPlanMode", "ToolSearch"]) {
      expect(classifyTool(name).layer).toBe("meta" as ToolLayer);
    }
  });

  it("classifies built-in tools", () => {
    for (const name of ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Agent", "MultiEdit", "WebFetch", "WebSearch"]) {
      expect(classifyTool(name).layer).toBe("builtin" as ToolLayer);
    }
  });

  it("classifies unknown tools as builtin", () => {
    expect(classifyTool("SomeNewTool").layer).toBe("builtin" as ToolLayer);
  });
});

describe("cost proportioning", () => {
  it("splits cost proportionally by input size", () => {
    const turns = [{
      uuid: "t1", sessionId: "s1", cwd: "/test", outputTokens: 100, costUsd: 1.00,
      message: JSON.stringify({
        content: [
          { type: "tool_use", name: "Bash", input: { command: "a".repeat(800) } },
          { type: "tool_use", name: "mcp__zenhub__getSprint", input: { id: "x".repeat(200) } },
        ],
        usage: { output_tokens: 100 },
      }),
    }];
    const result = analyzeTooling(turns);
    const bash = result.byTool.find((t) => t.name === "Bash");
    const zenhub = result.byTool.find((t) => t.name === "mcp__zenhub__getSprint");
    expect(bash!.attributedCost).toBeGreaterThan(zenhub!.attributedCost);
    expect(bash!.attributedCost + zenhub!.attributedCost).toBeCloseTo(1.00, 2);
  });

  it("assigns full cost to (no tool) for text-only turns", () => {
    const turns = [{
      uuid: "t1", sessionId: "s1", cwd: "/test", outputTokens: 100, costUsd: 0.50,
      message: JSON.stringify({
        content: [{ type: "text", text: "Hello world" }],
        usage: { output_tokens: 100 },
      }),
    }];
    const result = analyzeTooling(turns);
    const noTool = result.layers.find((l) => l.layer === "(no tool)");
    expect(noTool!.attributedCost).toBeCloseTo(0.50, 4);
  });

  it("handles null costUsd without NaN", () => {
    const turns = [{
      uuid: "t1", sessionId: "s1", cwd: "/test", outputTokens: 100, costUsd: null,
      message: JSON.stringify({
        content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        usage: { output_tokens: 100 },
      }),
    }];
    const result = analyzeTooling(turns);
    const bash = result.byTool.find((t) => t.name === "Bash");
    expect(bash!.calls).toBe(1);
    expect(bash!.attributedCost).toBe(0);
  });
});
