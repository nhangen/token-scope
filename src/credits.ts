/**
 * Credit accounting, shared by the `--credits` report and the cost-alert hook.
 *
 * It lives in its own module because those two consumers must never disagree:
 * a hook that warns in one unit while the report measures in another produces
 * exactly the confusion the report was built to end.
 */

/**
 * Weight per token by component. A subscription meters "credits", not dollars,
 * and the two are not interchangeable: the plan cap is denominated in credits,
 * so a dollar figure cannot answer "am I over?".
 *
 * These weights were fitted against a metered week: with them, and no scaling
 * constant, the week of 2026-08-03 computes to 294.3M against a metered ~296M
 * (0.6%). They are the same 1 : 1.25 : 0.1 : 5 shape as the published per-model
 * dollar prices, which share those ratios across every model — so the model mix
 * cancels and one number per component is enough.
 *
 * The honest caveat: every model in the price table carries identical component
 * ratios, so "weights are proportional to price" collapses to a single free
 * scalar that one observation always determines exactly. The 0.6% agreement is
 * a consistency check, not an independent confirmation, and a mix dominated by
 * one model (opus was 97% of the fitted week) cannot distinguish a
 * model-agnostic weighting from an opus-normalized one. Treat the output as a
 * calibrated estimate that tracks the meter, not as the meter.
 */
export const CREDIT_WEIGHTS = {
  input: 1,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  output: 5,
} as const;

/** Max 20x weekly allowance, in weighted tokens. Override with --cap or TOKEN_SCOPE_CREDIT_CAP. */
export const DEFAULT_WEEKLY_CAP = 166_700_000;

export interface TokenComponents {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export function creditsOf(t: TokenComponents): number {
  return t.inputTokens * CREDIT_WEIGHTS.input
    + t.cacheWriteTokens * CREDIT_WEIGHTS.cacheWrite
    + t.cacheReadTokens * CREDIT_WEIGHTS.cacheRead
    + t.outputTokens * CREDIT_WEIGHTS.output;
}

/**
 * Parses a credit allowance: a positive number, optionally suffixed K/M/B
 * (case-insensitive). Returns null on anything else — a silently-misread cap
 * would move the line a burn report is judged against.
 */
export function parseCap(raw: string): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*([kKmMbB]?)$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]!.toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

/** Formats a credit count the way both the report and the hook print it. */
export function fmtCredits(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}
