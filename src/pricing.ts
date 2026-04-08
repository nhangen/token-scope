export interface ModelPricing {
  inputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
  outputPerMillion: number;
}

// Prices are per million tokens (USD). Source: Anthropic pricing as of 2026-04-07.
const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":            { inputPerMillion: 15.00, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.50,  outputPerMillion: 75.00 },
  "claude-sonnet-4-6":          { inputPerMillion:  3.00, cacheWritePerMillion:  3.75, cacheReadPerMillion: 0.30,  outputPerMillion: 15.00 },
  "claude-haiku-4-5-20251001":  { inputPerMillion:  0.80, cacheWritePerMillion:  1.00, cacheReadPerMillion: 0.08,  outputPerMillion:  4.00 },
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
      overrideMap = JSON.parse(raw) as Record<string, ModelPricing>;
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

/**
 * Estimates cache savings: cacheReadTokens * (inputPrice - cacheReadPrice) / 1_000_000
 * Returns null if model pricing is unknown.
 */
export function computeCacheSavings(model: string, cacheReadTokens: number): number | null {
  const p = getPricing(model);
  if (!p) return null;
  return (cacheReadTokens * (p.inputPerMillion - p.cacheReadPerMillion)) / 1_000_000;
}
