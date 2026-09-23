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

    expect(luna.events).toBe(3);
    expect(luna.primary.map((row) => row.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(luna.astraEscalation.map((row) => row.model)).toEqual(["gpt-6-astra"]);
    expect(luna.models.reduce((sum, row) => sum + row.rawTokens.uncachedInput, 0)).toBe(85);
    expect(luna.models.reduce((sum, row) => sum + row.rawTokens.cacheReadInput, 0)).toBe(35);
    expect(luna.models.reduce((sum, row) => sum + row.rawTokens.cacheWriteInput, 0)).toBe(15);
    expect(luna.models.reduce((sum, row) => sum + row.rawTokens.visibleOutput, 0)).toBe(41);
    expect(luna.models.reduce((sum, row) => sum + row.rawTokens.reasoningOutput, 0)).toBe(11);
    expect(luna.models.some((row) => row.rawTokens.uncachedInput === 999)).toBe(false);
    expect(luna.models.some((row) => row.rawTokens.uncachedInput === 777)).toBe(false);
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
    expect(report.experiments.every((experiment) => experiment.events < 4)).toBe(true);
    const inconsistent = events.find((event) => event.codexThread?.threadId === "bad-agent-path")!;
    expect(inconsistent.codexThread?.role).toBe("unknown");
    const badDepth = events.find((event) => event.codexThread?.threadId === "bad-depth")!;
    expect(badDepth.codexThread?.role).toBe("subagent");
    const missingPath = events.find((event) => event.codexThread?.threadId === "missing-agent-path")!;
    expect(missingPath.codexThread).toEqual({
      threadId: "missing-agent-path",
      role: "unknown",
      parentThreadId: "unknown",
      depth: "unknown",
      agentPath: "unknown",
    });
    const emptySource = events.find((event) => event.codexThread?.threadId === "empty-source")!;
    expect(emptySource.codexThread).toEqual({
      threadId: "empty-source",
      role: "unknown",
      parentThreadId: "unknown",
      depth: "unknown",
      agentPath: "unknown",
    });
    expect(report.experiments.find((experiment) => experiment.rootThreadId === "root-luna")!.events).toBe(3);
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
    expect(parsed.complete).toBe(true);
    expect(parsed.experiments.map((experiment: any) => experiment.strategy)).toEqual([
      "sol-main",
      "luna-root-sol-fresh-implementer",
    ]);
    expect(parsed.experiments[1].astraEscalation).toHaveLength(1);
    expect(parsed.experiments[0].officialAccountMeter.direction).toBe("used");
  });
});
