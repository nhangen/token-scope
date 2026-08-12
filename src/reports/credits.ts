import type { Reader, CreditWeekRow } from "@/reader";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatPct, bold } from "@/format";
import { VERSION } from "@/version";
import { CREDIT_WEIGHTS } from "@/credits";

// Weights and cap live in @/credits so the cost-alert hook warns in the same
// unit this report measures in. Re-exported here because the CLI and tests
// import them from this module.
export { CREDIT_WEIGHTS, DEFAULT_WEEKLY_CAP } from "@/credits";

/**
 * Below this fraction of a week elapsed, no projection is printed. Extrapolating
 * from the first hours of a week multiplies whatever happened to land there by
 * 20x or more, and a Monday-morning run is the common case, not an edge one — the
 * number would be pure noise wearing a forecast's clothes.
 */
export const MIN_ELAPSED_TO_PROJECT = 0.2;

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
  /** The subagent share of `credits`, already counted in it. */
  subagentCredits: number;
  components: { input: number; cacheWrite: number; cacheRead: number; output: number };
  /** True for the week still in progress — its total is not comparable to a full week. */
  partial: boolean;
  /**
   * True when the requested window started mid-week, so this row holds only part
   * of the week's spend. Calendar-complete but data-incomplete: the distinction
   * the first cut of this report missed, which let a half-observed week be
   * averaged in as if whole.
   */
  truncated: boolean;
  /** Fraction of the week elapsed, 0..1. 1 for complete weeks. */
  elapsed: number;
  /** End-of-week total at the observed rate. Null when complete, or too early to mean anything. */
  projected: number | null;
}

const WEEK_MS = 7 * 86_400_000;

function weekStartMs(weekStart: string): number {
  return Date.parse(`${weekStart}T00:00:00.000Z`);
}

