import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ollamaRouteEvents, readOllaRouteTelemetry } from "@/providers/ollama-route";

describe("ollama-route telemetry parsing and event filtering", () => {
  it("counts non-object JSON values as skippedLines", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-scope-route-non-object-"));
    try {
      const file = join(dir, "routing.jsonl");
      writeFileSync(file, [
        "42",
        "[1, 2]",
        '"hello"',
        "true",
        "null",
      ].join("\n") + "\n");

      const read = readOllaRouteTelemetry(file);
      expect(read.events).toHaveLength(0);
      expect(read.skippedLines).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts misspelled or unrecognized event values as skippedLines", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-scope-route-bad-event-"));
    try {
      const file = join(dir, "routing.jsonl");
      writeFileSync(file, [
        JSON.stringify({ event: "resullt", request_id: "r1" }),
        JSON.stringify({ event: 123, request_id: "r2" }),
        JSON.stringify({ request_id: "r3" }), // missing event
        JSON.stringify({ event: null, request_id: "r4" }),
      ].join("\n") + "\n");

      const read = readOllaRouteTelemetry(file);
      expect(read.events).toHaveLength(0);
      expect(read.skippedLines).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores decision events without incrementing skippedLines", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-scope-route-decision-"));
    try {
      const file = join(dir, "routing.jsonl");
      writeFileSync(file, JSON.stringify({
        schema_version: 1,
        timestamp: "2026-09-22T14:04:00.000Z",
        event: "decision",
        decision: "refuse",
        reason: "class_not_allowlisted",
        task_class: "authoring",
        label: "denied",
        request_id: "wrapper-92",
        provider: "olla",
        model: "local-coder",
      }) + "\n");

      const read = readOllaRouteTelemetry(file);
      expect(read.events).toHaveLength(0);
      expect(read.skippedLines).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves undated result events and does not filter them upstream", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-scope-route-undated-"));
    try {
      const file = join(dir, "routing.jsonl");
      const undatedRecord = {
        schema_version: 1,
        timestamp: null,
        event: "result",
        decision: "completed",
        request_id: "wrapper-99",
        olla_request_id: "gentle-undated-99",
        provider: "olla",
        model: "local-coder",
        prompt_tokens: 50,
        output_tokens: 25,
      };
      writeFileSync(file, JSON.stringify(undatedRecord) + "\n");

      const read = readOllaRouteTelemetry(file);
      expect(read.events).toHaveLength(1);
      expect(read.events[0]!.ts).toBeNull();
      expect(read.skippedLines).toBe(0);

      // ollamaRouteEvents should NOT filter out the undated event when sinceMs is passed
      const routeEvents = ollamaRouteEvents(file, Date.now() - 3600_000);
      expect(routeEvents.events).toHaveLength(1);
      expect(routeEvents.events[0]!.ts).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a record whose request_id has a lone surrogate instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-scope-route-surrogate-"));
    try {
      const file = join(dir, "routing.jsonl");
      writeFileSync(file, `{"schema_version":1,"event":"result","decision":"completed","timestamp":"2026-09-22T14:00:00.000Z","request_id":"a\\ud800b","provider":"olla","model":"local-coder","endpoint_served":"gpu-1","prompt_tokens":50,"output_tokens":25}\n`);

      const read = readOllaRouteTelemetry(file);
      expect(read.skippedLines).toBe(0);
      expect(read.events).toHaveLength(1);
      expect(read.events[0]!.requestId).toBeNull();
      expect(read.events[0]!.partial).toEqual(["incomplete_route_record"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
