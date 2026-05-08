import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { renderContextLoopReport } from "@/reports/context-loop";

interface SeedFire {
  id: number;
  sessionId: string;
  cwd: string | null;
  firedAt: number;
  level: "advisory" | "escalated";
  fillPct: number;
  windowSize: number;
  assistantUuid: string;
  acted?: 0 | 1;
  detectedAt?: number | null;
  turnsUntilAction?: number | null;
}

interface SeedTurn {
  uuid: string;
  sessionId: string;
  ts: number;
  costUsd: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  stopReason?: string | null;
  model?: string;
}

function seedSidecar(path: string, schemaVer: number, fires: SeedFire[]): void {
  const db = new Database(path, { create: true });
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  db.exec(
    "CREATE TABLE fire_events (id INTEGER PRIMARY KEY, session_id TEXT, cwd TEXT, " +
    "fired_at INTEGER, level TEXT, fill_pct REAL, input_tokens INTEGER, " +
    "cache_read INTEGER, cache_create INTEGER, window_size INTEGER, model TEXT, assistant_uuid TEXT)"
  );
  db.exec(
    "CREATE TABLE compaction_outcomes (fire_event_id INTEGER PRIMARY KEY, acted INTEGER, " +
    "detected_at INTEGER, pre_fill_pct REAL, post_fill_pct REAL, tokens_reclaimed INTEGER, " +
    "turns_until_action INTEGER, detection_method TEXT)"
  );
  db.run("INSERT INTO meta VALUES ('schema_version', ?)", [String(schemaVer)]);
  for (const f of fires) {
    db.run(
      "INSERT INTO fire_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [f.id, f.sessionId, f.cwd, f.firedAt, f.level, f.fillPct, 0, 0, 0, f.windowSize, "claude-sonnet-4-6", f.assistantUuid]
    );
    if (f.acted !== undefined) {
      db.run(
        "INSERT INTO compaction_outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [f.id, f.acted, f.detectedAt ?? null, f.fillPct, null, null, f.turnsUntilAction ?? null, "advisory"]
      );
    }
  }
  db.close();
}

function seedStore(path: string, turns: SeedTurn[]): void {
  const db = new Database(path, { create: true });
  db.exec(
    "CREATE TABLE base_messages (uuid TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, " +
    "timestamp INTEGER, message_type TEXT, parent_uuid TEXT)"
  );
  db.exec(
    "CREATE TABLE assistant_messages (uuid TEXT PRIMARY KEY, cost_usd REAL, duration_ms INTEGER, " +
    "message TEXT, model TEXT, timestamp INTEGER)"
  );
  db.exec("CREATE TABLE user_messages (uuid TEXT PRIMARY KEY, message TEXT, timestamp INTEGER)");
  for (const t of turns) {
    db.run(
      "INSERT INTO base_messages VALUES (?, ?, ?, ?, ?, ?)",
      [t.uuid, t.sessionId, "/test/cwd", t.ts, "assistant", null]
    );
    const message = JSON.stringify({
      usage: {
        input_tokens: t.inputTokens ?? 100,
        output_tokens: t.outputTokens ?? 100,
        cache_read_input_tokens: t.cacheRead ?? 0,
        cache_creation_input_tokens: t.cacheWrite ?? 0,
      },
      stop_reason: t.stopReason ?? "end_turn",
      content: [{ type: "text", text: "ok" }],
    });
    db.run(
      "INSERT INTO assistant_messages VALUES (?, ?, ?, ?, ?, ?)",
      [t.uuid, t.costUsd, 0, message, t.model ?? "claude-sonnet-4-6", t.ts]
    );
  }
  db.close();
}

function seedStoreShapeBroken(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(
    "CREATE TABLE base_messages (uuid TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, " +
    "timestamp INTEGER, message_type TEXT, parent_uuid TEXT)"
  );
  db.exec(
    "CREATE TABLE assistant_messages (uuid TEXT PRIMARY KEY, cost_usd REAL, duration_ms INTEGER, " +
    "message TEXT, model TEXT, timestamp INTEGER)"
  );
  db.exec("CREATE TABLE user_messages (uuid TEXT PRIMARY KEY, message TEXT, timestamp INTEGER)");
  for (let i = 0; i < 3; i++) {
    db.run(
      "INSERT INTO assistant_messages VALUES (?, ?, ?, ?, ?, ?)",
      [`u-${i}`, 0.01, 0, '{"foo":"bar"}', "claude-sonnet-4-6", 1000 + i]
    );
  }
  db.close();
}

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { fn(); } finally { console.log = orig; }
  return lines.join("\n");
}

