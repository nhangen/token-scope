import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  GEMINI_CLI_SOURCE_CONTRACT,
  UNSUPPORTED_GOOGLE_SURFACES,
  geminiCliEvents,
  geminiCliEventsFromTranscript,
} from "@/providers/gemini-cli";
import { collectProviderEvents } from "@/providers";
import { providerReportJson, providerRows, renderProviderReport } from "@/reports/providers";

const FX = join(import.meta.dir, "fixtures", "providers", "gemini-cli");

describe("Gemini CLI source contract", () => {
  it("names the tested local record, authentication boundary, and unsupported surfaces", () => {
    expect(GEMINI_CLI_SOURCE_CONTRACT).toEqual({
      surface: "gemini-cli-session-jsonl",
      testedVersion: "0.44.1",
      dataLocation: "~/.gemini/tmp/<project>/chats/**/*.jsonl",
      apiContract: "final type=gemini message per durable id; tokens.input is promptTokenCount, including cached and tool-use prompt tokens; normalized input is input minus cached",
      authenticationBoundary: "Gemini CLI owns authentication; TokenScope reads session JSONL only",
      access: "read-only",
    });
    expect(UNSUPPORTED_GOOGLE_SURFACES).toEqual([
      "google-ai-api",
      "vertex-ai",
    ]);
  });

  it("normalizes a successful record without inferring billing, cash, or quota", () => {
    const path = join(FX, "success", "tmp", "project-a", "chats", "session-success.jsonl");
    const parsed = geminiCliEventsFromTranscript(readFileSync(path, "utf8"), path);

    expect(parsed.errors).toBe(0);
    expect(parsed.partialRecords).toBe(0);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      harness: "gemini-cli",
      modelProvider: "google",
      model: "gemini-3-flash-preview",
      billingRoute: "unknown",
      inputTokens: 800,
      outputTokens: 120,
      cacheReadTokens: 200,
      cacheWriteTokens: null,
      reasoningTokens: 30,
      cashChargeUsd: null,
      status: "ok",
    });
  });

  it("replaces an earlier durable id with the later appended state", () => {
    const parsed = geminiCliEventsFromTranscript([
      JSON.stringify({ sessionId: "session-duplicate", messages: [] }),
      JSON.stringify({
        id: "response-duplicate",
        timestamp: "2026-09-23T10:01:00.000Z",
        type: "gemini",
        model: "gemini-earlier",
        tokens: { input: 111, output: 22, cached: 11, thoughts: 3 },
      }),
      JSON.stringify({
        id: "response-duplicate",
        timestamp: "2026-09-23T10:02:00.000Z",
        type: "gemini",
        model: "gemini-later",
        tokens: { input: 987, output: 65, cached: 123, thoughts: 9 },
      }),
    ].join("\n"), "duplicate.jsonl");

    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      eventId: "gemini-cli:response-duplicate",
      model: "gemini-later",
      inputTokens: 864,
      outputTokens: 65,
      cacheReadTokens: 123,
      reasoningTokens: 9,
    });
  });

  it("keeps responses a $set.messages snapshot drops from the live conversation", () => {
    const parsed = geminiCliEventsFromTranscript([
      JSON.stringify({
        sessionId: "session-set",
        messages: [{
          id: "response-from-session",
          timestamp: "2026-09-23T11:00:00.000Z",
          type: "gemini",
          model: "gemini-session",
          tokens: { input: 210, output: 21, cached: 10, thoughts: 2 },
        }],
      }),
      JSON.stringify({
        id: "response-before-set",
        timestamp: "2026-09-23T11:01:00.000Z",
        type: "gemini",
        model: "gemini-before-set",
        tokens: { input: 320, output: 32, cached: 20, thoughts: 3 },
      }),
      JSON.stringify({
        $set: {
          messages: [{
            id: "response-from-set",
            timestamp: "2026-09-23T11:02:00.000Z",
            type: "gemini",
            model: "gemini-set",
            tokens: { input: 765, output: 54, cached: 111, thoughts: 8 },
          }],
        },
      }),
    ].join("\n"), "set.jsonl");

    expect(parsed.errors).toBe(0);
    expect(parsed.events.map((event) => ({
      eventId: event.eventId,
      inputTokens: event.inputTokens,
    }))).toEqual([
      { eventId: "gemini-cli:response-from-session", inputTokens: 200 },
      { eventId: "gemini-cli:response-before-set", inputTokens: 300 },
      { eventId: "gemini-cli:response-from-set", inputTokens: 654 },
    ]);
  });

  it("keeps responses recorded before a later header that carries messages", () => {
    const parsed = geminiCliEventsFromTranscript([
      JSON.stringify({ sessionId: "session-resumed", messages: [] }),
      JSON.stringify({
        id: "response-before-header",
        timestamp: "2026-09-23T11:01:00.000Z",
        type: "gemini",
        model: "gemini-before-header",
        tokens: { input: 320, output: 32, cached: 20, thoughts: 3 },
      }),
      JSON.stringify({
        sessionId: "session-resumed",
        messages: [{
          id: "response-in-header",
          timestamp: "2026-09-23T11:02:00.000Z",
          type: "gemini",
          model: "gemini-in-header",
          tokens: { input: 110, output: 11, cached: 10, thoughts: 1 },
        }],
      }),
    ].join("\n"), "resumed.jsonl");

    expect(parsed.events.map((event) => [event.eventId, event.inputTokens])).toEqual([
      ["gemini-cli:response-before-header", 300],
      ["gemini-cli:response-in-header", 100],
    ]);
  });

  it("skips token-less gemini turns a snapshot rebuilds from history", () => {
    const parsed = geminiCliEventsFromTranscript([
      JSON.stringify({ sessionId: "session-compressed", messages: [] }),
      JSON.stringify({
        id: "response-billed",
        timestamp: "2026-09-23T11:01:00.000Z",
        type: "gemini",
        model: "gemini-billed",
        tokens: { input: 320, output: 32, cached: 20, thoughts: 3 },
      }),
      JSON.stringify({
        $set: {
          messages: [
            { id: "response-billed", type: "gemini", model: "gemini-billed" },
            { id: "synthetic-history-turn", type: "gemini", content: "compressed" },
          ],
        },
      }),
    ].join("\n"), "compressed.jsonl");

    expect(parsed.errors).toBe(0);
    expect(parsed.partialRecords).toBe(0);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      eventId: "gemini-cli:response-billed",
      inputTokens: 300,
      outputTokens: 32,
    });
  });

  it("keeps rewound responses because their tokens were already spent", () => {
    const parsed = geminiCliEventsFromTranscript([
      JSON.stringify({ sessionId: "session-known-rewind", messages: [] }),
      JSON.stringify({
        id: "response-kept",
        timestamp: "2026-09-23T12:00:00.000Z",
        type: "gemini",
        model: "gemini-kept",
        tokens: { input: 430, output: 43, cached: 30, thoughts: 4 },
      }),
      JSON.stringify({
        id: "response-rewind-target",
        timestamp: "2026-09-23T12:01:00.000Z",
        type: "gemini",
        model: "gemini-target",
        tokens: { input: 540, output: 54, cached: 40, thoughts: 5 },
      }),
      JSON.stringify({
        id: "response-after-target",
        timestamp: "2026-09-23T12:02:00.000Z",
        type: "gemini",
        model: "gemini-after-target",
        tokens: { input: 650, output: 65, cached: 50, thoughts: 6 },
      }),
      JSON.stringify({ $rewindTo: "response-rewind-target" }),
      JSON.stringify({
        id: "response-after-rewind",
        timestamp: "2026-09-23T12:03:00.000Z",
        type: "gemini",
        model: "gemini-after-rewind",
        tokens: { input: 876, output: 76, cached: 76, thoughts: 7 },
      }),
    ].join("\n"), "known-rewind.jsonl");

    expect(parsed.errors).toBe(0);
    expect(parsed.events.map((event) => ({
      eventId: event.eventId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
    }))).toEqual([
      { eventId: "gemini-cli:response-kept", inputTokens: 400, outputTokens: 43 },
      { eventId: "gemini-cli:response-rewind-target", inputTokens: 500, outputTokens: 54 },
      { eventId: "gemini-cli:response-after-target", inputTokens: 600, outputTokens: 65 },
      { eventId: "gemini-cli:response-after-rewind", inputTokens: 800, outputTokens: 76 },
    ]);
  });

  it("preserves null for token classes omitted by a partial record", () => {
    const result = geminiCliEvents(join(FX, "partial"));
    expect(result.source).toMatchObject({ state: "partial", reason: "partial_records" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      inputTokens: null,
      outputTokens: 40,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      cashChargeUsd: null,
    });
  });

  it("retains missing and null token records with null model and usage provenance", () => {
    const result = geminiCliEvents(join(FX, "missing-null"));

    expect(result.source).toMatchObject({ state: "partial", reason: "partial_records" });
    expect(result.skipped).toBe(0);
    expect(result.partialFiles).toBe(1);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      model: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    expect(result.events[1]).toMatchObject({
      model: "gemini-3-flash-preview",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      reasoningTokens: null,
    });

    const rows = providerRows({ events: result.events, unavailable: [], partial: {} });
    const missingModel = rows.find((row) => row.model === null);
    expect(missingModel).toBeDefined();
    expect(renderProviderReport(rows, [])).toContain("—");
  });

  it("keeps usage and flags the file when a rewind target is unknown", () => {
    const result = geminiCliEvents(join(FX, "rewind"));

    expect(result.source).toMatchObject({ state: "partial", reason: "malformed" });
    expect(result.events.map((event) => [event.eventId, event.inputTokens])).toEqual([
      ["gemini-cli:response-before-rewind", 900],
      ["gemini-cli:response-after-rewind", 300],
    ]);
  });

  it("counts id-less gemini records and non-object message entries as errors", () => {
    const parsed = geminiCliEventsFromTranscript([
      JSON.stringify({ sessionId: "session-idless", messages: ["junk", null] }),
      JSON.stringify({
        timestamp: "2026-09-23T11:01:00.000Z",
        type: "gemini",
        tokens: { input: 10, output: 1, cached: 0, thoughts: 0 },
      }),
      JSON.stringify({ $set: { messages: [{ type: "gemini", tokens: { input: 1 } }] } }),
    ].join("\n"), "idless.jsonl");

    expect(parsed.events).toEqual([]);
    expect(parsed.errors).toBe(4);
  });

  it("does not count user or info records as usage", () => {
    const parsed = geminiCliEventsFromTranscript([
      JSON.stringify({
        sessionId: "session-types",
        messages: [{ id: "user-from-header", type: "user", content: "sanitized" }],
      }),
      JSON.stringify({ id: "user-1", timestamp: "2026-09-23T11:00:00.000Z", type: "user", content: "sanitized" }),
      JSON.stringify({ id: "info-1", timestamp: "2026-09-23T11:00:01.000Z", type: "info", content: "sanitized" }),
      JSON.stringify({
        id: "response-1",
        timestamp: "2026-09-23T11:00:02.000Z",
        type: "gemini",
        model: "gemini-3-flash-preview",
        tokens: { input: 10, output: 1, cached: 0, thoughts: 0 },
      }),
    ].join("\n"), "types.jsonl");

    expect(parsed.errors).toBe(0);
    expect(parsed.partialRecords).toBe(0);
    expect(parsed.events.map((event) => event.eventId)).toEqual(["gemini-cli:response-1"]);
  });

  it("does not follow a chat-file symlink outside the Gemini root", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-symlink-"));
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      symlinkSync(join(FX, "privacy", "outside-session.jsonl"), join(chats, "escape.jsonl"));

      const result = geminiCliEvents(root);
      expect(result.events).toEqual([]);
      expect(result.source).toMatchObject({ state: "partial", reason: "unsafe_path" });
      expect(result.skipped).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink passed as the configured Gemini root", () => {
    const parent = mkdtempSync(join(tmpdir(), "token-scope-gemini-configured-root-"));
    const root = join(parent, "gemini-root");
    try {
      symlinkSync(join(FX, "success"), root);

      const result = geminiCliEvents(`${root}/`);
      expect(result.events).toEqual([]);
      expect(result.source).toMatchObject({ state: "unavailable", reason: "unsafe_path" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("treats a configured-root traversal error as unavailable", () => {
    const parent = mkdtempSync(join(tmpdir(), "token-scope-gemini-unreadable-root-"));
    const blocker = join(parent, "not-a-directory");
    const root = join(blocker, "gemini-root");
    try {
      writeFileSync(blocker, "regular file");

      let traversalError: unknown = null;
      try {
        lstatSync(root);
      } catch (error) {
        traversalError = error;
      }

      expect((traversalError as NodeJS.ErrnoException | null)?.code).toBe("ENOTDIR");
      const result = geminiCliEvents(root);
      expect(result.events).toEqual([]);
      expect(result.source).toMatchObject({ state: "unavailable", reason: "unreadable" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an intermediate chat-directory symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-intermediate-symlink-"));
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      symlinkSync(join(FX, "success", "tmp", "project-a", "chats"), join(chats, "imported"));

      const result = geminiCliEvents(root);
      expect(result.events).toEqual([]);
      expect(result.source).toMatchObject({ state: "partial", reason: "unsafe_path" });
      expect(result.skipped).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a tmp symlink whose resolved path escapes the Gemini root", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-root-symlink-"));
    try {
      symlinkSync(join(FX, "success", "tmp"), join(root, "tmp"));

      const result = geminiCliEvents(root);
      expect(result.events).toEqual([]);
      expect(result.source).toMatchObject({ state: "unavailable", reason: "unsafe_path" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips non-regular files without opening them", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-special-"));
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      const fifo = join(chats, "session-fifo.jsonl");
      const created = Bun.spawnSync(["mkfifo", fifo]);
      expect(created.exitCode).toBe(0);

      const result = geminiCliEvents(root);
      expect(result.events).toEqual([]);
      expect(result.source).toMatchObject({ state: "partial", reason: "unsafe_path" });
      expect(result.skipped).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips stale unreadable files before reading their contents", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-stale-unreadable-"));
    const file = join(root, "tmp", "project-a", "chats", "stale.jsonl");
    try {
      mkdirSync(join(root, "tmp", "project-a", "chats"), { recursive: true });
      writeFileSync(file, "private stale contents\n");
      const stale = new Date(Date.now() - 86_400_000);
      utimesSync(file, stale, stale);
      chmodSync(file, 0);

      const result = geminiCliEvents(root, Date.now() - 60_000);
      expect(result.events).toEqual([]);
      expect(result.source).toMatchObject({ state: "available", reason: null });
      expect(result.skipped).toBe(0);
      expect(result.affectedFiles).toBe(0);
    } finally {
      try {
        chmodSync(file, 0o600);
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts a malformed line and partial record in one file as one affected file", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-affected-file-"));
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      writeFileSync(join(chats, "mixed.jsonl"), [
        JSON.stringify({ sessionId: "session-mixed", messages: [] }),
        "not-json",
        JSON.stringify({ id: "response-partial", type: "gemini", tokens: null }),
      ].join("\n"));

      const collected = collectProviderEvents({
        claudeRoot: "/nonexistent",
        ledgerPath: "/nonexistent.jsonl",
        codexHome: "/nonexistent",
        opencodeDb: "/nonexistent.db",
        geminiRoot: root,
      });
      expect(collected.partial["gemini-cli"]).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the reason for a partial source: malformed line => malformed (#125)", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-reason-malformed-"));
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      writeFileSync(join(chats, "mixed.jsonl"), [
        JSON.stringify({ sessionId: "session-reason-malformed", messages: [] }),
        "not-json",
      ].join("\n"));

      const collected = collectProviderEvents({
        claudeRoot: "/nonexistent",
        ledgerPath: "/nonexistent.jsonl",
        codexHome: "/nonexistent",
        opencodeDb: "/nonexistent.db",
        geminiRoot: root,
      });
      expect(collected.partial["gemini-cli"]).toBe(1);
      expect(collected.partialReasons?.["gemini-cli"]).toEqual(["malformed"]);
      expect(geminiCliEvents(root).source.reason).toBe("malformed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("labels an unreadable file unreadable, not malformed (#125)", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-reason-unreadable-"));
    const file = join(root, "tmp", "project-a", "chats", "secret.jsonl");
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      writeFileSync(file, JSON.stringify({
        sessionId: "session-reason-unreadable",
        messages: [{
          id: "r1", type: "gemini", model: "gemini-3-flash-preview",
          tokens: { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 },
        }],
      }) + "\n");
      chmodSync(file, 0);

      // Bun on macOS fails realpath in the walk (unavailable); Linux fails
      // the read itself (partial). Both must name the same cause.
      const gemini = geminiCliEvents(root);
      expect(gemini.reasons).toEqual(["unreadable"]);
      expect(gemini.source.reason).toBe("unreadable");
    } finally {
      try { chmodSync(file, 0o600); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports reason codes in the text and JSON report (#125)", () => {
    const rows = providerRows({ events: [], unavailable: [], partial: {}, partialReasons: {} });
    const text = renderProviderReport(
      rows, [],
      { "gemini-cli": 2 },
      [],
      { "gemini-cli": ["unreadable", "malformed"] },
    );
    expect(text).toContain("gemini-cli: 2 affected file(s) [unreadable, malformed]");

    const json = providerReportJson(
      rows, [],
      { "gemini-cli": 2 },
      0, [],
      { "gemini-cli": ["unreadable", "malformed"] },
    );
    expect(json.partialReasons).toEqual({ "gemini-cli": ["unreadable", "malformed"] });
  });

  it("counts imported historical messages once by their durable message id", () => {
    const root = mkdtempSync(join(tmpdir(), "token-scope-gemini-imported-history-"));
    try {
      const chats = join(root, "tmp", "project-a", "chats");
      mkdirSync(chats, { recursive: true });
      const historical = {
        id: "durable-response-id",
        timestamp: "2026-09-23T10:01:00.000Z",
        type: "gemini",
        content: "sanitized",
        model: "gemini-3-flash-preview",
        tokens: { input: 100, output: 20, cached: 0, thoughts: 0, tool: 0, total: 120 },
      };
      writeFileSync(join(chats, "session-original.jsonl"), [
        JSON.stringify({ sessionId: "original-session", projectHash: "project-a" }),
        JSON.stringify(historical),
      ].join("\n"));
      writeFileSync(join(chats, "session-imported.jsonl"), [
        JSON.stringify({ sessionId: "imported-session", projectHash: "project-a" }),
        JSON.stringify(historical),
      ].join("\n"));

      const result = geminiCliEvents(root);
      expect(result.events).toHaveLength(1);
      expect(providerRows({ events: result.events, unavailable: [], partial: {} })[0]).toMatchObject({
        events: 1,
        input: 100,
        output: 20,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a semantically invalid record as a source error", () => {
    const result = geminiCliEvents(join(FX, "error"));
    expect(result.events).toEqual([]);
    expect(result.source).toMatchObject({ state: "partial", reason: "malformed" });
    expect(result.skipped).toBe(1);
  });

  it("surfaces an unreadable source location as unavailable", () => {
    const result = geminiCliEvents(join(FX, "unavailable"));
    expect(result.events).toEqual([]);
    expect(result.source).toMatchObject({ state: "unavailable", reason: "unreadable" });
  });

  it("adds Gemini without changing existing provider identities or accounting", () => {
    const collected = collectProviderEvents({
      claudeRoot: "/nonexistent",
      ledgerPath: "/nonexistent.jsonl",
      codexHome: "/nonexistent",
      opencodeDb: "/nonexistent.db",
      geminiRoot: join(FX, "success"),
    });
    const rows = providerRows(collected);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      harness: "gemini-cli",
      provider: "google",
      billingRoute: "unknown",
      model: "gemini-3-flash-preview",
      input: 800,
      output: 120,
      cacheRead: 200,
      cacheWrite: null,
      reasoning: 30,
      cashUsd: null,
    });
    expect(collected.unsupported).toEqual([...UNSUPPORTED_GOOGLE_SURFACES]);
    // The success fixture carries logs.json and checkpoints/ beside chats/,
    // as a real install does; they are not chat sources and not unsafe paths.
    expect(collected.partial["gemini-cli"]).toBeUndefined();
    expect(geminiCliEvents(join(FX, "success")).source).toMatchObject({ state: "available", reason: null });
  });
});

describe("Gemini CLI measurement completeness", () => {
  function report(root: string) {
    const collected = collectProviderEvents({
      claudeRoot: "/nonexistent",
      ledgerPath: "/nonexistent.jsonl",
      codexHome: "/nonexistent",
      opencodeDb: "/nonexistent.db",
      geminiRoot: root,
    });
    const rows = providerRows(collected);
    return {
      rows,
      json: providerReportJson(rows, collected.unavailable, collected.partial),
      text: renderProviderReport(rows, collected.unavailable, collected.partial),
    };
  }

  it("does not claim complete measurement for records missing token classes", () => {
    for (const fixture of ["partial", "missing-null"]) {
      const { rows, json, text } = report(join(FX, fixture));
      expect(json.measured).toBe(false);
      expect(rows.reduce((sum, row) => sum + row.partialEvents, 0)).toBeGreaterThan(0);
      expect(text).toContain("measurement incomplete");
      expect(text).not.toContain("all values measured from source records");
    }
  });

  it("still claims complete measurement for fully reported records", () => {
    expect(report(join(FX, "success")).json.measured).toBe(true);
  });

  it("marks model or timestamp gaps partial even when every token class is present", () => {
    const parsed = geminiCliEventsFromTranscript([
      JSON.stringify({ sessionId: "session-attribution", messages: [] }),
      JSON.stringify({
        id: "response-no-model",
        timestamp: "2026-09-23T10:01:00.000Z",
        type: "gemini",
        tokens: { input: 10, output: 2, cached: 0, thoughts: 0 },
      }),
      JSON.stringify({
        id: "response-no-timestamp",
        type: "gemini",
        model: "gemini-3-flash-preview",
        tokens: { input: 10, output: 2, cached: 0, thoughts: 0 },
      }),
    ].join("\n"), "attribution.jsonl");

    expect(parsed.events.map((event) => event.partial)).toEqual([
      ["response_attribution"],
      ["response_attribution"],
    ]);
  });

  it("marks only the token class a record leaves out", () => {
    const record = (id: string, tokens: Record<string, number>) => JSON.stringify({
      id,
      timestamp: "2026-09-23T10:01:00.000Z",
      type: "gemini",
      model: "gemini-3-flash-preview",
      tokens,
    });
    const parsed = geminiCliEventsFromTranscript([
      JSON.stringify({ sessionId: "session-classes", messages: [] }),
      record("missing-cached", { input: 5, output: 2, thoughts: 0 }),
      record("missing-output", { input: 5, cached: 0, thoughts: 0 }),
      record("missing-thoughts", { input: 5, cached: 0, output: 2 }),
    ].join("\n"), "classes.jsonl");

    expect(parsed.events.map((event) => [event.eventId, event.partial])).toEqual([
      ["gemini-cli:missing-cached", ["input_token_classes"]],
      ["gemini-cli:missing-output", ["output_token_classes"]],
      ["gemini-cli:missing-thoughts", ["output_token_classes"]],
    ]);
  });

  it("marks cached tokens above prompt tokens malformed instead of emitting negative input", () => {
    const parsed = geminiCliEventsFromTranscript([
      JSON.stringify({ sessionId: "session-contradiction", messages: [] }),
      JSON.stringify({
        id: "response-contradiction",
        timestamp: "2026-09-23T10:01:00.000Z",
        type: "gemini",
        model: "gemini-3-flash-preview",
        tokens: { input: 5, output: 2, cached: 9, thoughts: 0 },
      }),
    ].join("\n"), "contradiction.jsonl");

    expect(parsed.errors).toBe(1);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      inputTokens: null,
      cacheReadTokens: 9,
      malformed: ["input_token_classes"],
    });
    const rows = providerRows({ events: parsed.events, unavailable: [], partial: {} });
    expect(providerReportJson(rows, []).measured).toBe(false);
  });
});
