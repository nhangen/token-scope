import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Production CLI path for the provider report (#37 post-merge audit: no test
 * exercised `token-scope --providers` end to end — only library functions).
 * Fixture stores are injected through the TOKEN_SCOPE_* env overrides, so
 * this drives the real arg parsing, collection, and rendering pipeline.
 */
const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const FX = join(import.meta.dir, "fixtures", "providers");

function runProviders(extraArgs: string[] = [], geminiRoot = join(FX, "gemini-cli", "success")) {
  const proc = Bun.spawnSync(["bun", CLI, "--providers", ...extraArgs], {
    cwd: ROOT,
    env: {
      ...process.env,
      TOKEN_SCOPE_CLAUDE_ROOT: join(FX, "claude-root"),
      TOKEN_SCOPE_CODEX_HOME: join(FX, "codex-home"),
      TOKEN_SCOPE_LEDGER: join(FX, "ledger-sample.jsonl"),
      TOKEN_SCOPE_GEMINI_ROOT: geminiRoot,
      // No opencode fixture db on disk: source must be reported unavailable.
      TOKEN_SCOPE_OPENCODE_DB: "/nonexistent/opencode.db",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout.toString() };
}

describe("--providers production CLI path", () => {
  it("renders the full report from fixture stores via env overrides", () => {
    const { code, out } = runProviders();
    expect(code).toBe(0);
    expect(out).toContain("provider usage by harness / provider / billing route / model");
    expect(out).toContain("unavailable sources (volume unknown, not zero): opencode");
    expect(out).toContain("unsupported sources (not ingested): google-ai-api, vertex-ai");
    expect(out).toContain("gemini-cli");
    expect(out).toContain("all values measured from source records; no estimates");
  });

  it("emits valid JSON with the documented shape under --json", () => {
    const { code, out } = runProviders(["--json", "--since", "10000d"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    // The codex-home fixture includes partial and cumulative-only sessions, so
    // an all-time window must not claim complete measurement.
    expect(parsed.measured).toBe(false);
    expect(
      parsed.rows.some((row: { partialEvents: number }) => row.partialEvents > 0),
    ).toBe(true);
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(typeof parsed.untimedExcluded).toBe("number");
    expect(Array.isArray(parsed.unavailable)).toBe(true);
    expect(parsed.unsupported).toEqual(["google-ai-api", "vertex-ai"]);
    // Every row carries provenance and partial-class accounting (#37 AC).
    for (const row of parsed.rows) {
      expect(Array.isArray(row.provenance)).toBe(true);
      expect(row.provenance.length).toBeGreaterThan(0);
      expect(Array.isArray(row.partialClasses)).toBe(true);
      expect(typeof row.malformedEvents).toBe("number");
      expect(typeof row.partialEvents).toBe("number");
      expect(typeof row.legacyCumulativeEvents).toBe("number");
    }
  });

  it("applies --since as a bounded scan and still returns rows", () => {
    const { code, out } = runProviders(["--json", "--since", "1d"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    // Fixture records are dated 2026-08-22; a 1-day window may or may not
    // include them depending on run date, but the shape must hold either way.
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(typeof parsed.untimedExcluded).toBe("number");
  });

  it("never emits Gemini prompt, thought, tool, or session content", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-canary-"));
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      const canaries = {
        session: "CANARY-SESSION-ID-FAKE",
        project: "CANARY-PROJECT-HASH-FAKE",
        messageId: "CANARY-MESSAGE-ID-FAKE",
        prompt: "CANARY-PROMPT-TEXT-FAKE",
        thought: "CANARY-THOUGHT-TEXT-FAKE",
        tool: "CANARY-TOOL-ARG-FAKE",
        header: "Authorization: Bearer FAKE-CANARY-TOKEN-EXAMPLE",
      };
      writeFileSync(join(chats, "session.jsonl"), [
        JSON.stringify({ sessionId: canaries.session, projectHash: canaries.project, messages: [] }),
        JSON.stringify({ id: "user-1", type: "user", content: `${canaries.prompt} ${canaries.header}` }),
        JSON.stringify({
          id: canaries.messageId,
          timestamp: "2026-09-23T10:01:00.000Z",
          type: "gemini",
          content: canaries.prompt,
          thoughts: [{ subject: canaries.thought, description: canaries.thought }],
          toolCalls: [{ name: "shell", args: { command: canaries.tool, headers: canaries.header } }],
          model: "gemini-3-flash-preview",
          tokens: { input: 10, output: 2, cached: 0, thoughts: 0, tool: 0, total: 12 },
        }),
      ].join("\n"));

      for (const args of [[], ["--json"]]) {
        const { code, out } = runProviders(args, root);
        expect(code).toBe(0);
        expect(out).toContain("gemini-cli");
        for (const canary of Object.values(canaries)) expect(out).not.toContain(canary);
        expect(out).not.toContain("FAKE-CANARY");
        expect(out).not.toContain("CANARY");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("--providers names partial reasons", () => {
  it("prints the reason in text and carries partialReasons in --json", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-cli-reasons-"));
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      writeFileSync(join(chats, "mixed.jsonl"), [
        JSON.stringify({ sessionId: "cli-reasons", messages: [] }),
        "not-json",
      ].join("\n"));

      const text = runProviders([], root);
      expect(text.code).toBe(0);
      expect(text.out).toContain("gemini-cli: 1 affected file(s) [malformed]");

      const json = runProviders(["--json"], root);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.out).partialReasons["gemini-cli"]).toEqual(["malformed"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
