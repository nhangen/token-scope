import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  FLEET_SCHEMA_VERSION,
  classifySnapshotFreshness,
  correlationKeys,
  dedupeFleetRecords,
  joinUsageToSnapshots,
  parseFleetRecord,
  snapshotCounterDelta,
  usageFallsInSnapshotWindow,
} from "@/fleet-contract";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "fleet-contract-v1.json"), "utf8"),
);

const parsedUsage = parseFleetRecord(fixture.usage_event);
const parsedSnapshot = parseFleetRecord(fixture.operational_snapshot);
if (parsedUsage.record_type !== "usage_event") throw new Error("wrong usage fixture type");
if (parsedSnapshot.record_type !== "operational_snapshot") {
  throw new Error("wrong snapshot fixture type");
}

describe("fleet schema v1 contract", () => {
  const usage = parsedUsage;
  const snapshot = parsedSnapshot;

  it("distinguishes a request event from an aggregate snapshot", () => {
    expect(FLEET_SCHEMA_VERSION).toBe("1.0");
    expect(usage.record_type).toBe("usage_event");
    expect(snapshot.record_type).toBe("operational_snapshot");
    expect(usage.usage.cache_read_tokens).toBeNull();
    expect(usage.usage.cash_charge_usd).toBeNull();
    expect(snapshot.counters.errors).toBeNull();
    expect(snapshot.status).toBe("partial");
  });

  it("requires snapshot status to agree with partial provenance", () => {
    expect(() => parseFleetRecord({
      ...fixture.operational_snapshot,
      status: "ok",
    })).toThrow("snapshot status and provenance completeness must agree");
    expect(() => parseFleetRecord({
      ...fixture.operational_snapshot,
      status: "partial",
      provenance: { ...fixture.operational_snapshot.provenance, completeness: "complete" },
    })).toThrow("snapshot status and provenance completeness must agree");
  });

  it("requires integer token counts while retaining decimal cash costs", () => {
    expect(() => parseFleetRecord({
      ...fixture.usage_event,
      usage: { ...fixture.usage_event.usage, input_tokens: 1.5 },
    })).toThrow("usage.input_tokens must be a non-negative integer or null");

    const withDecimalCost = parseFleetRecord({
      ...fixture.usage_event,
      usage: { ...fixture.usage_event.usage, cash_charge_usd: 0.0125 },
    });
    if (withDecimalCost.record_type !== "usage_event") throw new Error("wrong fixture type");
    expect(withDecimalCost.usage.cash_charge_usd).toBe(0.0125);
  });

  it("uses deterministic qualified join keys and half-open snapshot windows", () => {
    expect(correlationKeys(usage)).toEqual([
      "request_id=openai:req-7",
      "run_id=codex:run-3",
      "session_id=codex:session-2",
    ]);
    expect(correlationKeys(snapshot)).toEqual(["run_id=codex:run-3"]);
    expect(usageFallsInSnapshotWindow(usage, snapshot)).toBe(true);

    const atEnd = { ...usage, timestamp: snapshot.window.end };
    expect(usageFallsInSnapshotWindow(atEnd, snapshot)).toBe(false);
    expect(usageFallsInSnapshotWindow({ ...usage, timestamp: null }, snapshot)).toBeNull();
  });

  it("rejects unqualified identifiers and non-canonical timestamps", () => {
    expect(() => parseFleetRecord({ ...fixture.usage_event, schema_version: "2.0" }))
      .toThrow("unsupported fleet schema version");
    expect(() => parseFleetRecord({ ...fixture.usage_event, run_id: "run-3" })).toThrow();
    expect(() => parseFleetRecord({
      ...fixture.usage_event,
      timestamp: "2026-02-31T14:02:03.456Z",
    })).toThrow();
    expect(() => parseFleetRecord({
      ...fixture.usage_event,
      timestamp: "2026-09-22T10:02:03-04:00",
    })).toThrow();
  });

  it("surfaces matched, unmatched, and ambiguous joins without attribution guesses", () => {
    expect(joinUsageToSnapshots(usage, [snapshot])).toEqual({
      state: "matched",
      key: "run_id=codex:run-3",
      snapshot,
    });
    expect(joinUsageToSnapshots({ ...usage, run_id: null }, [snapshot])).toEqual({
      state: "unmatched",
      key: null,
      snapshot: null,
    });
    expect(joinUsageToSnapshots(usage, [snapshot, { ...snapshot, record_id: "olla:snapshot:2" }])).toEqual({
      state: "ambiguous",
      key: "run_id=codex:run-3",
      snapshot: null,
    });
  });

  it("deduplicates identical records but surfaces record-id collisions", () => {
    expect(dedupeFleetRecords([snapshot, usage, usage])).toEqual({
      records: [snapshot, usage],
      conflicts: [],
    });
    const conflict = { ...usage, model: "different-model" };
    expect(dedupeFleetRecords([usage, conflict])).toEqual({
      records: [],
      conflicts: [usage.record_id],
    });
  });

  it("makes stale, restart, reset, and unavailable counter states explicit", () => {
    expect(classifySnapshotFreshness(snapshot, "2026-09-22T14:06:00.000Z")).toBe("current");
    expect(classifySnapshotFreshness(snapshot, "2026-09-22T14:06:00.001Z")).toBe("stale");

    const next = {
      ...snapshot,
      timestamp: "2026-09-22T14:10:00.000Z",
      window: { start: "2026-09-22T14:05:00.000Z", end: "2026-09-22T14:10:00.000Z" },
      counters: { requests: 25, errors: null },
    };
    expect(snapshotCounterDelta(snapshot, next, "requests")).toEqual({
      state: "continuous",
      value: 7,
    });
    expect(snapshotCounterDelta(snapshot, { ...next, process_id: "olla:ml1:pid-43" }, "requests"))
      .toEqual({ state: "restart", value: null });
    expect(snapshotCounterDelta(snapshot, { ...next, counters: { requests: 2 } }, "requests"))
      .toEqual({ state: "reset", value: null });
    expect(snapshotCounterDelta(snapshot, { ...next, counters: { requests: null } }, "requests"))
      .toEqual({ state: "unavailable", value: null });
  });

  it("rejects private content at any nesting depth", () => {
    expect(() => parseFleetRecord({ ...fixture.usage_event, prompt: "secret" }))
      .toThrow("private field prompt");
    expect(() => parseFleetRecord({
      ...fixture.operational_snapshot,
      counters: { requests: 18, raw_authorization_headers: "Bearer secret" },
    })).toThrow("private field raw_authorization_headers");
  });
});