function buildFormulaFixture(overheadCost = 0.20): { fires: SeedFire[]; turns: SeedTurn[] } {
  // computeRoi excludes the fire's own turn from both windows.
  // pre   = the 5 turns BEFORE the fire turn (idx 0..4)
  // fire  = idx 5 (excluded)
  // post  = turns AFTER the fire turn, sliced to POST_WINDOW+1=6
  //   post[0] = overhead (idx 6); post[1..5] = postSteady (idx 7..11)
  const fires: SeedFire[] = [{
    id: 1,
    sessionId: "sess-formula",
    cwd: "/proj/a",
    firedAt: 5_000,
    level: "advisory",
    fillPct: 0.6,
    windowSize: 200_000,
    assistantUuid: "turn-fire",
    acted: 1,
    detectedAt: 5_100,
    turnsUntilAction: 1,
  }];
  const turns: SeedTurn[] = [];
  for (let i = 0; i < 5; i++) {
    turns.push({ uuid: `turn-pre-${i}`, sessionId: "sess-formula", ts: 1_000 + i, costUsd: 0.10 });
  }
  turns.push({ uuid: "turn-fire", sessionId: "sess-formula", ts: 5_000, costUsd: 0.50 });
  turns.push({ uuid: "turn-overhead", sessionId: "sess-formula", ts: 5_500, costUsd: overheadCost });
  for (let i = 0; i < 5; i++) {
    turns.push({ uuid: `turn-post-${i}`, sessionId: "sess-formula", ts: 6_000 + i, costUsd: 0.04 });
  }
  return { fires, turns };
}

type Section = "tuning" | "reclamation" | "patterns" | "roi" | "all";

