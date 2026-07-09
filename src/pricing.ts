export interface ModelPricing {
  inputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
  outputPerMillion: number;
}

// Prices are per million tokens (USD), standard first-party global rates.
// Source: https://platform.claude.com/docs/en/docs/about-claude/pricing (as of 2026-07-08).
// Cache-write = 5-minute write (1.25x input); cache-read = 0.1x input.
// Caveats: Sonnet 5 is at introductory pricing through 2026-08-31 (2/10), rising
// to 3/15 on 2026-09-01. Fast-mode and data-residency (1.1x) premiums are NOT
// modeled — usage alone can't distinguish them, so standard rates are assumed.
const PRICING: Record<string, ModelPricing> = {
  // Current generation (Opus 4.5–4.8 all share one price tier).
  "claude-opus-4-8":            { inputPerMillion:  5.00, cacheWritePerMillion:  6.25, cacheReadPerMillion: 0.50,  outputPerMillion: 25.00 },
  "claude-opus-4-7":            { inputPerMillion:  5.00, cacheWritePerMillion:  6.25, cacheReadPerMillion: 0.50,  outputPerMillion: 25.00 },
  "claude-opus-4-6":            { inputPerMillion:  5.00, cacheWritePerMillion:  6.25, cacheReadPerMillion: 0.50,  outputPerMillion: 25.00 },
  "claude-opus-4-5":            { inputPerMillion:  5.00, cacheWritePerMillion:  6.25, cacheReadPerMillion: 0.50,  outputPerMillion: 25.00 },
  "claude-sonnet-5":            { inputPerMillion:  2.00, cacheWritePerMillion:  2.50, cacheReadPerMillion: 0.20,  outputPerMillion: 10.00 },
  "claude-sonnet-4-6":          { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
  "claude-fable-5":             { inputPerMillion: 10.00, cacheWritePerMillion: 12.50, cacheReadPerMillion: 1.00,  outputPerMillion: 50.00 },
  "claude-mythos-5":            { inputPerMillion: 10.00, cacheWritePerMillion: 12.50, cacheReadPerMillion: 1.00,  outputPerMillion: 50.00 },
  "claude-haiku-4-5-20251001":  { inputPerMillion:  1.00, cacheWritePerMillion:  1.25, cacheReadPerMillion: 0.10,  outputPerMillion:  5.00 },
  "claude-haiku-4-5":           { inputPerMillion:  1.00, cacheWritePerMillion:  1.25, cacheReadPerMillion: 0.10,  outputPerMillion:  5.00 },
  // Older / deprecated (retain their original pricing).
  "claude-3-7-sonnet-20250219": { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
  "claude-3-5-haiku-20241022":  { inputPerMillion:  0.80, cacheWritePerMillion:  1.00, cacheReadPerMillion: 0.08,  outputPerMillion:  4.00 },
  "claude-3-5-sonnet-20241022": { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
  "claude-3-opus-20240229":     { inputPerMillion: 15.00, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50,  outputPerMillion: 75.00 },
  "claude-sonnet-4-5-20250929": { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
  "claude-opus-4-1-20250805":   { inputPerMillion: 15.00, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50,  outputPerMillion: 75.00 },
  "claude-sonnet-4-20250514":   { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
};

let overrideMap: Record<string, ModelPricing> | null = null;

function loadPricingMap(): Record<string, ModelPricing> {
  if (overrideMap !== null) return overrideMap;
  const overridePath = process.env["TOKEN_SCOPE_PRICING_FILE"];
  if (overridePath) {
    try {
      const fs = require("fs") as typeof import("fs");
      const raw = fs.readFileSync(overridePath, "utf8") as string;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const valid = Object.values(parsed).every(
        (v) => v !== null && typeof v === "object" &&
          typeof (v as Record<string, unknown>)["inputPerMillion"] === "number" &&
          typeof (v as Record<string, unknown>)["outputPerMillion"] === "number" &&
          typeof (v as Record<string, unknown>)["cacheReadPerMillion"] === "number" &&
          typeof (v as Record<string, unknown>)["cacheWritePerMillion"] === "number",
      );
      if (!valid) throw new Error("entries missing required numeric pricing fields");
      overrideMap = parsed as Record<string, ModelPricing>;
      return overrideMap;
    } catch (e) {
      process.stderr.write(`Warning: Could not load TOKEN_SCOPE_PRICING_FILE at "${overridePath}": ${String(e)}\n`);
    }
  }
  overrideMap = PRICING;
  return PRICING;
}

/** Returns pricing for a model, or null if the model is not in the map. */
export function getPricing(model: string): ModelPricing | null {
  return loadPricingMap()[model] ?? null;
}

/** Computes total cost for a turn. Returns null if model pricing is unknown. */
export function computeTurnCost(
  model: string, out: number, inp: number, cacheRead: number, cacheWrite: number,
): number | null {
  const p = getPricing(model);
  if (!p) return null;
  return (out * p.outputPerMillion + inp * p.inputPerMillion + cacheRead * p.cacheReadPerMillion + cacheWrite * p.cacheWritePerMillion) / 1_000_000;
}

/**
 * Estimates cache savings: cacheReadTokens * (inputPrice - cacheReadPrice) / 1_000_000
 * Returns null if model pricing is unknown.
 */
export function computeCacheSavings(model: string, cacheReadTokens: number): number | null {
  const p = getPricing(model);
  if (!p) return null;
  return (cacheReadTokens * (p.inputPerMillion - p.cacheReadPerMillion)) / 1_000_000;
}