function share(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

export function computeWeeks(rows: CreditWeekRow[], nowMs: number, sinceMs = 0): WeekCredits[] {
  return rows.map((r) => {
    const components = {
      input: r.inputTokens * CREDIT_WEIGHTS.input,
      cacheWrite: r.cacheWriteTokens * CREDIT_WEIGHTS.cacheWrite,
      cacheRead: r.cacheReadTokens * CREDIT_WEIGHTS.cacheRead,
      output: r.outputTokens * CREDIT_WEIGHTS.output,
    };
    const credits = components.input + components.cacheWrite + components.cacheRead + components.output;
    const subagentCredits =
      r.subagentInputTokens * CREDIT_WEIGHTS.input +
      r.subagentCacheWriteTokens * CREDIT_WEIGHTS.cacheWrite +
      r.subagentCacheReadTokens * CREDIT_WEIGHTS.cacheRead +
      r.subagentOutputTokens * CREDIT_WEIGHTS.output;
    const start = weekStartMs(r.weekStart);
    const partial = nowMs < start + WEEK_MS;
    const truncated = sinceMs > start;
    const elapsed = partial ? Math.min(1, Math.max(0, (nowMs - start) / WEEK_MS)) : 1;
    return {
      weekStart: r.weekStart,
      turns: r.turns,
      subagentTurns: r.subagentTurns,
      credits,
      subagentCredits,
      components,
      partial,
      truncated,
      elapsed,
      // A truncated week's credits cover only part of the week, so dividing them
      // by the *week's* elapsed fraction understates the projection by exactly
      // the unobserved slice — the same bug as averaging a truncated week, moved
      // into the forecast. Don't project one at all.
      projected: partial && !truncated && elapsed >= MIN_ELAPSED_TO_PROJECT ? credits / elapsed : null,
    };
  });
}

export function renderCreditsReport(reader: Reader, opts: Options): void {
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = opts.since * 1000;
  const { weeks: rawWeeks, subagentsIncluded } = reader.queryCreditWeeks(opts.since);
  const weeks = computeWeeks(rawWeeks, nowMs, sinceMs);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: {
        generated_at: new Date(nowMs).toISOString(),
        since: opts.since, token_scope_version: VERSION,
        weekly_cap: opts.cap, weights: CREDIT_WEIGHTS,
        subagents_included: subagentsIncluded,
      },
      report: "credits",
      weeks: weeks.map((w) => ({
        ...w,
        capRatio: w.credits / opts.cap,
        projectedCapRatio: w.projected === null ? null : w.projected / opts.cap,
      })),
    }, null, 2));
    return;
  }

  if (weeks.length === 0) {
    console.log(`No usage found in the last ${opts.sinceStr}.`);
    return;
  }

  // Only weeks that are both calendar-complete AND fully inside the window are
  // comparable to each other or to the cap.
  const whole = weeks.filter((w) => !w.partial && !w.truncated);
  // The week containing `now` — not merely the first partial one, which a single
  // future-dated turn (clock skew on a synced host) would otherwise win.
  const current = weeks.find((w) => w.partial && nowMs >= weekStartMs(w.weekStart));
  const recent = whole.slice(-4);
  const avgWhole = recent.length > 0 ? recent.reduce((s, w) => s + w.credits, 0) / recent.length : null;

  console.log(renderHeader("token-scope — Credit Consumption"));
  console.log(renderKV([
    ["Weekly cap", `${(opts.cap / 1e6).toFixed(1)}M credits`],
    ["Avg full week", avgWhole === null
      ? `n/a (no complete week inside --since ${opts.sinceStr})`
      : `${(avgWhole / 1e6).toFixed(1)}M  (${(avgWhole / opts.cap).toFixed(2)}x cap)   over ${recent.length} week(s)`],
    ["Week in progress", current === undefined
      ? "n/a"
      : current.projected === null
        ? `${(current.credits / 1e6).toFixed(1)}M so far  (${current.truncated
            ? `only the part inside --since ${opts.sinceStr} — no projection`
            : `${(current.elapsed * 100).toFixed(0)}% elapsed — too early to project`})`
        : `${(current.credits / 1e6).toFixed(1)}M so far → ${(current.projected / 1e6).toFixed(1)}M projected  (${(current.projected / opts.cap).toFixed(2)}x cap)`],
  ]));

  console.log(`\n${bold("  By Week")}`);
  console.log(renderTable(
    [
      { header: "Week (Mon)", align: "left", width: 12 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Credits", align: "right", width: 10 },
      { header: "vs Cap", align: "right", width: 8 },
      { header: "Cache Rd", align: "right", width: 9 },
      { header: "Cache Wr", align: "right", width: 9 },
      { header: "Output", align: "right", width: 8 },
      { header: "Subagent", align: "right", width: 9 },
      { header: "", align: "left", width: 18 },
    ],
    weeks.map((w) => [
      w.weekStart,
      String(w.turns),
      `${(w.credits / 1e6).toFixed(1)}M`,
      `${(w.credits / opts.cap).toFixed(2)}x`,
      formatPct(share(w.components.cacheRead, w.credits)),
      formatPct(share(w.components.cacheWrite, w.credits)),
      formatPct(share(w.components.output, w.credits)),
      subagentsIncluded ? formatPct(share(w.subagentCredits, w.credits)) : "n/a",
      w.truncated && w.partial
        ? "in progress, partial"
        : w.truncated
          ? "partial (window)"
          : w.partial
            ? (w.projected === null ? "in progress" : `→ ${(w.projected / 1e6).toFixed(0)}M`)
            : "",
    ])
  ));

  const truncatedCount = weeks.filter((w) => w.truncated).length;
  if (truncatedCount > 0) {
    console.log(renderFootnote(
      `${truncatedCount} week(s) marked "partial (window)" start before --since ${opts.sinceStr}, so they hold ` +
      `only part of that week and are excluded from the average above. Widen --since to see them whole.`
    ));
  }

  const last = whole.at(-1);
  if (last) {
    const ctx = share(last.components.cacheRead + last.components.cacheWrite, last.credits);
    console.log(renderFootnote(
      `In the last full week (${last.weekStart}), cache read + write is ${formatPct(ctx)} of credits and output is ` +
      `${formatPct(share(last.components.output, last.credits))}. Context re-sent per turn dominates; shorter ` +
      `responses barely move this, smaller contexts do.`
    ));
    if (subagentsIncluded && last.subagentCredits > 0) {
      console.log(renderFootnote(
        `Subagents were ${formatPct(share(last.subagentCredits, last.credits))} of that week ` +
        `(${(last.subagentCredits / 1e6).toFixed(1)}M credits over ${last.subagentTurns} turns) — the size of the ` +
        `lever if you dispatch fewer of them, or give them less context.`
      ));
    }
  }
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

  if (last) {
    console.log(`\n  Tokens in ${last.weekStart}: ${formatTokens(last.components.cacheRead / CREDIT_WEIGHTS.cacheRead)} cache reads, ${formatTokens(last.components.output / CREDIT_WEIGHTS.output)} output`);
  }
  console.log("");
}
