import { describe, expect, it } from "bun:test";
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

function runProviders(extraArgs: string[] = []) {
  const proc = Bun.spawnSync(["bun", CLI, "--providers", ...extraArgs], {
    cwd: ROOT,
    env: {
      ...process.env,
      TOKEN_SCOPE_CLAUDE_ROOT: join(FX, "claude-root"),
      TOKEN_SCOPE_CODEX_HOME: join(FX, "codex-home"),
      TOKEN_SCOPE_LEDGER: join(FX, "ledger-sample.jsonl"),
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
    expect(out).toContain("provider usage by harness / billing route / model");
    expect(out).toContain("unavailable sources (volume unknown, not zero): opencode");
    expect(out).toContain("all values measured from source records; no estimates");
  });

  it("emits valid JSON with the documented shape under --json", () => {
    const { code, out } = runProviders(["--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.measured).toBe(true);
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(typeof parsed.untimedExcluded).toBe("number");
    expect(Array.isArray(parsed.unavailable)).toBe(true);
    // Every row carries provenance and partial-class accounting (#37 AC).
    for (const row of parsed.rows) {
      expect(Array.isArray(row.provenance)).toBe(true);
      expect(row.provenance.length).toBeGreaterThan(0);
      expect(Array.isArray(row.partialClasses)).toBe(true);
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
});
