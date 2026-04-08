import { describe, expect, it } from "bun:test";
import { resolveDominantTool, estimateThinkingTokens, categorizeBashCommand } from "@/parse";
import type { ContentBlock } from "@/parse";

describe("resolveDominantTool", () => {
  it("returns '(text only)' when no tool_use blocks", () => {
    const blocks: ContentBlock[] = [{ type: "text", text: "Hello world" }];
    expect(resolveDominantTool(blocks)).toBe("(text only)");
  });

  it("returns the single tool when one tool_use block", () => {
    const blocks: ContentBlock[] = [{ type: "tool_use", name: "Bash", input: { command: "git status" } }];
    expect(resolveDominantTool(blocks)).toBe("Bash");
  });

  it("returns the tool with the largest JSON input", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } },
      { type: "tool_use", name: "Read", input: { file_path: "/very/long/absolute/path/to/some/file/in/the/project.ts", limit: 200 } },
    ];
    expect(resolveDominantTool(blocks)).toBe("Read");
  });

  it("breaks ties alphabetically", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", name: "Zebra", input: { x: 1 } },
      { type: "tool_use", name: "Alpha", input: { x: 1 } },
    ];
    expect(resolveDominantTool(blocks)).toBe("Alpha");
  });

  it("ignores non-tool_use blocks in the calculation", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", thinking: "A very long thinking block with lots of characters that should not count toward tool dominance" },
      { type: "tool_use", name: "Glob", input: { pattern: "*.ts" } },
    ];
    expect(resolveDominantTool(blocks)).toBe("Glob");
  });

  it("returns '(text only)' for empty blocks array", () => {
    expect(resolveDominantTool([])).toBe("(text only)");
  });
});

describe("estimateThinkingTokens", () => {
  it("returns 0 when thinkingChars is 0", () => {
    expect(estimateThinkingTokens(0, 500, 300)).toBe(0);
  });

  it("returns null when both thinking and text chars are 0", () => {
    expect(estimateThinkingTokens(0, 0, 500)).toBeNull();
  });

  it("estimates proportionally for 50/50 split", () => {
    expect(estimateThinkingTokens(500, 500, 400)).toBe(200);
  });

  it("estimates correctly for all-thinking turn", () => {
    expect(estimateThinkingTokens(1000, 0, 300)).toBe(300);
  });

  it("rounds to nearest integer", () => {
    // 1/(1+2) * 100 = 33.33 -> 33
    expect(estimateThinkingTokens(1, 2, 100)).toBe(33);
  });
});

describe("categorizeBashCommand", () => {
  it("categorizes git commands", () => {
    expect(categorizeBashCommand("git status")).toBe("Version Control");
    expect(categorizeBashCommand("git log --oneline -20")).toBe("Version Control");
  });

  it("categorizes JS tooling", () => {
    expect(categorizeBashCommand("npm run test")).toBe("JS Tooling");
    expect(categorizeBashCommand("bun install")).toBe("JS Tooling");
    expect(categorizeBashCommand("npx playwright test")).toBe("JS Tooling");
  });

  it("categorizes PHP tooling", () => {
    expect(categorizeBashCommand("composer install")).toBe("PHP Tooling");
    expect(categorizeBashCommand("phpunit tests/")).toBe("PHP Tooling");
  });

  it("categorizes HTTP/network", () => {
    expect(categorizeBashCommand("curl -s https://api.example.com")).toBe("HTTP / Network");
    expect(categorizeBashCommand("wget https://example.com/file.zip")).toBe("HTTP / Network");
  });

  it("categorizes containers", () => {
    expect(categorizeBashCommand("docker build .")).toBe("Containers");
    expect(categorizeBashCommand("kubectl get pods")).toBe("Containers");
  });

  it("categorizes Python tooling", () => {
    expect(categorizeBashCommand("python3 script.py")).toBe("Python Tooling");
    expect(categorizeBashCommand("pytest tests/")).toBe("Python Tooling");
  });

  it("categorizes file inspection", () => {
    expect(categorizeBashCommand("ls -la")).toBe("File Inspection");
    expect(categorizeBashCommand("grep -r 'pattern' .")).toBe("File Inspection");
  });

  it("categorizes file mutation", () => {
    expect(categorizeBashCommand("mkdir -p src/reports")).toBe("File Mutation");
    expect(categorizeBashCommand("rm -rf dist/")).toBe("File Mutation");
  });

  it("categorizes by first command in a chain", () => {
    expect(categorizeBashCommand("cd /tmp && git status")).toBe("Version Control");
  });

  it("strips leading env assignments", () => {
    expect(categorizeBashCommand("export PATH=/foo:$PATH; git push")).toBe("Version Control");
  });

  it("returns Other for unknown commands", () => {
    expect(categorizeBashCommand("unknown-tool --flag")).toBe("Other");
    expect(categorizeBashCommand("")).toBe("Other");
  });
});
