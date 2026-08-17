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

/**
 * Max 20x weekly allowance, in weighted tokens. Override with --cap or
 * TOKEN_SCOPE_CREDIT_CAP.
 *
 * Measured, not published. On 2026-08-17, one hour before the plan week rolled,
 * Claude Code's `/usage` reported 7% of the weekly limit consumed; the same
 * window measured 126.8M credits here. That solves to ~1.81B — against a cap
 * inflated by an active "+50% weekly limits" promo, so the base is ~1.2B.
 *
 * The previous value, 166.7M, was never measured against the credit meter at
 * all, and it was wrong by roughly 30x: it made four consecutive real weeks
 * report 1.77x-4.74x of cap, which would have meant sustained lockout that
 * never happened. Against 1.2B those weeks read 0.25x-0.66x.
 *
 * Two honest caveats.
 *
 * `/usage` reports whole percents, so 7% carries ~±7% of relative error and the
 * promo-inflated cap is only bounded to ~1.69B-1.95B. And `/usage` counts the
 * whole account while this tool reads local sessions on one machine, so the
 * numerator is a floor — which biases the derived cap *low*, never high.
 *
 * More subtly: this figure is a cap *in this module's own credit units*. If
 * CREDIT_WEIGHTS is off from Anthropic's true weighting by some factor, the
 * measurement above is off by exactly the same factor, and the ratio the report
 * prints stays correct. That is the property worth having, and it is why the
 * cap must be re-derived by this same procedure — not adjusted by hand —
 * whenever the weights change.
 */
export const DEFAULT_WEEKLY_CAP = 1_200_000_000;

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
