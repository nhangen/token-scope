import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { codexEventsFromRollout } from "@/providers/codex";
import { geminiCliEventsFromTranscript } from "@/providers/gemini-cli";
import { opencodeEventsFromDb } from "@/providers/opencode";

const secret = `ghp_${"c".repeat(36)}`;

describe("credential-shaped provider ids mark the event partial", () => {
  it("codex session id", () => {
    const events = codexEventsFromRollout([
      JSON.stringify({ timestamp: "2026-09-22T14:02:10.000Z", type: "session_meta", payload: { id: secret, timestamp: "2026-09-22T14:02:10.000Z", model_provider: "openai" } }),
      JSON.stringify({ timestamp: "2026-09-22T14:02:20.000Z", type: "turn_context", payload: { model: "gpt-6-sol" } }),
      JSON.stringify({ timestamp: "2026-09-22T14:02:30.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 900, cached_input_tokens: 150, output_tokens: 70, reasoning_output_tokens: 40 } } } }),
    ].join("\n"), "rollout.jsonl");
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBeNull();
    expect(events[0]!.partial).toContain("privacy-redaction");
  });

  it("gemini-cli request id", () => {
    const { events } = geminiCliEventsFromTranscript([
      JSON.stringify({ sessionId: "gemini-session", projectHash: "p", startTime: "2026-09-22T14:02:00.000Z", kind: "main" }),
      JSON.stringify({ id: secret, timestamp: "2026-09-22T14:02:40.000Z", type: "gemini", model: "gemini-3-flash-preview", tokens: { input: 1000, output: 120, cached: 200, thoughts: 30, tool: 10, total: 1150 } }),
    ].join("\n"), "session.jsonl");
    expect(events).toHaveLength(1);
    expect(events[0]!.requestId).toBeNull();
    expect(events[0]!.partial).toContain("privacy-redaction");
  });

  it("opencode session id", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
    db.query("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("m1", secret, JSON.stringify({
      role: "assistant", modelID: "kimi-k3", providerID: "opencode", tokens: { input: 4, output: 1 },
      time: { created: Date.parse("2026-09-22T14:02:45.000Z") },
    }));
    const events = opencodeEventsFromDb(db);
    db.close();
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBeNull();
    expect(events[0]!.partial).toContain("privacy-redaction");
  });
});
