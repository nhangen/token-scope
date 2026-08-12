import type { Reader, CreditWeekRow } from "@/reader";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatPct, bold } from "@/format";
import { VERSION } from "@/version";

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

interface Options {
  since: number;
  sinceStr: string;
  limit: number;
  json: boolean;
  cap: number;
  /** Injectable for tests; defaults to now. */
  nowMs?: number;
}

interface WeekCredits {
  weekStart: string;
  turns: number;
  subagentTurns: number;
  credits: number;
  components: { input: number; cacheWrite: number; cacheRead: number; output: number };
  /** True for the week still in progress — its total is not comparable to a full week. */
  partial: boolean;
  /** Fraction of the week elapsed, 0..1. 1 for complete weeks. */
  elapsed: number;
  /** End-of-week total at the observed rate. Null for complete weeks. */
  projected: number | null;
}

const WEEK_MS = 7 * 86_400_000;

function weekStartMs(weekStart: string): number {
  return Date.parse(`${weekStart}T00:00:00.000Z`);
}

export function computeWeeks(rows: CreditWeekRow[], nowMs: number): WeekCredits[] {
  return rows.map((r) => {
    const components = {
      input: r.inputTokens * CREDIT_WEIGHTS.input,
      cacheWrite: r.cacheWriteTokens * CREDIT_WEIGHTS.cacheWrite,
      cacheRead: r.cacheReadTokens * CREDIT_WEIGHTS.cacheRead,
      output: r.outputTokens * CREDIT_WEIGHTS.output,
    };
    const credits = components.input + components.cacheWrite + components.cacheRead + components.output;
    const start = weekStartMs(r.weekStart);
    const partial = nowMs < start + WEEK_MS;
    // Clamp: a week entirely in the future (clock skew across synced hosts)
    // must not divide by ~0 and project an absurd total.
    const elapsed = partial ? Math.min(1, Math.max(0.01, (nowMs - start) / WEEK_MS)) : 1;
    return {
      weekStart: r.weekStart,
      turns: r.turns,
      subagentTurns: r.subagentTurns,
      credits,
      components,
      partial,
      elapsed,
      projected: partial ? credits / elapsed : null,
    };
  });
}

export function renderCreditsReport(reader: Reader, opts: Options): void {
  const nowMs = opts.nowMs ?? Date.now();
  const { weeks: rawWeeks, subagentsIncluded } = reader.queryCreditWeeks(opts.since);
  const weeks = computeWeeks(rawWeeks, nowMs);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: {
        generated_at: new Date(nowMs).toISOString(),
        since: opts.since, token_scope_version: VERSION,
        weekly_cap: opts.cap, weights: CREDIT_WEIGHTS,
        subagents_included: subagentsIncluded,
      },
      report: "credits",
      weeks: weeks.map((w) => ({ ...w, capRatio: w.credits / opts.cap, projectedCapRatio: w.projected === null ? null : w.projected / opts.cap })),
    }, null, 2));
    return;
  }

  if (weeks.length === 0) {
    console.log(`No usage found in the last ${opts.sinceStr}.`);
    return;
  }

  const complete = weeks.filter((w) => !w.partial);
  const current = weeks.find((w) => w.partial);
  const recent = complete.slice(-4);
  const avgComplete = recent.length > 0 ? recent.reduce((s, w) => s + w.credits, 0) / recent.length : null;

  console.log(renderHeader("token-scope — Credit Consumption"));
  console.log(renderKV([
    ["Weekly cap", `${(opts.cap / 1e6).toFixed(1)}M credits`],
    ["Avg complete week", avgComplete === null ? "n/a" : `${(avgComplete / 1e6).toFixed(1)}M  (${(avgComplete / opts.cap).toFixed(2)}x cap)`],
    ["Week in progress", current === null || current === undefined
      ? "n/a"
      : `${(current.credits / 1e6).toFixed(1)}M so far → ${(current.projected! / 1e6).toFixed(1)}M projected  (${(current.projected! / opts.cap).toFixed(2)}x cap)`],
  ]));

  console.log(`\n${bold("  By Week")}`);
  console.log(renderTable(
    [
      { header: "Week (Mon)", align: "left", width: 12 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Sub", align: "right", width: 6 },
      { header: "Credits", align: "right", width: 10 },
      { header: "vs Cap", align: "right", width: 8 },
      { header: "Cache Rd", align: "right", width: 9 },
      { header: "Cache Wr", align: "right", width: 9 },
      { header: "Output", align: "right", width: 8 },
      { header: "", align: "left", width: 11 },
    ],
    weeks.map((w) => [
      w.weekStart,
      String(w.turns),
      w.subagentTurns > 0 ? String(w.subagentTurns) : "-",
      `${(w.credits / 1e6).toFixed(1)}M`,
      `${(w.credits / opts.cap).toFixed(2)}x`,
      formatPct((w.components.cacheRead / w.credits) * 100),
      formatPct((w.components.cacheWrite / w.credits) * 100),
      formatPct((w.components.output / w.credits) * 100),
      w.partial ? `→ ${(w.projected! / 1e6).toFixed(0)}M` : "",
    ])
  ));

  const last = complete.at(-1) ?? current;
  if (last) {
    const ctx = ((last.components.cacheRead + last.components.cacheWrite) / last.credits) * 100;
    console.log(renderFootnote(
      `Cache read + write is ${ctx.toFixed(0)}% of the most recent week's credits (output: ` +
      `${((last.components.output / last.credits) * 100).toFixed(0)}%). Context re-sent per turn dominates; ` +
      `shorter responses barely move this, smaller contexts do.`
    ));
    if (!subagentsIncluded) {
      console.log(renderFootnote(
        "Subagent turns are NOT included — this source cannot see them, so every total above is a floor. " +
        "Use --source jsonl for a real answer."
      ));
    }
    console.log(renderFootnote(
      `Credits are estimated: ${CREDIT_WEIGHTS.input} input : ${CREDIT_WEIGHTS.cacheWrite} cache-write : ` +
      `${CREDIT_WEIGHTS.cacheRead} cache-read : ${CREDIT_WEIGHTS.output} output per token, fitted to one ` +
      `metered week (0.6%). Tracks the meter; is not the meter.`
    ));
  }

  console.log(`\n  Tokens last complete week: ${
    last && !last.partial
      ? `${formatTokens(last.components.cacheRead / CREDIT_WEIGHTS.cacheRead)} cache reads, ${formatTokens(last.components.output / CREDIT_WEIGHTS.output)} output`
      : "n/a"
  }`);
  console.log("");
}
