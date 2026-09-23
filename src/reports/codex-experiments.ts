import type { CodexExperimentManifest } from "@/codex-experiments";
import type { ProviderEvent } from "@/providers";

interface RawTokens {
  uncachedInput: number;
  cacheReadInput: number;
  cacheWriteInput: number;
  visibleOutput: number;
  reasoningOutput: number;
}

interface ModelResult {
  model: string;
  reasoningEffort: string;
  astraEscalation: boolean;
  events: number;
  rawTokens: RawTokens;
  partialClasses: string[];
  malformedEvents: number;
  partialEvents: number;
  legacyCumulativeEvents: number;
  complete: boolean;
  derivedNormalizedTokens: number | null;
}

export interface CodexExperimentResult {
  rootThreadId: string;
  strategy: string;
  protocol: CodexExperimentManifest["experiments"][string]["protocol"];
  acceptanceResult: string | null;
  elapsedSeconds: number;
  humanReworkMinutes: number;
  officialAccountMeter: CodexExperimentManifest["experiments"][string]["officialAccountMeter"] | null;
  officialAccountMeterDelta: number | null;
  officialAccountMeterConsumption: number | null;
  integrity: "ok" | "missing-root" | "incomplete-events";
  events: number;
  models: ModelResult[];
  primary: ModelResult[];
  astraEscalation: ModelResult[];
}

export interface CodexExperimentReport {
  report: "codex-experiments";
  manifestVersion: 1;
  normalization: CodexExperimentManifest["normalization"] & {
    derived: true;
    measuredSubscriptionQuota: false;
  };
  complete: boolean;
  experiments: CodexExperimentResult[];
}

