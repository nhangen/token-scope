import { describe, expect, it } from "bun:test";
import { analyzeArtifacts, classifyFormat } from "@/artifacts";

describe("classifyFormat", () => {
  it("maps common extensions", () => {
    expect(classifyFormat("/x/foo.md")).toBe("md");
    expect(classifyFormat("/x/foo.html")).toBe("html");
    expect(classifyFormat("/x/foo.ts")).toBe("ts");
    expect(classifyFormat("/x/foo.tsx")).toBe("tsx");
    expect(classifyFormat("/x/foo.py")).toBe("py");
    expect(classifyFormat("/x/foo.yaml")).toBe("yaml");
    expect(classifyFormat("/x/foo.YML")).toBe("yaml");
  });

  it("returns 'other' for unknown extensions", () => {
    expect(classifyFormat("/x/foo.xyz")).toBe("other");
  });

  it("returns 'other' for files without extensions", () => {
    expect(classifyFormat("/x/Makefile")).toBe("other");
    expect(classifyFormat("/x/.envrc")).toBe("other");
  });

  it("ignores dots in directory names", () => {
    expect(classifyFormat("/x.with.dots/foo")).toBe("other");
    expect(classifyFormat("/x.with.dots/foo.md")).toBe("md");
  });
});

describe("analyzeArtifacts", () => {
  const baseTurn = {
    uuid: "t1",
    sessionId: "s1",
    cwd: "/project",
    outputTokens: 100,
    costUsd: 1.0,
    timestamp: 1700000000,
  };

  it("aggregates Write/Edit calls by file_path", () => {
    const turns = [
      {
        ...baseTurn,
        message: JSON.stringify({
          content: [{ type: "tool_use", name: "Write", input: { file_path: "/a/foo.md", content: "x".repeat(200) } }],
        }),
      },
    ];
    const r = analyzeArtifacts(turns);
    expect(r.summary.distinctArtifacts).toBe(1);
    expect(r.byArtifact[0]!.path).toBe("/a/foo.md");
    expect(r.byArtifact[0]!.format).toBe("md");
    expect(r.byArtifact[0]!.edits).toBe(1);
    expect(r.byArtifact[0]!.attributedCost).toBe(1.0);
  });

  it("counts multiple writes to the same path as multiple edits", () => {
    const turns = [
      {
        ...baseTurn,
        uuid: "t1",
        message: JSON.stringify({
          content: [{ type: "tool_use", name: "Write", input: { file_path: "/a/foo.md", content: "first" } }],
        }),
      },
      {
        ...baseTurn,
        uuid: "t2",
        timestamp: 1700001000,
        message: JSON.stringify({
          content: [{ type: "tool_use", name: "Edit", input: { file_path: "/a/foo.md", old_string: "x", new_string: "y" } }],
        }),
      },
    ];
    const r = analyzeArtifacts(turns);
    expect(r.byArtifact).toHaveLength(1);
    expect(r.byArtifact[0]!.edits).toBe(2);
    expect(r.byArtifact[0]!.firstSeen).toBe(1700000000);
    expect(r.byArtifact[0]!.lastSeen).toBe(1700001000);
  });

  it("ignores non-Write tool blocks", () => {
    const turns = [
      {
        ...baseTurn,
        message: JSON.stringify({
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/a/foo.md" } },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        }),
      },
    ];
    const r = analyzeArtifacts(turns);
    expect(r.summary.distinctArtifacts).toBe(0);
  });

  it("attributes cost proportionally when multiple tools share a turn", () => {
    const turns = [
      {
        ...baseTurn,
        costUsd: 1.0,
        message: JSON.stringify({
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "/a/foo.md", content: "x".repeat(800) } },
            { type: "tool_use", name: "Bash", input: { command: "x".repeat(200) } },
          ],
        }),
      },
    ];
    const r = analyzeArtifacts(turns);
    // Write block ~80% of total payload size → cost ≈ 0.80
    expect(r.byArtifact[0]!.attributedCost).toBeGreaterThan(0.7);
    expect(r.byArtifact[0]!.attributedCost).toBeLessThan(0.9);
  });

  it("handles null costUsd without NaN", () => {
    const turns = [
      {
        ...baseTurn,
        costUsd: null,
        message: JSON.stringify({
          content: [{ type: "tool_use", name: "Write", input: { file_path: "/a/foo.md", content: "x" } }],
        }),
      },
    ];
    const r = analyzeArtifacts(turns);
    expect(r.byArtifact[0]!.attributedCost).toBe(0);
    expect(r.byArtifact[0]!.edits).toBe(1);
  });

  it("counts distinct sessions touching the same artifact", () => {
    const turns = [
      { ...baseTurn, sessionId: "s1", uuid: "t1", message: JSON.stringify({ content: [{ type: "tool_use", name: "Write", input: { file_path: "/a/foo.md" } }] }) },
      { ...baseTurn, sessionId: "s2", uuid: "t2", message: JSON.stringify({ content: [{ type: "tool_use", name: "Write", input: { file_path: "/a/foo.md" } }] }) },
      { ...baseTurn, sessionId: "s2", uuid: "t3", message: JSON.stringify({ content: [{ type: "tool_use", name: "Write", input: { file_path: "/a/foo.md" } }] }) },
    ];
    const r = analyzeArtifacts(turns);
    expect(r.byArtifact[0]!.sessions).toBe(2);
    expect(r.byArtifact[0]!.edits).toBe(3);
  });

  it("groups format summary correctly", () => {
    const turns = [
      { ...baseTurn, uuid: "t1", costUsd: 0.5, message: JSON.stringify({ content: [{ type: "tool_use", name: "Write", input: { file_path: "/a/foo.md" } }] }) },
      { ...baseTurn, uuid: "t2", costUsd: 0.5, message: JSON.stringify({ content: [{ type: "tool_use", name: "Write", input: { file_path: "/a/bar.md" } }] }) },
      { ...baseTurn, uuid: "t3", costUsd: 0.3, message: JSON.stringify({ content: [{ type: "tool_use", name: "Write", input: { file_path: "/a/baz.html" } }] }) },
    ];
    const r = analyzeArtifacts(turns);
    const md = r.summary.formats.find((f) => f.format === "md");
    const html = r.summary.formats.find((f) => f.format === "html");
    expect(md!.artifacts).toBe(2);
    expect(md!.cost).toBeCloseTo(1.0, 4);
    expect(html!.artifacts).toBe(1);
    expect(html!.cost).toBeCloseTo(0.3, 4);
  });

  it("ignores Write blocks with non-string file_path", () => {
    const turns = [
      {
        ...baseTurn,
        message: JSON.stringify({
          content: [{ type: "tool_use", name: "Write", input: { file_path: null, content: "x" } }],
        }),
      },
    ];
    const r = analyzeArtifacts(turns);
    expect(r.summary.distinctArtifacts).toBe(0);
  });
});
