import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { claudeEvents, claudeEventsFromTranscript } from "@/providers/claude";
import { ollamaEvents, ollamaEventsFromRuns } from "@/providers/ollama";
import { opencodeEventsFromDb } from "@/providers/opencode";
import type { LedgerRun } from "@/ledger";
import { codexEventsFromRollout } from "@/providers/codex";
import { collectProviderEvents, dedupeEvents } from "@/providers";
import { stableId } from "@/providers/types";
import { providerRows, renderProviderReport, providerReportJson, untimedExcluded } from "@/reports/providers";

const FX = join(import.meta.dir, "fixtures", "providers");

describe("claude adapter", () => {
  it("normalizes usage classes and skips torn lines", () => {
    const ev = claudeEventsFromTranscript(
      readFileSync(join(FX, "claude-sample.jsonl"), "utf8"),
      "claude-sample.jsonl",
    );
    expect(ev.length).toBe(2);
    expect(ev[0]!.inputTokens).toBe(100);
    expect(ev[0]!.cacheReadTokens).toBe(200);
    expect(ev[0]!.cacheWriteTokens).toBe(30);
    expect(ev[0]!.reasoningTokens).toBeNull();
    expect(ev[0]!.billingRoute).toBe("subscription");
  });
});

describe("claude accounting (#37 post-merge audit)", () => {
  it("counts one event per billed response, not per transcript line", () => {
    // Three lines share msg_dup_1 (streaming/sidechain copies carry identical
    // usage); live measurement found ~107M double-counted output tokens.
    const text = readFileSync(join(FX, "claude-root/projects/-Users-x-proj/dup-responses.jsonl"), "utf8");
    const ev = claudeEventsFromTranscript(text, "dup.jsonl");
    expect(ev.length).toBe(2); // msg_dup_1 + msg_proxy_1
    const dup = ev.find((e) => e.inputTokens === 100);
    expect(dup).toBeDefined();
    expect(ev.filter((e) => e.inputTokens === 100).length).toBe(1);
  });

  it("does not label proxy-delegated models as Anthropic subscription", () => {
    const text = readFileSync(join(FX, "claude-root/projects/-Users-x-proj/dup-responses.jsonl"), "utf8");
    const ev = claudeEventsFromTranscript(text, "dup.jsonl");
    const qwen = ev.find((e) => e.model === "qwen3.8:27b");
    expect(qwen!.billingRoute).toBe("unknown"); // NOT subscription — never was
    expect(qwen!.modelProvider).toBe("unknown");
  });

  it("scans subagent transcript directories recursively", () => {
    const { events } = claudeEvents(join(FX, "claude-root"));
    const agent = events.find((e: any) => e.provenance.includes("subagents"));
    expect(agent).toBeDefined();
    expect(agent!.inputTokens).toBe(7);
  });

  it("prefilters by mtime under --since instead of parsing every file", async () => {
    const { utimesSync, cpSync, mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    // Copy the fixture so mtime writes never touch tracked files and never
    // race the concurrent CLI test reading the same claude-root (#43).
    // Pin every file's mtime: cpSync timestamp semantics differ across
    // platforms, and CI checks the fixture out seconds before the test runs.
    const tmp = mkdtempSync(join(tmpdir(), "ts-mtime-fixture-"));
    try {
      const root = join(tmp, "claude-root");
      cpSync(join(FX, "claude-root"), root, { recursive: true });
      const proj = join(root, "projects/-Users-x-proj");
      const fresh = new Date();
      for (const f of ["dup-responses.jsonl", "resumed-ses-fix.jsonl", "subagents/agent-transcript.jsonl"]) {
        utimesSync(join(proj, f), fresh, fresh);
      }
      const stale = new Date(Date.now() - 86_400_000);
      utimesSync(join(proj, "t.jsonl"), stale, stale);
      const sinceMs = Date.now() - 60_000;
      const { events } = claudeEvents(root, sinceMs);
      expect(events.some((e: any) => e.provenance === join(proj, "t.jsonl"))).toBe(false);
      expect(events.some((e: any) => e.provenance.includes("dup-responses"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("codex resumed sessions (#37 post-merge audit)", () => {
  it("keeps distinct rollouts distinct even when session_meta id is inherited", async () => {
    const { codexEvents } = await import("@/providers/codex");
    const { events, skipped } = codexEvents(join(FX, "codex-home"));
    expect(skipped).toBe(0);
    const ids = new Set(events.map((e: any) => e.eventId));
    expect(ids.size).toBe(events.length); // no silent dedup of real sessions
    expect(events.filter((e: any) => e.provenance.includes("resumed-copy")).length).toBe(1);
  });
});

describe("ollama run_id reuse (#37 post-merge audit)", () => {
  it("repeated run_ids with different content are distinct observations", () => {
    const mk = (ts: string, input: number) => ({
      ts, runId: "author:234", sessionId: null, model: "qwen",
      taskName: "fix", cwd: null, ollamaInputTokens: input,
      ollamaOutputTokens: 10, turns: 1, completed: true,
      verified: true, reason: "ok",
    } as any);
    const evs = ollamaEventsFromRuns([mk("2026-08-21T01:00:00Z", 100), mk("2026-08-21T02:00:00Z", 600000)], "ledger");
    expect(evs.length).toBe(2);
    const deduped = dedupeEvents(evs);
    expect(deduped.length).toBe(2); // dedup must not delete the second run
  });
});

describe("opencode cost/error/id mapping (#37 post-merge audit)", () => {
  it("maps measured cost to cash charge, error state to status, db pk to ids", () => {
    const Database = require("bun:sqlite").Database;
    const db = new Database(":memory:");
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    const ins = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
    ins.run("row-1", "ses1", JSON.stringify({
      role: "assistant", modelID: "kimi-k3", providerID: "opencode",
      cost: 0.042, tokens: { input: 10, output: 5 }, time: { created: 1755000000000 },
    }));
    ins.run("row-2", "ses1", JSON.stringify({
      role: "assistant", modelID: "kimi-k3", providerID: "opencode",
      cost: 0.001, error: { name: "MessageAbortedError" },
      tokens: { input: 4, output: 2 }, time: { created: 1755000001000 },
    }));
    const ev = opencodeEventsFromDb(db);
    expect(ev[0]!.cashChargeUsd).toBe(0.042); // measured cost survives
    expect(ev[0]!.billingRoute).toBe("metered");
    expect(ev[0]!.status).toBe("ok");
    expect(ev[1]!.status).toBe("error"); // aborted messages are not successes
    expect(ev.every((e) => e.cashChargeUsd !== null)).toBe(true);
    expect(ev[0]!.eventId).toBe(stableId("opencode", "row-1")); // db pk, not JSON id
    db.close();
  });

  it("keeps two rows distinct when their JSON-internal ids collide (#41)", () => {
    const Database = require("bun:sqlite").Database;
    const { dedupeEvents } = require("@/providers");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    const ins = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
    // Same rec.id in the blob, different db primary keys: both rows' tokens
    // must survive dedupe, mirroring the codex inherited-id hazard.
    for (const rowId of ["row-a", "row-b"]) {
      ins.run(rowId, "ses1", JSON.stringify({
        id: "msg_dup", role: "assistant", modelID: "m", providerID: "opencode",
        cost: 0.01, tokens: { input: 10, output: 5 }, time: { created: 1755000000000 },
      }));
    }
    const ev = opencodeEventsFromDb(db);
    expect(ev.length).toBe(2);
    expect(dedupeEvents(ev).length).toBe(2); // no silent collapse onto the shared JSON id
    db.close();
  });

  it("prefilters by created time at the storage layer", () => {
    const Database = require("bun:sqlite").Database;
    const db = new Database(":memory:");
    db.exec("CREATE TABLE message (id INTEGER PRIMARY KEY, session_id TEXT, data TEXT)");
    const old = new Date(Date.now() - 86_400_000 * 30).getTime();
    const now = Date.now();
    const ins = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)");
    ins.run(null, "s", JSON.stringify({ role: "assistant", tokens: { input: 1 }, time: { created: old } }));
    ins.run(null, "s", JSON.stringify({ role: "assistant", tokens: { input: 2 }, time: { created: now } }));
    const ev = opencodeEventsFromDb(db, now - 60_000);
    expect(ev.length).toBe(1);
    expect(ev[0]!.inputTokens).toBe(2);
    db.close();
  });
});

describe("partial aggregation (#37 post-merge audit)", () => {
  it("marks classes where some events omit a value instead of labeling fully measured", () => {
    const base: any = (over: object) => ({
      eventId: "x", harness: "claude", billingRoute: "subscription",
      modelProvider: "anthropic", model: "m", ts: "2026-08-22T00:00:00Z",
      status: "ok", retryOf: null, inputTokens: 10, outputTokens: 5,
      cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
      cashChargeUsd: null, provenance: "p", ...over,
    });
    const collected = {
      events: [
        base({ eventId: "a", cacheReadTokens: 100 }), // reports cacheRead
        base({ eventId: "b", cacheReadTokens: null }), // omits it entirely
      ],
      unavailable: [] as string[],
      partial: {},
    };
    const rows = providerRows(collected as any);
    // claude-sample fixture semantics: absent vs zero matter; here b omits
    expect(rows[0]!.cacheRead).toBe(100); // sums what exists
    expect(rows[0]!.partialClasses).toContain("cacheRead"); // and says so
  });
});

describe("claude collector", () => {
  it("skips stray files in projects/ instead of losing the source (#37 live find)", () => {
    // .DS_Store next to project dirs made readdirSync throw ENOTDIR, which the
    // collect-level catch turned into "claude unavailable" — volume unknown.
    const { events: ev } = claudeEvents(join(FX, "claude-root"));
    // Recursive scan: t.jsonl + resumed-ses-fix.jsonl + subagents/ +
    // dup-responses.jsonl (2 unique billed responses) = 5 events.
    expect(ev.length).toBe(5);
    const t = ev.find((e: any) => e.inputTokens === 10);
    expect(t).toBeDefined();
    // genuine zero must survive as 0 — null is for absent classes (#38 panel)
    expect(t!.cacheWriteTokens).not.toBeNull();
  });
});

describe("provider report", () => {
  it("surfaces retries and marks every value measured (#37 acceptance criteria)", () => {
    const base = {
      eventId: "claude:1",
      harness: "claude" as const,
      billingRoute: "subscription" as const,
      modelProvider: "anthropic",
      model: "m1",
      ts: "2026-08-22T00:00:00Z",
      status: "ok" as const,
      retryOf: null,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      cashChargeUsd: null,
      provenance: "p.jsonl",
    };
    const retry = { ...base, eventId: "claude:2", retryOf: "claude:1" };
    const collected = { events: [base, retry], unavailable: [] as string[], partial: {} };
    const rows = providerRows(collected);
    expect(rows[0]!.retries).toBe(1);
    const out = renderProviderReport(rows, []);
    expect(out).toContain("all values measured from source records; no estimates");
    expect(providerReportJson(rows, []).measured).toBe(true);
  });
});

describe("ollama adapter", () => {
  it("keeps absent cache/reasoning classes null, not zero", () => {
    // Snake_case fixture mirrors the real ledger rows (#37 step 1: inspect a
    // real record before freezing the schema). Drive through readLedger so
    // the field mapping under test matches production.
    const ev = ollamaEvents(join(FX, "ledger-sample.jsonl"));
    expect(ev.length).toBe(1);
    expect(ev[0]!.inputTokens).toBe(5758);
    expect(ev[0]!.cacheReadTokens).toBeNull();
    expect(ev[0]!.reasoningTokens).toBeNull();
    expect(ev[0]!.billingRoute).toBe("local");
  });
});

describe("codex adapter", () => {
  it("emits one aggregate event with final cumulative totals", () => {
    const ev = codexEventsFromRollout(
      readFileSync(join(FX, "codex-rollout.jsonl"), "utf8"),
      "codex-rollout.jsonl",
    );
    expect(ev.length).toBe(1);
    expect(ev[0]!.eventId.startsWith("codex:019e-codex")).toBe(true);
    // OpenAI-style input includes cached; adapter emits the disjoint 750.
    expect(ev[0]!.inputTokens).toBe(750);
    expect(ev[0]!.cacheReadTokens).toBe(150);
    expect(ev[0]!.reasoningTokens).toBe(40);
  });
});

describe("dedup + report", () => {
  const text = readFileSync(join(FX, "claude-sample.jsonl"), "utf8");
  const once = claudeEventsFromTranscript(text, "same.jsonl");
  const collected = {
    events: [...once, ...once], // re-scan of the same source
    unavailable: [] as string[],
  };

  it("collapses re-scans deterministically", () => {
    const collected2 = { ...collected, partial: {} };
    const rows = providerRows({ ...collected2, events: dedupeEvents(collected2.events) });
    expect(rows.filter((r) => r.harness === "claude").length).toBe(1);
    expect(rows[0]!.events).toBe(2); // deduped to distinct events only
  });

  it("renders nulls as em-dashes and lists unavailable sources", () => {
    const out = renderProviderReport(
      [{ harness: "x", billingRoute: "local", model: "m", events: 1, input: 5, output: null, cacheRead: null, cacheWrite: null, reasoning: null, retries: 0, cashUsd: null, partialClasses: [], provenance: ["a.jsonl"] }],
      ["opencode"],
    );
    expect(out).toContain("—");
    expect(out).toContain("unavailable sources (volume unknown, not zero): opencode");
  });

  it("--since keeps in-window events and drops undatable ones countably (#38 panel, #42)", () => {
    const mk = (id: string, ts: string | null): any => ({
      eventId: id, harness: "claude", billingRoute: "subscription",
      modelProvider: "anthropic", model: "m", ts, status: "ok", retryOf: null,
      inputTokens: 10, outputTokens: 1, cacheReadTokens: null,
      cacheWriteTokens: null, reasoningTokens: null, cashChargeUsd: null,
      provenance: `${id}.jsonl`,
    });
    const now = Date.now();
    const c = {
      events: [
        mk("in", new Date(now - 1000).toISOString()),
        mk("untimed", null),
        mk("garbage", "not-a-date"),
      ],
      unavailable: [] as string[], partial: {},
    };
    const rows = providerRows(c, now - 60000);
    expect(rows.length).toBe(1); // in-window survives
    expect(rows[0]!.input).toBe(10);
    // Malformed timestamps are excluded alongside absent ones and counted,
    // not silently dropped while the counter says 0 (#42).
    expect(untimedExcluded(c, now - 60000)).toBe(2);
    const all = providerRows({ ...c, partial: {} }); // no window: nothing dropped
    expect(all.reduce((a, r) => a + r.events, 0)).toBe(3); // all events grouped
  });

  it("sum() treats genuine zero as measured and all-null as unknown (#38 panel)", () => {
    const rows = renderProviderReport(
      [{ harness: "x", billingRoute: "local", model: "m", events: 2, input: 7, output: 0, cacheRead: null, cacheWrite: null, reasoning: null, retries: 0, cashUsd: null, partialClasses: ["output"], provenance: ["a"] }],
      [],
    );
    expect(rows).toContain("  0  "); // zero renders as 0, not an em-dash
    expect(rows.split("\n").some((l) => l.includes("—"))).toBe(true); // nulls still dash
    expect(rows).toContain("output"); // the partial class is named, not hidden
  });

  it("present-but-unparseable ledger surfaces as partial, not silent zero (#37)", async () => {
    const { mkdirSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const dir = join(tmpdir(), `ts-ledger-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.jsonl"), "not json\nalso not json\n");
    const c = collectProviderEvents({
      claudeRoot: "/nonexistent",
      ledgerPath: join(dir, "ledger.jsonl"),
      codexHome: "/nonexistent",
      opencodeDb: "/nonexistent.db",
    });
    expect(c.partial["ollama-claude"]).toBe(2); // two real rows, zero events
    expect(c.unavailable).toEqual(["opencode"]);
  });

  it("an absent ledger is legitimately zero, not unavailable", () => {
    const c = collectProviderEvents({
      claudeRoot: "/nonexistent",
      ledgerPath: "/nonexistent-dir/ledger.jsonl",
      codexHome: "/nonexistent",
      opencodeDb: "/nonexistent.db",
    });
    expect(c.unavailable).toEqual(["opencode"]);
    expect(c.partial["ollama-claude"]).toBeUndefined();
  });

  it("collectProviderEvents reports missing sources as unknown", () => {
    const c = collectProviderEvents({
      claudeRoot: "/nonexistent",
      ledgerPath: "/nonexistent.jsonl",
      codexHome: "/nonexistent",
      opencodeDb: "/nonexistent.db",
    });
    // Absent sources are legitimately empty (a machine without codex has zero
    // codex usage). Unavailable is reserved for present-but-unreadable sources
    // (locked/corrupt db) where volume is unknown rather than zero (#37).
    expect(c.unavailable).toEqual(["opencode"]);
  });
});

describe("opencode adapter (#38 panel: was untested)", () => {
  it("maps token classes, keeps absent ones null, skips non-assistant rows", () => {
    const Database = require("bun:sqlite").Database;
    const db = new Database(":memory:");
    db.exec("CREATE TABLE message (id INTEGER PRIMARY KEY, session_id TEXT, data TEXT)");
    const msg = (id: string, role: string, tokens: any, model = "kimi-k3", created = 1755000000000) =>
      JSON.stringify({ id, role, tokens, modelID: model, providerID: "opencode", time: { created } });
    db.run("INSERT INTO message (session_id, data) VALUES (?, ?)", "ses1",
      msg("m1", "assistant", { input: 10, output: 5, reasoning: 3, cache: { read: 7 } }));
    db.run("INSERT INTO message (session_id, data) VALUES (?, ?)", "ses1",
      msg("m2", "user", { input: 99 }));
    db.run("INSERT INTO message (session_id, data) VALUES (?, ?)", "ses1",
      msg("m3", "assistant", { input: 4, output: 2 }));
    const ev = opencodeEventsFromDb(db);
    expect(ev.length).toBe(2); // user row skipped
    expect(ev[0]!.inputTokens).toBe(10);
    expect(ev[0]!.cacheReadTokens).toBe(7);
    expect(ev[0]!.cacheWriteTokens).toBeNull(); // absent class stays null
    expect(ev[0]!.model).toBe("kimi-k3");
    // no rec.id: same-ms fallback must not collide (#38 panel)
    expect(ev[0]!.eventId).not.toBe(ev[1]!.eventId);
    db.close();
  });
});

describe("codex adapter (#38 panel findings)", () => {
  it("extracts the real model, disjoint input, end-of-usage timestamp", () => {
    const rollout = [
      JSON.stringify({ type: "session_meta", payload: { id: "cx1", timestamp: "2026-08-20T00:00:00Z", model_provider: "openai" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.2-codex" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-08-21T12:00:00Z", payload: { info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 2 } } } }),
    ].join("\n");
    const ev = codexEventsFromRollout(rollout, "/x/codex.jsonl");
    expect(ev.length).toBe(1);
    expect(ev[0]!.model).toBe("gpt-5.2-codex"); // provider is not the model
    expect(ev[0]!.inputTokens).toBe(60); // cached subset removed: disjoint classes
    expect(ev[0]!.cacheReadTokens).toBe(40);
    expect(ev[0]!.ts).toBe("2026-08-21T12:00:00Z"); // when usage accrued, not session start
  });
});

describe("ollama adapter ids (#38 panel)", () => {
  it("legacy rows without run_id keep stable content-derived ids", () => {
    const run = {
      ts: "2026-08-21T01:00:00Z", runId: null, sessionId: "sesA", model: "qwen",
      taskName: "fix", cwd: null, ollamaInputTokens: 100, ollamaOutputTokens: 20,
      turns: 3, completed: true, verified: true, reason: "ok",
    } as any;
    const a = ollamaEventsFromRuns([run], "ledger");
    const b = ollamaEventsFromRuns([{ ...run }], "ledger");
    expect(a[0]!.eventId).toBe(b[0]!.eventId); // re-scan collapses
    const other = ollamaEventsFromRuns([{ ...run, sessionId: "sesB" }], "ledger");
    expect(other[0]!.eventId).not.toBe(a[0]!.eventId); // different runs stay distinct
    expect(a[0]!.retryOf).toBeNull();
  });
});

describe("collect integration over fixtures (#38 panel)", () => {
  it("claude and codex fixtures both survive collection with dedup applied once", () => {
    const c = collectProviderEvents({
      claudeRoot: join(FX, "claude-root"),
      ledgerPath: "/nonexistent.jsonl",
      codexHome: join(FX, "codex-home"),
      opencodeDb: "/nonexistent.db",
    });
    expect(c.partial["opencode"]).toBeUndefined();
    const ids = c.events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length); // single dedup pass, no dupes
    expect(c.events.filter((e) => e.harness === "claude").length).toBe(5);
    expect(c.events.filter((e) => e.harness === "codex").length).toBeGreaterThan(0);
  });

  it("measured sums are data-derived, not constants (#38 panel)", () => {
    const text = readFileSync(join(FX, "claude-sample.jsonl"), "utf8");
    const evs = claudeEventsFromTranscript(text, "f.jsonl");
    const wantInput = evs.reduce((a, e) => a + (e.inputTokens ?? 0), 0);
    const rows = providerRows({ events: evs, unavailable: [], partial: {} });
    expect(rows[0]!.input).toBe(wantInput);
    expect(rows[0]!.provenance).toEqual(["f.jsonl"]);
  });
});