function eventsForRoot(events: ProviderEvent[], rootThreadId: string): {
  foundRoot: boolean;
  events: ProviderEvent[];
} {
  const known = events.filter((event) => event.harness === "codex"
    && event.codexThread?.threadId !== "unknown"
    && event.codexThread?.role !== "unknown");
  const rootExists = known.some((event) => event.codexThread?.threadId === rootThreadId
    && event.codexThread.role === "root");
  if (!rootExists) return { foundRoot: false, events: [] };

  const selectedThreads = new Map([[rootThreadId, 0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of known) {
      const thread = event.codexThread!;
      if (thread.role !== "subagent" || typeof thread.parentThreadId !== "string"
        || typeof thread.depth !== "number" || thread.parentThreadId === "unknown"
        || selectedThreads.has(thread.threadId)
        || !selectedThreads.has(thread.parentThreadId)) continue;
      if (thread.depth !== selectedThreads.get(thread.parentThreadId)! + 1) continue;
      selectedThreads.set(thread.threadId, thread.depth);
      changed = true;
    }
  }
  return {
    foundRoot: true,
    events: known.filter((event) => selectedThreads.has(event.codexThread!.threadId)),
  };
}

function sumClass(events: ProviderEvent[], key: keyof Pick<ProviderEvent,
  "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens" | "reasoningTokens">,
): { value: number; complete: boolean } {
  let value = 0;
  let complete = true;
  for (const event of events) {
    const tokens = event[key];
    if (tokens === null) complete = false;
    else value += tokens;
  }
  return { value, complete };
}

function modelResult(
  events: ProviderEvent[],
  weights: CodexExperimentManifest["normalization"]["weights"],
): ModelResult {
  const classes = {
    uncachedInput: sumClass(events, "inputTokens"),
    cacheReadInput: sumClass(events, "cacheReadTokens"),
    cacheWriteInput: sumClass(events, "cacheWriteTokens"),
    visibleOutput: sumClass(events, "outputTokens"),
    reasoningOutput: sumClass(events, "reasoningTokens"),
  };
  const rawTokens = Object.fromEntries(
    Object.entries(classes).map(([key, result]) => [key, result.value]),
  ) as unknown as RawTokens;
  const partialClasses = Object.entries(classes)
    .filter(([, result]) => !result.complete)
    .map(([key]) => key);
  const malformedEvents = events.filter((event) => (event.malformed?.length ?? 0) > 0).length;
  const partialEvents = events.filter((event) => (event.partial?.length ?? 0) > 0).length;
  const legacyCumulativeEvents = events.filter((event) => event.usageSource === "legacy-cumulative").length;
  const complete = partialClasses.length === 0
    && malformedEvents === 0
    && partialEvents === 0
    && legacyCumulativeEvents === 0;
  return {
    model: events[0]!.model,
    reasoningEffort: events[0]!.reasoningEffort ?? "unknown",
    astraEscalation: events[0]!.model.toLowerCase().includes("astra"),
    events: events.length,
    rawTokens,
    partialClasses,
    malformedEvents,
    partialEvents,
    legacyCumulativeEvents,
    complete,
    derivedNormalizedTokens: !complete
      ? null
      : rawTokens.uncachedInput * weights.uncachedInput
      + rawTokens.cacheReadInput * weights.cacheReadInput
      + rawTokens.cacheWriteInput * weights.cacheWriteInput
      + rawTokens.visibleOutput * weights.visibleOutput
      + rawTokens.reasoningOutput * weights.reasoningOutput,
  };
}

export function codexExperimentReport(
  allEvents: ProviderEvent[],
  manifest: CodexExperimentManifest,
): CodexExperimentReport {
  const experiments = Object.entries(manifest.experiments).map(([rootThreadId, experiment]) => {
    const baseline = new Set(experiment.baselineEventIds ?? []);
    const selected = eventsForRoot(allEvents, rootThreadId);
    const events = selected.events
      .filter((event) => !baseline.has(event.eventId));
    const groups = new Map<string, ProviderEvent[]>();
    for (const event of events) {
      const key = `${event.model}\u0000${event.reasoningEffort ?? "unknown"}`;
      const group = groups.get(key) ?? [];
      group.push(event);
      groups.set(key, group);
    }
    const models = [...groups.values()]
      .map((group) => modelResult(group, manifest.normalization.weights))
      .sort((a, b) => a.model.localeCompare(b.model)
        || a.reasoningEffort.localeCompare(b.reasoningEffort));
    const meter = experiment.officialAccountMeter ?? null;
    const meterDelta = meter ? meter.after.value - meter.before.value : null;
    const incompleteEvents = models.some((model) => !model.complete);
    return {
      rootThreadId,
      strategy: experiment.strategy,
      protocol: experiment.protocol,
      acceptanceResult: experiment.acceptanceResult ?? null,
      elapsedSeconds: experiment.elapsedSeconds,
      humanReworkMinutes: experiment.humanReworkMinutes,
      officialAccountMeter: meter,
      officialAccountMeterDelta: meterDelta,
      officialAccountMeterConsumption: meterDelta === null
        ? null : meter!.direction === "used" ? meterDelta : -meterDelta,
      integrity: !selected.foundRoot
        ? "missing-root" as const
        : incompleteEvents ? "incomplete-events" as const : "ok" as const,
      events: events.length,
      models,
      primary: models.filter((row) => !row.astraEscalation),
      astraEscalation: models.filter((row) => row.astraEscalation),
    };
  });
  return {
    report: "codex-experiments",
    manifestVersion: manifest.version,
    normalization: {
      ...manifest.normalization,
      derived: true,
      measuredSubscriptionQuota: false,
    },
    complete: experiments.every((experiment) => experiment.integrity === "ok"),
    experiments,
  };
}

export function renderCodexExperimentReport(report: CodexExperimentReport): string {
  const lines = [
    "Codex root-task experiments",
    `normalized weights: ${report.normalization.version} (derived, not measured subscription quota)`,
  ];
  for (const experiment of report.experiments) {
    lines.push("", `${experiment.strategy}  root ${experiment.rootThreadId}`);
    lines.push(`protocol: fresh_context=${experiment.protocol.freshContext} fork_turns=${experiment.protocol.forkTurns} acceptance_test=${experiment.protocol.acceptanceTest}`);
    lines.push(`acceptance=${experiment.acceptanceResult ?? "not recorded"} elapsed=${experiment.elapsedSeconds}s human_rework=${experiment.humanReworkMinutes}m`);
    if (experiment.integrity !== "ok") lines.push(`integrity=${experiment.integrity}`);
    for (const model of experiment.primary) {
      lines.push(modelSummary(model));
    }
    for (const model of experiment.astraEscalation) {
      lines.push(`Astra escalation: ${modelSummary(model)}`);
    }
    if (experiment.officialAccountMeter && experiment.officialAccountMeterDelta !== null) {
      const meter = experiment.officialAccountMeter;
      lines.push(`official account-meter delta: ${experiment.officialAccountMeterDelta} ${meter.unit} ${meter.direction} (after minus before); direction-normalized consumption: ${experiment.officialAccountMeterConsumption} ${meter.unit}`);
    } else {
      lines.push("official account-meter delta: not recorded; no measured quota-savings claim");
    }
  }
  return lines.join("\n");
}

function modelSummary(model: ModelResult): string {
  const countLabel = model.complete ? "responses" : "observations";
  const integrity = model.complete ? "" : `; incomplete: malformed=${model.malformedEvents} partial=${model.partialEvents} legacy-aggregate=${model.legacyCumulativeEvents} unknown-classes=${model.partialClasses.join(",") || "none"}`;
  return `${model.model} (${model.reasoningEffort}): ${model.events} ${countLabel}; raw ${rawSummary(model.rawTokens, model.partialClasses)}; ${model.derivedNormalizedTokens ?? "unknown"} derived normalized tokens${integrity}`;
}

function rawSummary(raw: RawTokens, partialClasses: string[]): string {
  const value = (key: keyof RawTokens, label: string) => partialClasses.includes(key)
    ? `${label}=unknown (known subtotal ${raw[key]})`
    : `${label}=${raw[key]}`;
  return [
    value("uncachedInput", "uncached"),
    value("cacheReadInput", "cache-read"),
    value("cacheWriteInput", "cache-write"),
    value("visibleOutput", "visible-output"),
    value("reasoningOutput", "reasoning"),
  ].join(" ");
}
