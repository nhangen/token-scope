import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  assertSafeLabelValue,
  FLEET_SCHEMA_VERSION,
  PrivacyError,
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

  it("orders counter names by code unit, independent of locale", () => {
    const parsed = parseFleetRecord({
      ...fixture.operational_snapshot,
      counters: { a: 1, B: 2 },
    });
    if (parsed.record_type !== "operational_snapshot") throw new Error("wrong fixture type");
    expect(Object.keys(parsed.counters)).toEqual(["B", "a"]);
  });

  it("requires an integer stale threshold", () => {
    expect(() => parseFleetRecord({ ...fixture.operational_snapshot, stale_after_ms: 1.5 }))
      .toThrow("stale_after_ms must be a non-negative integer or null");
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
    expect(() => parseFleetRecord({ ...fixture.usage_event, run_id: "run-3" }))
      .toThrow("run_id must be source-qualified");
    expect(() => parseFleetRecord({
      ...fixture.usage_event,
      timestamp: "2026-02-31T14:02:03.456Z",
    })).toThrow("timestamp must be a valid timestamp");
    expect(() => parseFleetRecord({
      ...fixture.usage_event,
      timestamp: "2026-09-22T10:02:03-04:00",
    })).toThrow("timestamp must be an RFC 3339 UTC timestamp");
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
    expect(dedupeFleetRecords([usage, snapshot, usage])).toEqual({
      records: [snapshot, usage],
      conflicts: [],
    });
    const reordered = Object.fromEntries(Object.entries(usage).reverse()) as typeof usage;
    expect(dedupeFleetRecords([usage, reordered])).toEqual({
      records: [usage],
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
    expect(snapshotCounterDelta(snapshot, { ...next, counters: { errors: null } }, "requests"))
      .toEqual({ state: "unavailable", value: null });
  });

  it("rejects counter names absent from both snapshots, including prototype names", () => {
    expect(() => snapshotCounterDelta(snapshot, snapshot, "reqests"))
      .toThrow("snapshot counter reqests is not present in either snapshot");
    for (const name of ["toString", "constructor", "valueOf"]) {
      expect(() => snapshotCounterDelta(snapshot, snapshot, name)).toThrow("not present");
    }
  });

  it("treats a prototype name present on neither plain counter object as absent", () => {
    const plainPrevious = { ...snapshot, counters: { requests: 3 } };
    const plainCurrent = { ...snapshot, counters: { requests: 5 } };
    expect(() => snapshotCounterDelta(plainPrevious, plainCurrent, "toString")).toThrow("not present");
    expect(snapshotCounterDelta(plainPrevious, { ...plainCurrent, counters: { toString: 5 } }, "toString"))
      .toEqual({ state: "unavailable", value: null });
  });

  it("keeps a __proto__ counter as an own measured value", () => {
    const parsed = parseFleetRecord(JSON.parse(JSON.stringify(fixture.operational_snapshot)
      .replace('"requests":18', '"__proto__":7,"requests":18')));
    if (parsed.record_type !== "operational_snapshot") throw new Error("wrong fixture type");
    expect(Object.keys(parsed.counters)).toEqual(["__proto__", "errors", "requests"]);
    expect(parsed.counters["__proto__"]).toBe(7);
  });

  it("rejects private content at any nesting depth", () => {
    expect(() => parseFleetRecord({ ...fixture.usage_event, prompt: "secret" }))
      .toThrow("private field prompt");
    expect(() => parseFleetRecord({
      ...fixture.operational_snapshot,
      counters: { requests: 18, raw_authorization_headers: "Bearer secret" },
    })).toThrow("private field raw_authorization_headers");
  });

  it("rejects credentials embedded in the provenance locator", () => {
    const withLocator = (locator: string) => ({
      ...fixture.operational_snapshot,
      provenance: { ...fixture.operational_snapshot.provenance, locator },
    });
    expect(() => parseFleetRecord(withLocator("https://user:FAKE-EXAMPLE@ml1/metrics")))
      .toThrow("provenance.locator cannot contain URL credentials");
    expect(() => parseFleetRecord(withLocator("http://ml1/metrics?api_key=FAKE-EXAMPLE")))
      .toThrow("provenance.locator cannot contain credential query parameters");
    expect(() => parseFleetRecord(withLocator("sessions/run-3.jsonl?access_token=FAKE-EXAMPLE")))
      .toThrow("provenance.locator cannot contain credential query parameters");
    for (const locator of [
      "//user:FAKE-EXAMPLE@ml1/metrics",
      "user:FAKE-EXAMPLE@ml1/metrics",
    ]) {
      expect(() => parseFleetRecord(withLocator(locator)))
        .toThrow("provenance.locator cannot contain URL credentials");
    }
    for (const locator of [
      "https://ml1/callback#access_token=FAKE-EXAMPLE",
      "http://ml1/metrics?apiKey=FAKE-EXAMPLE",
      "http://ml1/metrics?pwd=FAKE-EXAMPLE",
      "http://ml1/metrics?X-Amz-Signature=FAKE-EXAMPLE",
      "http://ml1/metrics?apitoken=FAKE-EXAMPLE",
      "http://ml1/metrics?sessionToken=FAKE-EXAMPLE",
      "http://ml1/metrics?privateKey=FAKE-EXAMPLE",
      "http://ml1/metrics?dbPassword=FAKE-EXAMPLE",
      "http://ml1/metrics?mysecret=FAKE-EXAMPLE",
      "http://ml1/metrics?window=5m;token=FAKE-EXAMPLE",
    ]) {
      expect(() => parseFleetRecord(withLocator(locator)))
        .toThrow("provenance.locator cannot contain credential query parameters");
    }
    for (const locator of [
      "http://ml1/metrics?window=5m",
      "http://ml1/metrics?max_tokens=4096&signal=1&author=a&design=b&monkey=c",
      "sessions/2026/09/22/run-3.jsonl#L10",
    ]) {
      expect(parseFleetRecord(withLocator(locator)).provenance.locator).toBe(locator);
    }
  });

  describe("provenance.locator credential names", () => {
    const withLocator = (locator: string) => ({
      ...fixture.operational_snapshot,
      provenance: { ...fixture.operational_snapshot.provenance, locator },
    });
    const rejected = "provenance.locator cannot contain credential query parameters";

    it.each([
      "http://ml1/metrics?token1=FAKE-EXAMPLE",
      "http://ml1/metrics?apikey2=FAKE-EXAMPLE",
      "http://ml1/metrics?tokenValue=FAKE-EXAMPLE",
      "http://ml1/metrics?apiKeyId=FAKE-EXAMPLE",
      "http://ml1/metrics?passwordHash=FAKE-EXAMPLE",
      "http://ml1/metrics?apikeys=FAKE-EXAMPLE",
      "http://ml1/metrics?passwords=FAKE-EXAMPLE",
      "http://ml1/metrics?secrets=FAKE-EXAMPLE",
      "http://ml1/metrics?privatekeypem=FAKE-EXAMPLE",
      "http://ml1/metrics?db_passphrase=FAKE-EXAMPLE",
      "http://ml1/metrics?awsaccesskey=FAKE-EXAMPLE",
      "http://ml1/metrics?usercredentials=FAKE-EXAMPLE",
      "http://ml1/metrics?apitoken_v2=FAKE-EXAMPLE",
      "http://ml1/metrics?cookie=FAKE-EXAMPLE",
      "http://ml1/metrics?tokenCountToken=FAKE-EXAMPLE",
      "http://ml1/metrics?count_token=FAKE-EXAMPLE",
      "http://ml1/metrics?tOKEN=FAKE-EXAMPLE",
      "http://ml1/metrics?pAssword=FAKE-EXAMPLE",
      "http://ml1/metrics?sEcReT=FAKE-EXAMPLE",
      "http://ml1/callback#a=1;sessiontoken=FAKE-EXAMPLE",
    ])("rejects compound or qualified name in %s", (locator) => {
      expect(() => parseFleetRecord(withLocator(locator))).toThrow(rejected);
    });

    it.each([
      "http://ml1/metrics;token=FAKE-EXAMPLE",
      "http://ml1/app;jsessionid=FAKE-EXAMPLE",
      "http://ml1/metrics/api_key=FAKE-EXAMPLE/data",
      "token=FAKE-EXAMPLE",
      "sessions/run-3.jsonl token=FAKE-EXAMPLE",
      "http://ml1/metrics?window=5m%3Btoken=FAKE-EXAMPLE",
      "http://ml1/metrics?window=5m%26token=FAKE-EXAMPLE",
      "http://ml1/metrics?next=%3Ftoken%3DFAKE-EXAMPLE",
      "http://ml1/metrics?%2574oken=FAKE-EXAMPLE",
      "http://ml1/metrics?window=5m,token=FAKE-EXAMPLE",
      "http://ml1/metrics?\uFF34\uFF2F\uFF2B\uFF25\uFF2E=FAKE-EXAMPLE",
      "http://ml1/metrics?tok\u200Ben=FAKE-EXAMPLE",
      "http://ml1/metrics?tok\u00ADen=FAKE-EXAMPLE",
      "http://ml1/metrics?t%00oken=FAKE-EXAMPLE",
    ])("rejects credential name outside the plain query in %s", (locator) => {
      expect(() => parseFleetRecord(withLocator(locator))).toThrow(rejected);
    });

    it.each([
      "https:/\\user:FAKE-EXAMPLE@ml1/metrics",
      " https://user:FAKE-EXAMPLE@ml1/metrics",
      "ht\ntps://user:FAKE-EXAMPLE@ml1/metrics",
      "https:/user:FAKE-EXAMPLE@ml1/metrics",
      "https:///user:FAKE-EXAMPLE@ml1/metrics",
      "https:\\\\\\user:FAKE-EXAMPLE@ml1/metrics",
      "\u200B//user:FAKE-EXAMPLE@ml1/metrics",
      "https:/ghp_FAKE-EXAMPLE@github.com/x",
    ])("rejects disguised URL credentials in %s", (locator) => {
      expect(() => parseFleetRecord(withLocator(locator)))
        .toThrow("provenance.locator cannot contain URL credentials");
    });

    it.each([
      "http://ml1/metrics?input_tokens=1&tokenizer=bpe&maxTokens=2&window=5m",
      "http://ml1/metrics?keyboard=us&sortkey=a&primarykey=b&secretary=c",
      "http://ml1/metrics?session_id=run-3&sessionId=run-4&keyword=k&authority=a",
      "http://ml1/metrics?model=qwen3.8:27b&q=100%",
      "http://ml1/metrics?tokenCount=1&token_limit=2&tokenBudget=3&token_usage=4&tokens_total=5",
      "http://ml1/metrics?token_type=input&tokenKind=output",
      "C:\\Users\\n\\sessions\\run-3.jsonl",
      "C:\\Users\\n@work\\sessions\\run-3.jsonl",
      "s3://bucket/date=2026-09-22/run-3.jsonl",
      "file:///home/n/sessions/run-3.jsonl#L10",
    ])("accepts ordinary telemetry locator %s", (locator) => {
      expect(parseFleetRecord(withLocator(locator)).provenance.locator).toBe(locator);
    });

    it.each([
      "http://ml1/metrics?window=5m+token=FAKE-EXAMPLE",
      "http://ml1/metrics?window=5m%2Btoken=FAKE-EXAMPLE",
      "http://ml1/metrics?window=5m:token=FAKE-EXAMPLE",
      "http://ml1/metrics?window=(token=FAKE-EXAMPLE)",
      "http://ml1/metrics?window=5m|token=FAKE-EXAMPLE",
      "http://ml1/metrics?a=1 token=FAKE-EXAMPLE",
      "http://ml1/metrics?token",
      "http://ml1/metrics?privkey=FAKE-EXAMPLE",
      "http://ml1/metrics?hmac=FAKE-EXAMPLE",
      "http://ml1/metrics?tok%E2%80%8Ben=FAKE-EXAMPLE&q=100%",
      "http://ml1/metrics?tok%C2%ADen=FAKE-EXAMPLE&q=100%",
      "http://ml1/metrics?q=100%&%74oken=FAKE-EXAMPLE",
      "http://ml1/metrics?%252574oken=FAKE-EXAMPLE",
      "http://ml1/metrics?%25252574oken=FAKE-EXAMPLE",
      "http://ml1/metrics?to\u0301ken=FAKE-EXAMPLE",
      "http://ml1/metrics?t%C3%B6ken=FAKE-EXAMPLE",
      "http://ml1/metrics?tok\u034Fen=FAKE-EXAMPLE",
    ])("rejects credential name disguised inside a value or by encoding in %s", (locator) => {
      expect(() => parseFleetRecord(withLocator(locator))).toThrow(rejected);
    });

    it.each([
      "http://ml1/metrics?cursor=abc==&q=a=b&filter=max_tokens>=5",
      "http://ml1/metrics?q=%E4%B8%AD%E6%96%87&note=caf%C3%A9&q=100%25",
    ])("accepts ordinary encoded telemetry locator %s", (locator) => {
      expect(parseFleetRecord(withLocator(locator)).provenance.locator).toBe(locator);
    });

    it("checks a long digit run in a name in linear time", () => {
      const locator = `http://ml1/metrics?a${"1".repeat(100_000)}x=1`;
      const started = performance.now();
      expect(parseFleetRecord(withLocator(locator)).provenance.locator).toBe(locator);
      expect(performance.now() - started).toBeLessThan(500);
    });
  });

  it("rejects unsupported and missing envelope fields, naming the offending keys", () => {
    const messageOf = (value: unknown): string => {
      try {
        parseFleetRecord(value);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected parseFleetRecord to throw");
    };
    expect(messageOf({ ...fixture.usage_event, cost_usd: 1 }))
      .toBe("usage event has unsupported or missing fields (unexpected: cost_usd)");
    const { model: _model, ...withoutModel } = fixture.usage_event;
    expect(messageOf(withoutModel))
      .toBe("usage event has unsupported or missing fields (missing: model)");
    expect(messageOf({
      ...fixture.usage_event,
      usage: { ...fixture.usage_event.usage, total_tokens: 144 },
    })).toBe("usage has unsupported or missing fields (unexpected: total_tokens)");
  });

  it("lists unexpected before missing keys, each sorted", () => {
    const { model: _model, usage: _usage, ...withoutTwo } = fixture.usage_event;
    expect(() => parseFleetRecord({ ...withoutTwo, zeta: 1, alpha: 2 })).toThrow(
      /^usage event has unsupported or missing fields \(unexpected: alpha, zeta; missing: model, usage\)$/,
    );
  });

  it("rejects empty, inverted, and future-ending snapshot windows", () => {
    const withWindow = (start: string, end: string) => ({
      ...fixture.operational_snapshot,
      window: { start, end },
    });
    const message = "snapshot window must be non-empty and end no later than timestamp";
    expect(() => parseFleetRecord(withWindow("2026-09-22T14:00:00.000Z", "2026-09-22T14:00:00.000Z")))
      .toThrow(message);
    expect(() => parseFleetRecord(withWindow("2026-09-22T14:01:00.000Z", "2026-09-22T14:00:00.000Z")))
      .toThrow(message);
    expect(() => parseFleetRecord(withWindow("2026-09-22T14:00:00.000Z", "2026-09-22T14:05:00.001Z")))
      .toThrow(message);
  });

  it("does not join an event outside the snapshot window or without a timestamp", () => {
    expect(joinUsageToSnapshots({ ...usage, timestamp: "2026-09-22T13:59:59.999Z" }, [snapshot]))
      .toEqual({ state: "unmatched", key: null, snapshot: null });
    expect(joinUsageToSnapshots({ ...usage, timestamp: null }, [snapshot]))
      .toEqual({ state: "unmatched", key: null, snapshot: null });
  });

  it("prefers request_id over run_id and never falls through an ambiguous level", () => {
    const byRequest = { ...snapshot, record_id: "olla:snapshot:req", request_id: "openai:req-7", run_id: null };
    expect(joinUsageToSnapshots(usage, [snapshot, byRequest])).toEqual({
      state: "matched",
      key: "request_id=openai:req-7",
      snapshot: byRequest,
    });
    const secondByRequest = { ...byRequest, record_id: "olla:snapshot:req-2" };
    expect(joinUsageToSnapshots(usage, [snapshot, byRequest, secondByRequest])).toEqual({
      state: "ambiguous",
      key: "request_id=openai:req-7",
      snapshot: null,
    });
  });

  it("reports unknown freshness for a missing threshold or a future snapshot", () => {
    expect(classifySnapshotFreshness({ ...snapshot, stale_after_ms: null }, "2026-09-22T14:05:30.000Z"))
      .toBe("unknown");
    expect(classifySnapshotFreshness(snapshot, "2026-09-22T14:04:59.999Z")).toBe("unknown");
    expect(() => classifySnapshotFreshness(snapshot, "not-a-time"))
      .toThrow("evaluatedAt must be an RFC 3339 UTC timestamp");
  });

  it("keeps counter deltas unavailable without process identity and prefers restart over reset", () => {
    const next = { ...snapshot, counters: { requests: 25, errors: null } };
    expect(snapshotCounterDelta(snapshot, { ...next, process_id: null }, "requests"))
      .toEqual({ state: "unavailable", value: null });
    expect(snapshotCounterDelta(
      snapshot,
      { ...next, process_id: "olla:ml1:pid-43", counters: { requests: 2 } },
      "requests",
    )).toEqual({ state: "restart", value: null });
  });
});

describe("shared label privacy check", () => {
  it("rejects GitHub fine-grained and GitLab personal token shapes", () => {
    for (const value of [
      "github_pat_FAKE_EXAMPLE_000000000000",
      "host-glpat-FAKE-EXAMPLE-0000000000000",
    ]) {
      expect(() => assertSafeLabelValue(value)).toThrow(PrivacyError);
    }
  });

  it("accepts ordinary qualified labels", () => {
    expect(() => assertSafeLabelValue("olla:auth-gw:40114")).not.toThrow();
  });
});
