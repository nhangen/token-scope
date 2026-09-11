import { describe, expect, it, afterEach } from "bun:test";
import { readLedger, readLedgerWithStatus, resolveLedgerPath } from "@/ledger";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const LEDGER = new URL("./fixtures/ledger/runs.jsonl", import.meta.url).pathname;

describe("readLedger", () => {
  it("parses well-formed lines and skips malformed ones", () => {
    const runs = readLedger(LEDGER);
    expect(runs.length).toBe(4); // 5 lines, 1 malformed dropped
    expect(runs.map((r) => r.runId)).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("maps snake_case ledger fields to camelCase run fields", () => {
    const r = readLedger(LEDGER)[0]!;
    expect(r.sessionId).toBe("sess-spend");
    expect(r.model).toBe("qwen2.5-coder:32b");
    expect(r.taskName).toBe("impl-foo");
    expect(r.ollamaInputTokens).toBe(100000);
    expect(r.ollamaOutputTokens).toBe(40000);
    expect(r.turns).toBe(3);
    expect(r.completed).toBe(true);
    expect(r.verified).toBe(true);
  });

  it("preserves a null session_id (unattributed run)", () => {
    const r = readLedger(LEDGER).find((x) => x.runId === "r3")!;
    expect(r.sessionId).toBeNull();
  });

  it("returns [] for a missing file", () => {
    expect(readLedger("/no/such/ledger/runs.jsonl")).toEqual([]);
  });
});

describe("readLedgerWithStatus", () => {
  it("separates an absent ledger from an unreadable one, and counts skipped lines", () => {
    // Same reason as the escalations sidecar: [] from a missing file and [] from
    // a permission error render as the same confident zero, and this is the
    // PRIMARY source of every figure the savings report prints.
    const absent = readLedgerWithStatus("/no/such/runs.jsonl");
    expect(absent.exists).toBe(false);
    expect(absent.readError).toBeNull();
    expect(absent.runs).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "ledger-status-"));
    const p = join(dir, "runs.jsonl");
    writeFileSync(p, 'not json\n{"run_id":"author:1","ollama_input_tokens":5}\n');
    const ok = readLedgerWithStatus(p);
    expect(ok.exists).toBe(true);
    expect(ok.readError).toBeNull();
    expect(ok.runs.length).toBe(1);
    expect(ok.skippedLines).toBe(1);

    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    chmodSync(p, 0o000);
    try {
      const bad = readLedgerWithStatus(p);
      expect(bad.exists).toBe(true);
      expect(bad.readError).not.toBeNull();
      expect(bad.runs).toEqual([]);
    } finally { chmodSync(p, 0o600); }
  });
});

describe("resolveLedgerPath", () => {
  const orig = { override: process.env["OLLAMA_AGENT_LEDGER"], xdg: process.env["XDG_STATE_HOME"] };
  afterEach(() => {
    if (orig.override === undefined) delete process.env["OLLAMA_AGENT_LEDGER"];
    else process.env["OLLAMA_AGENT_LEDGER"] = orig.override;
    if (orig.xdg === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = orig.xdg;
  });

  it("prefers the explicit override argument", () => {
    expect(resolveLedgerPath("/explicit/path.jsonl")).toBe("/explicit/path.jsonl");
  });

  it("falls back to OLLAMA_AGENT_LEDGER, then XDG_STATE_HOME", () => {
    process.env["OLLAMA_AGENT_LEDGER"] = "/env/override.jsonl";
    expect(resolveLedgerPath()).toBe("/env/override.jsonl");
    delete process.env["OLLAMA_AGENT_LEDGER"];
    process.env["XDG_STATE_HOME"] = "/xdg/state";
    expect(resolveLedgerPath()).toBe("/xdg/state/ollama-agent/runs.jsonl");
  });
});