describe("context-loop report", () => {
  let tmp: string;
  let sidecar: string;
  let store: string;
  let prevContextLoopDb: string | undefined;
  let prevTokenScopeDb: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tscope-cl-"));
    sidecar = join(tmp, "context-loop.db");
    store = join(tmp, "__store.db");
    prevContextLoopDb = process.env["CONTEXT_LOOP_DB"];
    prevTokenScopeDb = process.env["TOKEN_SCOPE_DB"];
    process.env["CONTEXT_LOOP_DB"] = sidecar;
    process.env["TOKEN_SCOPE_DB"] = store;
  });

  afterEach(() => {
    if (prevContextLoopDb === undefined) delete process.env["CONTEXT_LOOP_DB"];
    else process.env["CONTEXT_LOOP_DB"] = prevContextLoopDb;
    if (prevTokenScopeDb === undefined) delete process.env["TOKEN_SCOPE_DB"];
    else process.env["TOKEN_SCOPE_DB"] = prevTokenScopeDb;
    rmSync(tmp, { recursive: true, force: true });
  });

  const opts = (over: Partial<{ sections: Section[]; json: boolean }> = {}) => ({
    since: 0,
    sinceStr: "all",
    limit: 20,
    json: true,
    sections: ["all"] as Section[],
    ...over,
  });

  it("missing sidecar DB prints clean diagnostic, no throw", () => {
    const out = capture(() => renderContextLoopReport(opts()));
    const parsed = JSON.parse(out);
    expect(parsed.error).toContain("No context-loop database");
  });

  it("schema version mismatch bails with diagnostic", () => {
    seedSidecar(sidecar, 999, []);
    seedStore(store, [{ uuid: "u1", sessionId: "s", ts: 1, costUsd: 0.01 }]);
    const out = capture(() => renderContextLoopReport(opts()));
    const parsed = JSON.parse(out);
    expect(parsed.error).toContain("schema version mismatch");
    expect(parsed.error).toContain("found 999");
  });

  it("storeDb shape mismatch bails when usage.input_tokens is absent", () => {
    seedSidecar(sidecar, 1, []);
    seedStoreShapeBroken(store);
    const out = capture(() => renderContextLoopReport(opts()));
    const parsed = JSON.parse(out);
    expect(parsed.error).toContain("shape mismatch");
  });

  it("realized savings formula produces hand-computed value", () => {
    // preAvg=$0.10, overhead=$0.20, postAvg=$0.04, turnsUsedPost=5
    // realized = (0.10 - 0.04) * 5 - 0.20 = 0.10
    // roi = 0.10 / 0.20 = 0.5
    const { fires, turns } = buildFormulaFixture();
    seedSidecar(sidecar, 1, fires);
    seedStore(store, turns);

    const out = capture(() => renderContextLoopReport(opts()));
    const parsed = JSON.parse(out);

    expect(parsed.rois).toHaveLength(1);
    const r = parsed.rois[0];
    expect(r.preAvgCostUsd).toBeCloseTo(0.10, 5);
    expect(r.overheadUsd).toBeCloseTo(0.20, 5);
    expect(r.postAvgCostUsd).toBeCloseTo(0.04, 5);
    expect(r.realizedSavingsUsd).toBeCloseTo(0.10, 5);
    expect(r.roi).toBeCloseTo(0.5, 5);
    expect(r.turnsUsedPost).toBe(5);
  });

  it("cross-DB join carries cwd from fire_events into rois", () => {
    const { fires, turns } = buildFormulaFixture();
    fires[0]!.cwd = "/unique/cwd/marker";
    seedSidecar(sidecar, 1, fires);
    seedStore(store, turns);
    const out = capture(() => renderContextLoopReport(opts()));
    const parsed = JSON.parse(out);
    expect(parsed.rois[0].cwd).toBe("/unique/cwd/marker");
    expect(parsed.fires[0].cwd).toBe("/unique/cwd/marker");
  });

  it("uuid miss flips to ts-based fallback and bumps diag.uuidMissFallback", () => {
    const { fires, turns } = buildFormulaFixture();
    fires[0]!.assistantUuid = "no-such-uuid";
    seedSidecar(sidecar, 1, fires);
    seedStore(store, turns);
    const out = capture(() => renderContextLoopReport(opts()));
    const parsed = JSON.parse(out);
    expect(parsed.diag.uuidMissFallback).toBe(1);
  });

  it("empty post-window (single-turn session) does not throw or NaN", () => {
    const fires: SeedFire[] = [{
      id: 1, sessionId: "sess-1turn", cwd: "/x", firedAt: 5_000,
      level: "advisory", fillPct: 0.6, windowSize: 200_000,
      assistantUuid: "only-turn", acted: 1, detectedAt: 5_100, turnsUntilAction: 0,
    }];
    const turns: SeedTurn[] = [
      { uuid: "only-turn", sessionId: "sess-1turn", ts: 5_000, costUsd: 0.05 },
    ];
    seedSidecar(sidecar, 1, fires);
    seedStore(store, turns);
    const out = capture(() => renderContextLoopReport(opts()));
    const parsed = JSON.parse(out);
    expect(parsed.rois).toHaveLength(1);
    const r = parsed.rois[0];
    expect(r.realizedSavingsUsd).toBeNull();
    expect(r.roi).toBeNull();
    expect(r.turnsUsedPost).toBe(0);
  });

  it("sub-cent overhead clamps ROI to null but still yields realized savings", () => {
    const { fires, turns } = buildFormulaFixture(0.0005);
    seedSidecar(sidecar, 1, fires);
    seedStore(store, turns);
    const out = capture(() => renderContextLoopReport(opts()));
    const parsed = JSON.parse(out);
    expect(parsed.rois[0].roi).toBeNull();
    expect(parsed.rois[0].realizedSavingsUsd).not.toBeNull();
  });

  it("no fires recorded yields empty rois array, no throw", () => {
    seedSidecar(sidecar, 1, []);
    seedStore(store, [{ uuid: "u1", sessionId: "s", ts: 1, costUsd: 0.01 }]);
    const out = capture(() => renderContextLoopReport(opts()));
    const parsed = JSON.parse(out);
    expect(parsed.fires).toHaveLength(0);
    expect(parsed.rois).toHaveLength(0);
  });
});
