import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readEscalations, resolveEscalationsPath, resolveAttemptGapSeconds,
  DEFAULT_ATTEMPT_GAP_SECONDS,
} from "@/escalations";

const SAVED: Record<string, string | undefined> = {};
const VARS = ["OLLAMA_AGENT_ESCALATIONS", "XDG_STATE_HOME", "OLLAMA_ATTEMPT_GAP"];
beforeEach(() => { for (const v of VARS) { SAVED[v] = process.env[v]; delete process.env[v]; } });
afterEach(() => {
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v]!;
  }
});

function capErr(fn: () => void): string {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { fn(); } finally { process.stderr.write = orig; }
  return lines.join("");
}

describe("resolveEscalationsPath", () => {
  it("prefers an explicit override over everything", () => {
    process.env["OLLAMA_AGENT_ESCALATIONS"] = "/from/env.jsonl";
    process.env["XDG_STATE_HOME"] = "/from/xdg";
    expect(resolveEscalationsPath("/explicit.jsonl")).toBe("/explicit.jsonl");
  });

  it("uses OLLAMA_AGENT_ESCALATIONS when there is no override", () => {
    process.env["OLLAMA_AGENT_ESCALATIONS"] = "/from/env.jsonl";
    process.env["XDG_STATE_HOME"] = "/from/xdg";
    expect(resolveEscalationsPath()).toBe("/from/env.jsonl");
  });

  it("falls back to XDG_STATE_HOME", () => {
    process.env["XDG_STATE_HOME"] = "/from/xdg";
    expect(resolveEscalationsPath()).toBe("/from/xdg/ollama-agent/escalations.jsonl");
  });

  it("falls back to ~/.local/state — the path every real user hits", () => {
    // Nobody passes --escalations, so this arm covers the only branch production
    // actually takes.
    expect(resolveEscalationsPath()).toMatch(/\/\.local\/state\/ollama-agent\/escalations\.jsonl$/);
  });
});

describe("resolveAttemptGapSeconds", () => {
  it("defaults when unset", () => {
    expect(resolveAttemptGapSeconds()).toBe(DEFAULT_ATTEMPT_GAP_SECONDS);
  });

  it("reads a positive integer", () => {
    process.env["OLLAMA_ATTEMPT_GAP"] = "7200";
    expect(capErr(() => { expect(resolveAttemptGapSeconds()).toBe(7200); })).toBe("");
  });

  for (const bad of ["", "abc", "-1", "1.5", "4h", "14400 ", "0"]) {
    it(`warns and defaults on ${JSON.stringify(bad)}`, () => {
      // The doc comment promised a warn-and-default; without the warn, a typo
      // silently moves the window that decides which dollars leave a money figure.
      process.env["OLLAMA_ATTEMPT_GAP"] = bad;
      let got = 0;
      const err = capErr(() => { got = resolveAttemptGapSeconds(); });
      expect(got).toBe(DEFAULT_ATTEMPT_GAP_SECONDS);
      expect(err).toContain("OLLAMA_ATTEMPT_GAP");
      expect(err).toContain(String(DEFAULT_ATTEMPT_GAP_SECONDS));
    });
  }
});

describe("readEscalations", () => {
  it("reports an absent file as absent, not as an empty one", () => {
    // The whole point of the status: [] from a missing sidecar and [] from an
    // unreadable one used to be the same answer, and both read as "nothing was
    // superseded" — silently restoring the double-count #81 removed.
    const r = readEscalations("/no/such/escalations.jsonl");
    expect(r.records).toEqual([]);
    expect(r.exists).toBe(false);
    expect(r.readError).toBeNull();
    expect(r.path).toBe("/no/such/escalations.jsonl");
  });

  it("reports a read failure distinctly from an absent file", () => {
    const dir = mkdtempSync(join(tmpdir(), "esc-unreadable-"));
    const p = join(dir, "escalations.jsonl");
    writeFileSync(p, '{"epoch":1,"superseded_run_id":"author:1"}\n');
    chmodSync(p, 0o000);
    try {
      const r = readEscalations(p);
      expect(r.exists).toBe(true);
      expect(r.readError).not.toBeNull();
      expect(r.records).toEqual([]);
    } finally { chmodSync(p, 0o600); }
  });

  it("reads a directory at the path as a read failure, not as content", () => {
    const dir = mkdtempSync(join(tmpdir(), "esc-isdir-"));
    const p = join(dir, "escalations.jsonl");
    mkdirSync(p);
    const r = readEscalations(p);
    expect(r.exists).toBe(true);
    expect(r.readError).not.toBeNull();
  });

  it("counts skipped lines rather than dropping them silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "esc-skip-"));
    const p = join(dir, "e.jsonl");
    writeFileSync(p, [
      "not json at all",
      '{"epoch":1783508400,"superseded_run_id":"author:1","cwd":"/w/1"}',
      '{"epoch":1783508400,"cwd":"/w/2"}',
      '{"superseded_run_id":"author:3","cwd":"/w/3"}',
      '{"epoch":"nope","superseded_run_id":"author:4","cwd":"/w/4"}',
      '{"epoch":1783508400,"superseded_run_id":"","cwd":"/w/5"}',
      "",
    ].join("\n"));
    const r = readEscalations(p);
    expect(r.records.length).toBe(1);
    expect(r.skippedLines).toBe(5);
    expect(r.exists).toBe(true);
    expect(r.readError).toBeNull();
  });

  it("a bad first line does not cost the records after it", () => {
    // The arm the fixtures-emittable PARSE_EXEMPT entry rests on. Asserting the
    // record count directly is the only version of this that can fail: asserting
    // a downstream report total passes whether or not the line is even there.
    const p = new URL("./fixtures/escalations/escalations.jsonl", import.meta.url).pathname;
    const r = readEscalations(p);
    expect(r.records.length).toBe(3);
    expect(r.skippedLines).toBe(2);
  });

  it("treats an empty cwd as no cwd", () => {
    // The producer refuses to write one and calls such a record not discountable
    // at all. Read as a real value it matches a legacy ledger row that also has
    // "", and excludes spend nothing replaced.
    const dir = mkdtempSync(join(tmpdir(), "esc-emptycwd-"));
    const p = join(dir, "e.jsonl");
    writeFileSync(p, '{"epoch":1783508400,"superseded_run_id":"author:1","cwd":""}\n');
    const r = readEscalations(p);
    expect(r.records.length).toBe(1);
    expect(r.records[0]!.cwd).toBeNull();
  });
});
