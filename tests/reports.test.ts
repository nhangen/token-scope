import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { openDb, resolveDbPath } from "@/db";
import type { Database } from "bun:sqlite";
import { renderSummary } from "@/reports/summary";
import { renderToolDrillDown } from "@/reports/tool";
import { renderProjectDrillDown } from "@/reports/project";
import { renderSessionView, renderSessionsList } from "@/reports/session";
import { renderThinkingReport } from "@/reports/thinking";

let db: Database;
const opts = { since: 0, limit: 20, json: false };

beforeAll(() => { db = openDb(resolveDbPath().path); });
afterAll(() => { db.close(); });

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { fn(); } finally { console.log = orig; }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

describe("Summary report", () => {
  it("renders without throwing", () => {
    expect(() => renderSummary(db, opts)).not.toThrow();
  });

  it("renders valid JSON with report=summary and required keys", () => {
    const output = capture(() => renderSummary(db, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("summary");
    expect(parsed.meta).toHaveProperty("generated_at");
    expect(parsed).toHaveProperty("totals");
    expect(parsed).toHaveProperty("byTool");
    expect(Array.isArray(parsed.byTool)).toBe(true);
  });
});

describe("Tool report", () => {
  it("renders bash without throwing", () => {
    expect(() => renderToolDrillDown(db, "bash", opts)).not.toThrow();
  });

  it("renders non-bash tool without throwing", () => {
    expect(() => renderToolDrillDown(db, "read", opts)).not.toThrow();
  });

  it("renders valid JSON for bash with toolName field", () => {
    const output = capture(() => renderToolDrillDown(db, "bash", { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("tool");
    expect(parsed.toolName).toBe("Bash");
  });

  it("handles unknown tool gracefully without throwing", () => {
    expect(() => renderToolDrillDown(db, "nonexistent-tool-xyz", opts)).not.toThrow();
  });
});

describe("Project report", () => {
  it("renders single-match project without throwing", () => {
    expect(() => renderProjectDrillDown(db, "token-scope", opts)).not.toThrow();
  });

  it("prints disambiguation for multi-match without throwing", () => {
    expect(() => renderProjectDrillDown(db, "projects", opts)).not.toThrow();
    const output = capture(() => renderProjectDrillDown(db, "projects", opts));
    expect(output).toContain("Multiple projects match");
  });

  it("handles no-match gracefully without throwing", () => {
    expect(() => renderProjectDrillDown(db, "zzz-nonexistent-xyz", opts)).not.toThrow();
  });
});

describe("Session view", () => {
  it("renders sess-a1 without throwing", () => {
    expect(() => renderSessionView(db, "sess-a1", false, "30d")).not.toThrow();
  });

  it("renders valid JSON with 3 turns for sess-a1", () => {
    const output = capture(() => renderSessionView(db, "sess-a1", true, "30d"));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("session");
    expect(Array.isArray(parsed.turns)).toBe(true);
    expect(parsed.turns.length).toBe(3);
  });

  it("handles unknown session gracefully without throwing", () => {
    expect(() => renderSessionView(db, "unknown-session-id", false, "30d")).not.toThrow();
  });
});

describe("Sessions list", () => {
  it("renders without throwing", () => {
    expect(() => renderSessionsList(db, opts)).not.toThrow();
  });

  it("renders valid JSON with sessions array and totals", () => {
    const output = capture(() => renderSessionsList(db, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("sessions");
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.totals).toHaveProperty("session_count");
    expect(parsed.totals).toHaveProperty("total_cost_usd");
  });
});

describe("Thinking report", () => {
  it("renders without throwing", () => {
    expect(() => renderThinkingReport(db, opts)).not.toThrow();
  });

  it("renders valid JSON with overview.estimated_thinking_tokens", () => {
    const output = capture(() => renderThinkingReport(db, { ...opts, json: true }));
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe("thinking");
    expect(parsed.overview).toHaveProperty("estimated_thinking_tokens");
    expect(parsed.overview).toHaveProperty("turns_with_thinking");
  });
});
