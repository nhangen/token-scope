import { readFileSync } from "fs";

export interface CodexExperimentManifest {
  version: 1;
  normalization: {
    version: string;
    weights: {
      uncachedInput: number;
      cacheReadInput: number;
      cacheWriteInput: number;
      visibleOutput: number;
      reasoningOutput: number;
    };
  };
  experiments: Record<string, {
    strategy: string;
    protocol: {
      freshContext: boolean;
      forkTurns: string;
      acceptanceTest: string;
    };
    acceptanceResult?: string;
    elapsedSeconds: number;
    humanReworkMinutes: number;
    baselineEventIds?: string[];
    officialAccountMeter?: {
      unit: string;
      direction: "used" | "remaining";
      before: { value: number; capturedAt: string };
      after: { value: number; capturedAt: string };
    };
  }>;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function readCodexExperimentManifest(path: string): CodexExperimentManifest {
  const raw = JSON.parse(readFileSync(path, "utf8")) as any;
  if (raw?.version !== 1 || typeof raw?.normalization?.version !== "string"
    || !raw?.normalization?.weights || !raw?.experiments
    || typeof raw.experiments !== "object" || Array.isArray(raw.experiments)) {
    throw new Error("Codex experiment manifest must use version 1 with normalization and experiments.");
  }
  const weights = raw.normalization.weights;
  for (const key of ["uncachedInput", "cacheReadInput", "cacheWriteInput", "visibleOutput", "reasoningOutput"]) {
    if (!finiteNonnegative(weights[key])) {
      throw new Error(`Codex experiment normalization weight ${key} must be non-negative.`);
    }
  }
  for (const [rootThreadId, experiment] of Object.entries<any>(raw.experiments)) {
    if (!rootThreadId || typeof experiment?.strategy !== "string"
      || typeof experiment?.protocol?.freshContext !== "boolean"
      || typeof experiment?.protocol?.forkTurns !== "string"
      || typeof experiment?.protocol?.acceptanceTest !== "string"
      || !finiteNonnegative(experiment?.elapsedSeconds)
      || !finiteNonnegative(experiment?.humanReworkMinutes)
      || (experiment?.acceptanceResult !== undefined && typeof experiment.acceptanceResult !== "string")
      || (experiment?.baselineEventIds !== undefined
        && (!Array.isArray(experiment.baselineEventIds)
          || !experiment.baselineEventIds.every((id: unknown) => typeof id === "string")))) {
      throw new Error(`Invalid Codex experiment entry for root thread ${rootThreadId}.`);
    }
    const meter = experiment.officialAccountMeter;
    if (meter !== undefined && (typeof meter?.unit !== "string" || !meter.unit.trim()
      || (meter?.direction !== "used" && meter?.direction !== "remaining")
      || !finiteNonnegative(meter?.before?.value)
      || typeof meter?.before?.capturedAt !== "string"
      || !finiteNonnegative(meter?.after?.value)
      || typeof meter?.after?.capturedAt !== "string")) {
      throw new Error(`Invalid official account meter for root thread ${rootThreadId}.`);
    }
    if (meter !== undefined) {
      const beforeMs = Date.parse(meter.before.capturedAt);
      const afterMs = Date.parse(meter.after.capturedAt);
      if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs)) {
        throw new Error(`Official account meter timestamps must be valid for root thread ${rootThreadId}.`);
      }
      if (afterMs <= beforeMs) {
        throw new Error(`Official account meter after.capturedAt must be later than before.capturedAt for root thread ${rootThreadId}.`);
      }
    }
  }
  return raw as CodexExperimentManifest;
}
