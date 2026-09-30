import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { readCodexExperimentManifest } from "@/codex-experiments";
import { codexEvents, codexEventsFromRollout } from "@/providers/codex";
import { codexExperimentReport, renderCodexExperimentReport } from "@/reports/codex-experiments";

const ROOT = join(import.meta.dir, "..");
const FX = join(import.meta.dir, "fixtures", "providers");
const CODEX_HOME = join(FX, "codex-home");
const MANIFEST = join(FX, "codex-experiment-manifest.json");

describe("Codex root-task experiments", () => {
  it("filters each root to its transitive descendants and separates Astra", () => {
    const { events } = codexEvents(CODEX_HOME);
    const report = codexExperimentReport(events, readCodexExperimentManifest(MANIFEST));
    const sol = report.experiments.find((experiment) => experiment.strategy === "sol-main")!;
    const luna = report.experiments.find((experiment) => experiment.strategy === "luna-root-sol-fresh-implementer")!;

    expect(sol.events).toBe(3);
    expect(sol.primary).toHaveLength(1);
    expect(sol.astraEscalation).toHaveLength(1);
    expect(sol.primary[0]!.model).toBe("gpt-5.6-sol");
    expect(sol.primary[0]!.reasoningEffort).toBe("high");
    expect(sol.astraEscalation[0]!.model).toBe("gpt-6-astra");

    // root-luna, child-sol ("/root/implementer"), grandchild-astra, and
    // missing-agent-path (no agent_path, the shape most real children have).
    expect(luna.events).toBe(4);
    expect(luna.primary.map((row) => row.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(luna.astraEscalation.map((row) => row.model)).toEqual(["gpt-6-astra"]);
    expect(luna.models.reduce((sum, row) => sum + row.rawTokens.uncachedInput, 0)).toBe(95);
    expect(luna.models.reduce((sum, row) => sum + row.rawTokens.cacheReadInput, 0)).toBe(35);
    expect(luna.models.reduce((sum, row) => sum + row.rawTokens.cacheWriteInput, 0)).toBe(15);
    expect(luna.models.reduce((sum, row) => sum + row.rawTokens.visibleOutput, 0)).toBe(45);
    expect(luna.models.reduce((sum, row) => sum + row.rawTokens.reasoningOutput, 0)).toBe(11);
    expect(luna.models.some((row) => row.rawTokens.uncachedInput === 999)).toBe(false);
    expect(luna.models.some((row) => row.rawTokens.uncachedInput === 777)).toBe(false);
  });

  it("accepts the agent_path shapes Codex writes: absent, null, and /root/<name>", () => {
    const meta = (agentPath: unknown, depth = 1) => JSON.stringify({
      type: "session_meta",
      payload: {
        id: "child",
        source: { subagent: { thread_spawn: { parent_thread_id: "root", depth, ...(agentPath === undefined ? {} : { agent_path: agentPath }) } } },
      },
    });
    const usage = JSON.stringify({
      ordinal: 1,
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } } },
    });
    const thread = (agentPath: unknown, depth = 1) =>
      codexEventsFromRollout(`${meta(agentPath, depth)}\n${usage}`, "f.jsonl")[0]!.codexThread;
    expect(thread(undefined)).toEqual({ threadId: "child", role: "subagent", parentThreadId: "root", depth: 1, agentPath: "unknown" });
    expect(thread(null)).toEqual({ threadId: "child", role: "subagent", parentThreadId: "root", depth: 1, agentPath: "unknown" });
    expect(thread("/root/test_reviewer")).toEqual({ threadId: "child", role: "subagent", parentThreadId: "root", depth: 1, agentPath: ["test_reviewer"] });
    expect(thread("/root/a/b", 2)).toEqual({ threadId: "child", role: "subagent", parentThreadId: "root", depth: 2, agentPath: ["a", "b"] });
    expect(thread("/root/a/b", 1)?.role).toBe("unknown");
    expect(thread("/root/a/b", 1)?.claimedParentThreadId).toBe("root");
    expect(thread(42)?.role).toBe("unknown");
  });

  it("reports children that claim the root but fail ancestry validation", () => {
    const { events } = codexEvents(CODEX_HOME);
    const report = codexExperimentReport(events, readCodexExperimentManifest(MANIFEST));
    const luna = report.experiments.find((experiment) => experiment.rootThreadId === "root-luna")!;
    const sol = report.experiments.find((experiment) => experiment.rootThreadId === "root-sol")!;
    // bad-agent-path (path contradicts depth) and bad-depth (depth 2 under the root).
    expect(luna.excludedDescendantEvents).toBe(2);
    expect(luna.integrity).toBe("inconsistent-descendants");
    expect(sol.excludedDescendantEvents).toBe(0);
    expect(sol.integrity).toBe("ok");
    expect(report.complete).toBe(false);
    expect(renderCodexExperimentReport(report)).toContain("excluded: 2 event(s)");
  });

  it("keeps malformed ancestry unknown and unattached", () => {
    const { events } = codexEvents(CODEX_HOME);
    const unknown = events.find((event) => event.codexThread?.threadId === "unknown-child")!;
    expect(unknown.codexThread).toEqual({
      threadId: "unknown-child",
      role: "unknown",
      parentThreadId: "unknown",
      depth: "unknown",
      agentPath: "unknown",
    });
    const report = codexExperimentReport(events, readCodexExperimentManifest(MANIFEST));
    const inconsistent = events.find((event) => event.codexThread?.threadId === "bad-agent-path")!;
    expect(inconsistent.codexThread?.role).toBe("unknown");
    expect(inconsistent.codexThread?.claimedParentThreadId).toBe("root-luna");
    // bad-depth parses as a subagent; the report rejects it because depth 2
    // under a depth-0 parent is inconsistent.
    const badDepth = events.find((event) => event.codexThread?.threadId === "bad-depth")!;
    expect(badDepth.codexThread?.role).toBe("subagent");
    const luna = report.experiments.find((experiment) => experiment.rootThreadId === "root-luna")!;
    expect(luna.models.some((row) => row.rawTokens.uncachedInput === 555)).toBe(false);
    expect(luna.models.some((row) => row.rawTokens.uncachedInput === 666)).toBe(false);
    const emptySource = events.find((event) => event.codexThread?.threadId === "empty-source")!;
    expect(emptySource.codexThread).toEqual({
      threadId: "empty-source",
      role: "unknown",
      parentThreadId: "unknown",
      depth: "unknown",
      agentPath: "unknown",
    });
    expect(luna.events).toBe(4);
  });

  it("marks selected malformed, partial, and legacy observations incomplete", () => {
    const provenance = join(FX, "codex-integrity-rollout.jsonl");
    const events = codexEventsFromRollout(readFileSync(provenance, "utf8"), provenance);
    const manifest = readCodexExperimentManifest(MANIFEST);
    manifest.experiments = { "integrity-root": manifest.experiments["root-sol"]! };
    const report = codexExperimentReport(events, manifest);
    const experiment = report.experiments[0]!;
    expect(report.complete).toBe(false);
    expect(experiment.integrity).toBe("incomplete-events");
    expect(experiment.events).toBe(3);
    expect(experiment.models.reduce((sum, model) => sum + model.legacyCumulativeEvents, 0)).toBe(1);
    expect(experiment.models.reduce((sum, model) => sum + model.partialEvents, 0)).toBeGreaterThan(0);
    expect(experiment.models.reduce((sum, model) => sum + model.malformedEvents, 0)).toBe(1);
    const text = renderCodexExperimentReport(report);
    expect(text).toContain("integrity=incomplete-events");
    expect(text).toContain("legacy-aggregate=1");
    expect(text).toContain("malformed=1");
    expect(text).toContain("observations");
    expect(text).not.toContain(" responses;");
    expect(experiment.models.every((model) => model.derivedNormalizedTokens === null)).toBe(true);
  });

  it("persists protocol, outcomes, meter snapshots, and separately labeled derived weights", () => {
    const report = codexExperimentReport(codexEvents(CODEX_HOME).events, readCodexExperimentManifest(MANIFEST));
    const sol = report.experiments.find((experiment) => experiment.strategy === "sol-main")!;
    const luna = report.experiments.find((experiment) => experiment.strategy === "luna-root-sol-fresh-implementer")!;
    expect(report.normalization.version).toBe("codex-normalized-v1");
    expect(report.normalization.derived).toBe(true);
    expect(report.normalization.measuredSubscriptionQuota).toBe(false);
    expect(sol.officialAccountMeterDelta).toBe(1);
    expect(sol.officialAccountMeterConsumption).toBe(1);
    expect(sol.officialAccountMeter?.direction).toBe("used");
    expect(sol.acceptanceResult).toBe("passed");
    expect(sol.elapsedSeconds).toBe(120);
    expect(sol.humanReworkMinutes).toBe(2);
    expect(luna.protocol).toEqual({
      freshContext: true,
      forkTurns: "none",
      acceptanceTest: "bun test tests/codex-experiments.test.ts",
    });
    expect(luna.officialAccountMeterDelta).toBeNull();
    const text = renderCodexExperimentReport(report);
    expect(text).toContain("Astra escalation");
    expect(text).toContain("raw uncached=");
    expect(text).toContain("derived, not measured subscription quota");
    expect(text).toContain("no measured quota-savings claim");
    expect(text).toContain("percent used");
  });

  it("excludes event ids recorded in the persisted baseline", () => {
    const { events } = codexEvents(CODEX_HOME);
    const manifest = readCodexExperimentManifest(MANIFEST);
    const first = events.find((event) => event.codexThread?.threadId === "root-sol")!;
    manifest.experiments["root-sol"]!.baselineEventIds = [first.eventId];
    const report = codexExperimentReport(events, manifest);
    expect(report.experiments.find((experiment) => experiment.rootThreadId === "root-sol")!.events).toBe(2);
  });

  it("flags a manifest root that is absent from the rollout set", () => {
    const manifest = readCodexExperimentManifest(MANIFEST);
    manifest.experiments["missing-root"] = {
      strategy: "missing",
      protocol: { freshContext: false, forkTurns: "none", acceptanceTest: "fixture" },
      elapsedSeconds: 1,
      humanReworkMinutes: 0,
    };
    const report = codexExperimentReport(codexEvents(CODEX_HOME).events, manifest);
    const missing = report.experiments.find((experiment) => experiment.rootThreadId === "missing-root")!;
    expect(report.complete).toBe(false);
    expect(missing.integrity).toBe("missing-root");
    expect(renderCodexExperimentReport(report)).toContain("integrity=missing-root");
  });

  it("rejects reversed or invalid official meter timestamps", () => {
    const invalid = join(FX, "codex-experiment-manifest-invalid-meter.json");
    expect(() => readCodexExperimentManifest(invalid)).toThrow("after.capturedAt must be later than before.capturedAt");
  });
});

describe("--codex-experiment production CLI path", () => {
  it("renders the persisted comparison as JSON", () => {
    const proc = Bun.spawnSync([
      "bun", join(ROOT, "src", "cli.ts"), "--codex-experiment", MANIFEST, "--json",
    ], {
      cwd: ROOT,
      env: { ...process.env, TOKEN_SCOPE_CODEX_HOME: CODEX_HOME },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const parsed = JSON.parse(proc.stdout.toString());
    expect(parsed.complete).toBe(false);
    expect(parsed.experiments[0].integrity).toBe("ok");
    expect(parsed.experiments[1].integrity).toBe("inconsistent-descendants");
    expect(parsed.experiments[1].excludedDescendantEvents).toBe(2);
    expect(parsed.experiments.map((experiment: any) => experiment.strategy)).toEqual([
      "sol-main",
      "luna-root-sol-fresh-implementer",
    ]);
    expect(parsed.experiments[1].astraEscalation).toHaveLength(1);
    expect(parsed.experiments[0].officialAccountMeter.direction).toBe("used");
  });
});
