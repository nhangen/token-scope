import type { Reader } from "@/reader";
import { readLedger, resolveLedgerPath, type LedgerRun } from "@/ledger";
import { getPricing } from "@/pricing";
import {
  renderHeader, renderKV, renderTable, renderFootnote,
  formatTokens, formatUsd, truncate, bold,
} from "@/format";
import { VERSION } from "@/version";

/** The model the counterfactual is priced against by default — the most
 *  capable current tier, i.e. what would plausibly have authored the code. */
export const DEFAULT_COUNTERFACTUAL_MODEL = "claude-opus-4-8";

interface SavingsOptions {
  sessionId?: string;
  since: number;
  sinceStr: string;
  json: boolean;
  ledgerPath?: string;
  counterfactualModel: string;
  /** When set (requires --session), PM overhead is scoped to this 1-indexed
   *  inclusive turn slice — the delegation's orchestration turns — instead of
   *  the whole session. The ledger has no delegation-start marker, so the PM
   *  window can't be auto-derived; the caller isolates it, as with --spend. */
  pmTurnRange?: { from?: number; to?: number };
  /** When set (requires --session, excludes pmTurnRange), PM overhead is this
   *  caller-measured dollar figure instead of anything derived from transcripts.
   *  This is the honest denominator for a subagent PM (a lean Haiku agent's cost
   *  is session-wide in v1, so neither whole-session nor --pm-turns can isolate
   *  it) — measured out-of-band, e.g. via the subagent-bucket delta between two
   *  --spend runs. Needs no local transcript, so it also attributes sessions
   *  that ran elsewhere. */
  pmCost?: number;
  /** When set, emit a per-label breakdown (`by_label`) of the ledger's runs.
   *  Label is the second colon-separated segment of a run's run_id. */
  byLabel?: boolean;
}

/**
 * Values ollama token volume at Claude prices: the estimated cost had Claude
 * authored the same work. Input+output only — ollama has no prompt-cache
 * concept. Returns null if the model isn't in the price map.
 */
export function valueAtClaudePrices(inputTokens: number, outputTokens: number, model: string): number | null {
  const p = getPricing(model);
  if (!p) return null;
  return (inputTokens * p.inputPerMillion + outputTokens * p.outputPerMillion) / 1_000_000;
}

/** The share of a run's recorded input tokens Claude would have paid FULL input
 *  price for. The rest is re-read and would have hit the prompt cache.
 *
 *  ollama has no prompt cache, so an agentic run re-sends its entire prefix every
 *  turn and `ollama_input_tokens` is the SUM of those re-sends. Claude would have
 *  paid full price for each token exactly once — on the turn it first appeared —
 *  and cache-read price for every later re-send. Pricing the whole sum as fresh
 *  input therefore credits the delegation with avoiding a cost that never existed,
 *  and the error grows with turn count (nhangen/llm-tools#465).
 *
 *  The uncached share is the FINAL prefix, not "the first turn": the per-turn
 *  deltas telescope, since every token is new exactly once. Under linear prefix
 *  growth (prefix_k = k*c) the recorded total is c*t*(t+1)/2 while the final
 *  prefix is c*t, giving 2/(t+1).
 *
 *  That linear assumption is the estimate's one soft spot, and it is deliberately
 *  crude: the ledger records a per-run total and a turn count, nothing per-turn,
 *  so a better model needs the wrapper to record prompt sizes. Measured against
 *  the alternative reading — only turn 1 uncached, i.e. 1/t — the live ledger's
 *  counterfactual differs by 13% ($13.46 vs $11.93), so the choice between the two
 *  does not change any conclusion. Pricing it all as fresh input differs by 4x.
 *
 *  An absent or nonsensical `turns` yields 1 — fully uncached, the pre-#465
 *  behaviour. That is the conservative direction: it over-states the
 *  counterfactual rather than inventing a discount from a field that isn't there.
 */
export function uncachedInputShare(turns: number | null): number {
  if (turns === null || !Number.isFinite(turns) || turns < 2) return 1;
  return 2 / (turns + 1);
}

/** Split one run's recorded input into the part Claude would have paid full input
 *  price for and the part it would have read from cache. Rounded so the two always
 *  sum to the recorded total — a split that loses or invents tokens would show up
 *  as a counterfactual that disagrees with the volume it was computed from. */
export function splitCachedInput(inputTokens: number, turns: number | null): { uncached: number; cached: number } {
  const uncached = Math.round(inputTokens * uncachedInputShare(turns));
  return { uncached, cached: inputTokens - uncached };
}

/** Counterfactual for authoring volume, with re-read input priced at cache-read. */
export function valueAtClaudePricesCached(
  uncachedInput: number, cachedInput: number, outputTokens: number, model: string,
): number | null {
  const p = getPricing(model);
  if (!p) return null;
  return (uncachedInput * p.inputPerMillion
        + cachedInput * p.cacheReadPerMillion
        + outputTokens * p.outputPerMillion) / 1_000_000;
}

/** A row is a review row iff its run_id is a string starting with `review:`.
 *  Everything else — null, no colon, `author:...`, legacy ids — is authoring. */
function isReviewRow(r: LedgerRun): boolean {
  return typeof r.runId === "string" && r.runId.startsWith("review:");
}

/** A row is a bench row iff its run_id is a string starting with `bench:` —
 *  a benchmark/evaluation sweep. Like review, it is excluded from the
 *  counterfactual: nobody would have paid Claude to generate benchmark
 *  completions across a model grid. */
function isBenchRow(r: LedgerRun): boolean {
  return typeof r.runId === "string" && r.runId.startsWith("bench:");
}

/** Why an authoring row did not succeed, or null if it did (or is not an
 *  authoring row at all).
 *
 *  Prefers the ledger's own `reason` (nhangen/claude-ceo#327), which says in one
 *  field what `completed`/`verified` only imply across two nullable ones. An
 *  unrecognized value is "other", never success: when the bridge learns a new
 *  termination cause, a report that has not caught up should say so rather than
 *  quietly bank it as work that landed.
 *
 *  The fallback is not legacy dead weight — as of 2026-08-18 it is the ONLY
 *  path that fires on a failed run, because every row carrying a reason so far
 *  says "ok". `verified === false` first, then `completed === false`, mirroring
 *  the bridge's own rule so a legacy row and its modern twin land in the same
 *  bucket.
 *
 *  `completed:true, verified:null` is NOT failed — it is the commonest shape in
 *  the ledger and means "finished, nothing asserted". */
type UnverifiedKind = "turn-cap" | "verify-failed" | "other";

function unverifiedKindOf(r: LedgerRun): UnverifiedKind | null {
  if (isReviewRow(r) || isBenchRow(r)) return null;
  if (typeof r.reason === "string") {
    if (r.reason === "ok") return null;
    if (r.reason === "turn-cap") return "turn-cap";
    if (r.reason === "verify-failed") return "verify-failed";
    return "other";
  }
  if (r.verified === false) return "verify-failed";
  if (r.completed === false) return "turn-cap";
  return null;
}

function isUnverifiedRow(r: LedgerRun): boolean {
  return unverifiedKindOf(r) !== null;
}

const KINDS: UnverifiedKind[] = ["turn-cap", "verify-failed", "other"];

function tallyKinds(rows: LedgerRun[]): Record<UnverifiedKind, number> {
  const out: Record<UnverifiedKind, number> = { "turn-cap": 0, "verify-failed": 0, other: 0 };
  for (const r of rows) {
    const k = unverifiedKindOf(r);
    if (k !== null) out[k]++;
  }
  return out;
}

/** A row's label: the second colon-separated segment of run_id, or null when
 *  run_id is null, has no colon, or that segment is empty. */
function labelOf(r: LedgerRun): string | null {
  if (typeof r.runId !== "string" || !r.runId.includes(":")) return null;
  const seg = r.runId.split(":")[1];
  return seg === "" || seg === undefined ? null : seg;
}

/**
 * Actual Claude billed spend attributed as PM overhead for a session.
 * Whole-session (default): direct turns + session-wide subagent rollup.
 * Turn-scoped (`pmTurnRange` set): only the direct turns in the 1-indexed
 * inclusive slice — the delegation's orchestration turns. Subagent cost is
 * session-wide (not turn-scoped in v1), so it's EXCLUDED when scoping; callers
 * surface `scoped` so the report can footnote that.
 * `found` is false when the session isn't present in the transcripts.
 */
function sessionBilledSpend(
  reader: Reader, sessionId: string, pmTurnRange?: { from?: number; to?: number },
): { cost: number | null; partial: boolean; found: boolean; scoped: boolean } {
  const turns = reader.querySessionTurns(sessionId);
  if (turns.length === 0) return { cost: null, partial: false, found: false, scoped: !!pmTurnRange };

  let selected = turns;
  const scoped = !!pmTurnRange;
  if (pmTurnRange) {
    const from = pmTurnRange.from ?? 1;
    const to = Math.min(pmTurnRange.to ?? turns.length, turns.length);
    selected = turns.filter((_, i) => i + 1 >= from && i + 1 <= to);
  }

  let cost = 0, anyKnown = false, anyNull = false;
  for (const t of selected) {
    if (t.costUsd === null) anyNull = true;
    else { cost += t.costUsd; anyKnown = true; }
  }
  let total: number | null = anyKnown ? cost : null;
  let partial = anyNull;

  // Subagent (auditor/explorer) cost is only available session-wide, so it can
  // only be folded in for the whole-session view — never a turn slice.
  if (!scoped) {
    const sub = reader.querySubagentSpend(sessionId);
    if (sub.supported) {
      if (sub.costUsd !== null) total = (total ?? 0) + sub.costUsd;
      partial = partial || sub.costPartial;
    }
  }
  return { cost: total, partial, found: true, scoped };
}

interface SessionGroup {
  sessionId: string | null;
  cwd: string | null;
  runCount: number;
  ollamaInput: number;
  ollamaOutput: number;
  reviewRunCount: number;
  reviewInput: number;
  reviewOutput: number;
  benchRunCount: number;
  benchInput: number;
  benchOutput: number;
  unverifiedRunCount: number;
  unverifiedInput: number;
  unverifiedOutput: number;
  unverifiedByKind: Record<UnverifiedKind, number>;
  /** Authoring input split by what Claude would have paid for it: `uncachedInput`
   *  at full input price, `cachedInput` at cache-read. They sum to authoring
   *  input. See `uncachedInputShare`. */
  uncachedInput: number;
  cachedInput: number;
  models: string[];
  counterfactual: number | null;
  pmOverhead: number | null;
  pmPartial: boolean;
  net: number | null;
  attributed: boolean;
  found: boolean;
}

interface LabelAgg {
  label: string | null;
  runCount: number;
  reviewRunCount: number;
  benchRunCount: number;
  authorInput: number;
  uncachedInput: number;
  cachedInput: number;
  authorOutput: number;
  reviewInput: number;
  reviewOutput: number;
  benchInput: number;
  benchOutput: number;
  unverifiedRunCount: number;
  unverifiedInput: number;
  unverifiedOutput: number;
}

const UNATTRIBUTED = "(unattributed)";

export function renderSavingsReport(reader: Reader, opts: SavingsOptions): void {
  const ledgerPath = resolveLedgerPath(opts.ledgerPath);
  let runs = readLedger(opts.ledgerPath);

  // --session scopes to one delegation session (prefix match).
  if (opts.sessionId) runs = runs.filter((r) => r.sessionId !== null && r.sessionId.startsWith(opts.sessionId!));

  // --since acts as a ledger-time floor, but only when explicitly set (the 30d
  // default must not silently drop older runs from a lifetime total).
  const sinceFloorApplied = opts.sinceStr !== "30d";
  if (sinceFloorApplied) {
    const cutoffMs = opts.since * 1000;
    runs = runs.filter((r) => r.ts !== null && Date.parse(r.ts) > cutoffMs);
  }

  const counterfactualPriced = getPricing(opts.counterfactualModel) !== null;

  // Group by session_id (null → unattributed bucket).
  const byKey = new Map<string, LedgerRun[]>();
  for (const r of runs) {
    const key = r.sessionId ?? UNATTRIBUTED;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(r);
  }

  const groups: SessionGroup[] = [];
  for (const [key, groupRuns] of byKey) {
    const sessionId = key === UNATTRIBUTED ? null : key;
    const ollamaInput = groupRuns.reduce((s, r) => s + r.ollamaInputTokens, 0);
    const ollamaOutput = groupRuns.reduce((s, r) => s + r.ollamaOutputTokens, 0);
    const models = [...new Set(groupRuns.map((r) => r.model).filter((m): m is string => m !== null))];

    // Review volume is reported separately and excluded from the counterfactual
    // (pricing review as authoring would overstate "what Claude authoring would
    // have cost"). Totals (ollamaInput/Output) still include every row.
    const groupReview = groupRuns.filter(isReviewRow);
    const reviewInput = groupReview.reduce((s, r) => s + r.ollamaInputTokens, 0);
    const reviewOutput = groupReview.reduce((s, r) => s + r.ollamaOutputTokens, 0);
    const reviewRunCount = groupReview.length;

    // Bench volume (benchmark sweeps) is reported separately and excluded from
    // the counterfactual exactly like review: those runs exist only because
    // local inference is free. Totals (ollamaInput/Output) still include them.
    const groupBench = groupRuns.filter(isBenchRow);
    const benchInput = groupBench.reduce((s, r) => s + r.ollamaInputTokens, 0);
    const benchOutput = groupBench.reduce((s, r) => s + r.ollamaOutputTokens, 0);
    const benchRunCount = groupBench.length;

    // Unverified authoring runs (verify never passed) are a separate
    // reporting axis only: they are authoring, so they stay in the
    // counterfactual exactly as today.
    const groupUnverified = groupRuns.filter(isUnverifiedRow);
    const unverifiedInput = groupUnverified.reduce((s, r) => s + r.ollamaInputTokens, 0);
    const unverifiedOutput = groupUnverified.reduce((s, r) => s + r.ollamaOutputTokens, 0);
    const unverifiedRunCount = groupUnverified.length;
    const unverifiedByKind = tallyKinds(groupUnverified);
    // The cache split is per-run — it depends on that run's turn count — so it
    // cannot be applied to a summed input figure. Take the authoring rows once and
    // derive BOTH the split and `authorInput` from them, rather than splitting rows
    // while subtracting to get the total: two derivations of "authoring input" can
    // disagree (a new excluded row class added to one and not the other), and the
    // disagreement would surface only as a quietly mispriced dollar figure. One
    // source of truth means there is no divergence to guard against.
    const groupAuthor = groupRuns.filter((r) => !isReviewRow(r) && !isBenchRow(r));
    let uncachedInput = 0, cachedInput = 0, authorInput = 0, authorOutput = 0;
    for (const r of groupAuthor) {
      const split = splitCachedInput(r.ollamaInputTokens, r.turns);
      uncachedInput += split.uncached; cachedInput += split.cached;
      authorInput += r.ollamaInputTokens; authorOutput += r.ollamaOutputTokens;
    }
    const counterfactual = valueAtClaudePricesCached(uncachedInput, cachedInput, authorOutput, opts.counterfactualModel);

    let pmOverhead: number | null = null, pmPartial = false, found = false;
    if (sessionId !== null && opts.pmCost !== undefined) {
      // Caller-measured PM figure: no transcript lookup at all — the caller
      // measured it out-of-band, so absence from local transcripts is fine.
      pmOverhead = opts.pmCost; found = true;
    } else if (sessionId !== null) {
      const billed = sessionBilledSpend(reader, sessionId, opts.pmTurnRange);
      pmOverhead = billed.cost; pmPartial = billed.partial; found = billed.found;
    }
    // A group is attributed only when we have BOTH sides of the subtraction.
    const attributed = found && counterfactual !== null && pmOverhead !== null;
    const net = attributed ? counterfactual! - pmOverhead! : null;

    groups.push({
      sessionId, cwd: groupRuns.find((r) => r.cwd !== null)?.cwd ?? null,
      runCount: groupRuns.length, ollamaInput, ollamaOutput,
      reviewRunCount, reviewInput, reviewOutput,
      benchRunCount, benchInput, benchOutput,
      unverifiedRunCount, unverifiedInput, unverifiedOutput, unverifiedByKind, models,
      uncachedInput, cachedInput,
      counterfactual, pmOverhead, pmPartial, net, attributed, found,
    });
  }

  // --pm-turns scopes to one session's turn numbering, and --pm-cost is one
  // measured figure for one session's delegations — both are only meaningful
  // against a single session. If the --session prefix matched more than one
  // ledger session, applying the same range/figure to each would silently
  // mis-scope PM overhead — refuse, mirroring --spend's multi-match guard.
  if (opts.pmTurnRange || opts.pmCost !== undefined) {
    const flag = opts.pmTurnRange ? "--pm-turns" : "--pm-cost";
    const named = groups.filter((g) => g.sessionId !== null).map((g) => g.sessionId!);
    if (named.length > 1) {
      console.log(`${flag} needs a unique session (it applies to one session's delegations), but the ledger has ${named.length} sessions here: ${named.map((s) => s.slice(0, 16)).join(", ")}. Narrow --session to one.`);
      return;
    }
  }
  // Stable order: attributed sessions first (by net desc), then the rest.
  groups.sort((a, b) => {
    if (a.attributed !== b.attributed) return a.attributed ? -1 : 1;
    return (b.net ?? 0) - (a.net ?? 0);
  });

  const totalIn = groups.reduce((s, g) => s + g.ollamaInput, 0);
  const totalOut = groups.reduce((s, g) => s + g.ollamaOutput, 0);
  const totalRuns = groups.reduce((s, g) => s + g.runCount, 0);
  const totalReviewRuns = groups.reduce((s, g) => s + g.reviewRunCount, 0);
  const totalReviewIn = groups.reduce((s, g) => s + g.reviewInput, 0);
  const totalReviewOut = groups.reduce((s, g) => s + g.reviewOutput, 0);
  const totalBenchRuns = groups.reduce((s, g) => s + g.benchRunCount, 0);
  const totalBenchIn = groups.reduce((s, g) => s + g.benchInput, 0);
  const totalBenchOut = groups.reduce((s, g) => s + g.benchOutput, 0);
  const totalUnverifiedRuns = groups.reduce((s, g) => s + g.unverifiedRunCount, 0);
  const totalUnverifiedIn = groups.reduce((s, g) => s + g.unverifiedInput, 0);
  const totalUnverifiedOut = groups.reduce((s, g) => s + g.unverifiedOutput, 0);
  const totalByKind: Record<UnverifiedKind, number> = { "turn-cap": 0, "verify-failed": 0, other: 0 };
  for (const g of groups) {
    for (const k of KINDS) totalByKind[k] += g.unverifiedByKind[k];
  }
  const attributedGroups = groups.filter((g) => g.attributed);
  const netTotal = attributedGroups.length > 0
    ? attributedGroups.reduce((s, g) => s + (g.net ?? 0), 0) : null;
  const counterfactualAttributed = attributedGroups.reduce((s, g) => s + (g.counterfactual ?? 0), 0);
  // Summed over ATTRIBUTED groups, matching `counterfactualAttributed` above — these
  // are the split behind that dollar figure, so covering a different set of sessions
  // would make them describe a total nobody reports. On the live ledger the two sets
  // differ (8 groups vs 6), so this is not a distinction without a difference.
  const totalUncachedInput = attributedGroups.reduce((n, g) => n + g.uncachedInput, 0);
  const totalCachedInput = attributedGroups.reduce((n, g) => n + g.cachedInput, 0);
  const pmAttributed = attributedGroups.reduce((s, g) => s + (g.pmOverhead ?? 0), 0);
  const unattributedRuns = groups.filter((g) => !g.attributed).reduce((s, g) => s + g.runCount, 0);

  // Per-label breakdown, across the whole (filtered) ledger — not nested inside
  // the per-session grouping. Label is the second colon-separated segment of a
  // run's run_id; null for unlabelled rows.
  const labelMap = new Map<string, LabelAgg>();
  for (const r of runs) {
    const label = labelOf(r);
    const k = label === null ? "\u0000null" : label;
    let agg = labelMap.get(k);
    if (!agg) {
      agg = { label, runCount: 0, reviewRunCount: 0, benchRunCount: 0, authorInput: 0, uncachedInput: 0, cachedInput: 0, authorOutput: 0, reviewInput: 0, reviewOutput: 0, benchInput: 0, benchOutput: 0, unverifiedRunCount: 0, unverifiedInput: 0, unverifiedOutput: 0 };
      labelMap.set(k, agg);
    }
    agg.runCount++;
    if (isReviewRow(r)) {
      agg.reviewRunCount++;
      agg.reviewInput += r.ollamaInputTokens;
      agg.reviewOutput += r.ollamaOutputTokens;
    } else if (isBenchRow(r)) {
      agg.benchRunCount++;
      agg.benchInput += r.ollamaInputTokens;
      agg.benchOutput += r.ollamaOutputTokens;
    } else {
      agg.authorInput += r.ollamaInputTokens;
      {
        const split = splitCachedInput(r.ollamaInputTokens, r.turns);
        agg.uncachedInput += split.uncached; agg.cachedInput += split.cached;
      }
      agg.authorOutput += r.ollamaOutputTokens;
    }
    if (isUnverifiedRow(r)) {
      agg.unverifiedRunCount++;
      agg.unverifiedInput += r.ollamaInputTokens;
      agg.unverifiedOutput += r.ollamaOutputTokens;
    }
  }
  // Deterministic across machines: the unlabelled bucket last, then a
  // numeric-aware compare so ticket 412 precedes 1000. localeCompare's default
  // collation is locale-dependent, which would let the same ledger order
  // differently on two hosts \u2014 bad for a report that gets diffed.
  const byLabelAgg = [...labelMap.values()].sort((a, b) => {
    if (a.label === null) return b.label === null ? 0 : 1;
    if (b.label === null) return -1;
    return a.label.localeCompare(b.label, "en", { numeric: true });
  });

  if (opts.json) {
    const sessions = groups.map((g) => {
      const base = {
        session_id: g.sessionId, cwd: g.cwd, run_count: g.runCount,
        ollama_input: g.ollamaInput, ollama_output: g.ollamaOutput, models: g.models,
        counterfactual_usd: g.counterfactual, pm_overhead_usd: g.pmOverhead,
        // The split behind this session's counterfactual. Emitted per session as
        // well as in totals because the totals pair covers ATTRIBUTED sessions only
        // (to match the dollar figure there), so an unattributed session's split is
        // reachable nowhere else.
        counterfactual_uncached_input: g.uncachedInput,
        counterfactual_cached_input: g.cachedInput,
        pm_overhead_partial: g.pmPartial, net_savings_usd: g.net, attributed: g.attributed,
      };
      // Present on every session or on none — never per-session, or an array
      // whose elements have different shapes hands a consumer NaN on the
      // sessions that happen to have no review rows. The byte-identical
      // guarantee for a review-free ledger is report-level, so this keeps it.
      // Each axis contributes its keys independently. Enumerating the
      // combinations instead doubles the branches every time an axis is added,
      // and three of the four branches would be untested.
      return {
        ...base,
        ...(totalReviewRuns > 0 ? {
          review_run_count: g.reviewRunCount, review_input: g.reviewInput, review_output: g.reviewOutput,
        } : {}),
        ...(totalBenchRuns > 0 ? {
          bench_run_count: g.benchRunCount, bench_input: g.benchInput, bench_output: g.benchOutput,
        } : {}),
        ...(totalUnverifiedRuns > 0 ? {
          unverified_run_count: g.unverifiedRunCount, unverified_input: g.unverifiedInput, unverified_output: g.unverifiedOutput,
          unverified_turn_cap_run_count: g.unverifiedByKind["turn-cap"],
          unverified_verify_failed_run_count: g.unverifiedByKind["verify-failed"],
          unverified_other_run_count: g.unverifiedByKind.other,
        } : {}),
      };
    });
    const totals: Record<string, unknown> = {
      run_count: totalRuns, ollama_input: totalIn, ollama_output: totalOut,
      counterfactual_usd: attributedGroups.length > 0 ? counterfactualAttributed : null,
      pm_overhead_usd: attributedGroups.length > 0 ? pmAttributed : null,
      net_savings_usd: netTotal,
      attributed_session_count: attributedGroups.length,
      unattributed_run_count: unattributedRuns,
      // The split behind counterfactual_usd, so a reader can see how much of the
      // priced input was re-read rather than having to trust the total.
      counterfactual_uncached_input: totalUncachedInput,
      counterfactual_cached_input: totalCachedInput,
    };
    if (totalReviewRuns > 0) {
      totals.review_run_count = totalReviewRuns;
      totals.review_input = totalReviewIn;
      totals.review_output = totalReviewOut;
    }
    if (totalBenchRuns > 0) {
      totals.bench_run_count = totalBenchRuns;
      totals.bench_input = totalBenchIn;
      totals.bench_output = totalBenchOut;
    }
    if (totalUnverifiedRuns > 0) {
      totals.unverified_run_count = totalUnverifiedRuns;
      totals.unverified_input = totalUnverifiedIn;
      totals.unverified_output = totalUnverifiedOut;
      totals.unverified_turn_cap_run_count = totalByKind["turn-cap"];
      totals.unverified_verify_failed_run_count = totalByKind["verify-failed"];
      totals.unverified_other_run_count = totalByKind.other;
    }
    const payload: Record<string, unknown> = {
      meta: { generated_at: new Date().toISOString(), token_scope_version: VERSION },
      report: "savings",
      ledger_path: ledgerPath,
      counterfactual_model: opts.counterfactualModel,
      counterfactual_priced: counterfactualPriced,
      since_floor_applied: sinceFloorApplied,
      pm_scope: opts.pmCost !== undefined
        ? { mode: "measured", cost_usd: opts.pmCost }
        : opts.pmTurnRange
          ? { mode: "turns", from: opts.pmTurnRange.from ?? null, to: opts.pmTurnRange.to ?? null }
          : { mode: "whole-session" },
      sessions,
      totals,
    };
    if (opts.byLabel) {
      payload.by_label = byLabelAgg.map((a) => ({
        label: a.label,
        run_count: a.runCount,
        review_run_count: a.reviewRunCount,
        author_input: a.authorInput,
        author_output: a.authorOutput,
        review_input: a.reviewInput,
        review_output: a.reviewOutput,
        bench_run_count: a.benchRunCount,
        bench_input: a.benchInput,
        bench_output: a.benchOutput,
        unverified_run_count: a.unverifiedRunCount,
        unverified_input: a.unverifiedInput,
        unverified_output: a.unverifiedOutput,
        counterfactual_usd: valueAtClaudePricesCached(a.uncachedInput, a.cachedInput, a.authorOutput, opts.counterfactualModel),
      }));
    }
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(renderHeader("token-scope — Ollama Delegation Savings"));
  console.log(renderKV([
    ["Ledger", ledgerPath],
    ["Runs", `${totalRuns} across ${groups.length} session${groups.length === 1 ? "" : "s"}`],
    ["Counterfactual model", counterfactualPriced ? `${opts.counterfactualModel} (est.)` : `${opts.counterfactualModel} — no known pricing`],
    ["PM overhead scope", opts.pmCost !== undefined
      ? `measured (caller): ${formatUsd(opts.pmCost)}`
      : opts.pmTurnRange
        ? `turns ${opts.pmTurnRange.from ?? 1}..${opts.pmTurnRange.to ?? "end"} (delegation only)`
        : "whole session"],
    ["Since floor", sinceFloorApplied ? `> ${opts.sinceStr}` : "none (all runs)"],
    // ollama has no prompt cache, so the ledger's input total counts every re-read.
    // Naming the split here is what stops the counterfactual reading as if Claude
    // would have paid full price for all of it (#465).
    ...(totalCachedInput > 0
      ? [["Input priced", `${formatTokens(totalUncachedInput)} fresh + ${formatTokens(totalCachedInput)} re-read at cache-read rate`] as [string, string]]
      : []),
  ]));

  if (totalRuns === 0) {
    console.log(renderFootnote(`No delegation runs found in the ledger. Run a task through the ollama-agent bridge to populate it.`));
    console.log("");
    return;
  }

  console.log(`\n${bold("  Per-Session")}`);
  console.log(renderTable(
    [
      { header: "Session", align: "left", width: 18 },
      { header: "Runs", align: "right", width: 5 },
      { header: "Ollama In", align: "right", width: 11 },
      { header: "Ollama Out", align: "right", width: 11 },
      { header: "Counterfact.*", align: "right", width: 13 },
      { header: "PM O/H†", align: "right", width: 10 },
      { header: "Net Savings", align: "right", width: 12 },
    ],
    groups.map((g) => [
      truncate(g.sessionId ?? UNATTRIBUTED, 18),
      String(g.runCount),
      formatTokens(g.ollamaInput), formatTokens(g.ollamaOutput),
      formatUsd(g.counterfactual), formatUsd(g.pmOverhead),
      g.attributed ? formatUsd(g.net) : "—",
    ])
  ));

  if (opts.byLabel) {
    console.log(`\n${bold("  By Label")}`);
    console.log(renderTable(
      [
        { header: "Label", align: "left", width: 16 },
        { header: "Runs", align: "right", width: 6 },
        { header: "Author In", align: "right", width: 11 },
        { header: "Author Out", align: "right", width: 11 },
        { header: "Review In", align: "right", width: 11 },
        { header: "Review Out", align: "right", width: 11 },
        // Run count rather than tokens: "which ticket burned failed attempts"
        // is the question, and two more token columns would not fit.
        { header: "Unver.", align: "right", width: 7 },
        { header: "Counterfact.*", align: "right", width: 13 },
      ],
      byLabelAgg.map((a) => [
        a.label ?? "(unlabelled)",
        String(a.runCount),
        formatTokens(a.authorInput), formatTokens(a.authorOutput),
        formatTokens(a.reviewInput), formatTokens(a.reviewOutput),
        String(a.unverifiedRunCount),
        formatUsd(valueAtClaudePricesCached(a.uncachedInput, a.cachedInput, a.authorOutput, opts.counterfactualModel)),
      ])
    ));
    // This table spans every run in the filtered ledger; the Totals block below
    // counts only sessions that could be attributed to a Claude session. So the
    // two counterfactual figures legitimately differ, and saying so beats
    // leaving a reader to find the gap themselves.
    if (unattributedRuns > 0) {
      console.log(renderFootnote(`By Label covers all ${totalRuns} run(s), including ${unattributedRuns} unattributed. The Totals counterfactual below counts attributed sessions only, so the two will not add up.`));
    }
  }

  console.log(`\n${bold("  Totals")}`);
  const totalsKv: [string, string][] = [
    ["Ollama tokens", `in=${formatTokens(totalIn)}  out=${formatTokens(totalOut)}`],
    ["Counterfactual* (attributed)", formatUsd(attributedGroups.length > 0 ? counterfactualAttributed : null)],
    ["PM overhead† (attributed)", formatUsd(attributedGroups.length > 0 ? pmAttributed : null)],
    ["Net savings (headline)", bold(formatUsd(netTotal))],
  ];
  if (totalReviewRuns > 0) {
    totalsKv.splice(1, 0, ["Review runs (excluded from counterfactual)",
      `${totalReviewRuns}  in=${formatTokens(totalReviewIn)}  out=${formatTokens(totalReviewOut)}`]);
  }
  if (totalBenchRuns > 0) {
    totalsKv.splice(1, 0, ["Benchmark runs (excluded from counterfactual)",
      `${totalBenchRuns}  in=${formatTokens(totalBenchIn)}  out=${formatTokens(totalBenchOut)}`]);
  }
  if (totalUnverifiedRuns > 0) {
    // Split rather than one number: a gate rejecting the work and a turn cap set
    // too low are different problems with different fixes, and the old single
    // count could not tell a reader which one they had.
    const kindParts = [
      totalByKind["turn-cap"] > 0 ? `turn cap ${totalByKind["turn-cap"]}` : null,
      totalByKind["verify-failed"] > 0 ? `verify failed ${totalByKind["verify-failed"]}` : null,
      totalByKind.other > 0 ? `unrecognized reason ${totalByKind.other}` : null,
    ].filter((x): x is string => x !== null);
    totalsKv.splice(1, 0, ["Authoring runs that did not succeed",
      `${totalUnverifiedRuns} (${kindParts.join(", ")})  in=${formatTokens(totalUnverifiedIn)}  out=${formatTokens(totalUnverifiedOut)}`]);
  }
  console.log(renderKV(totalsKv));

  console.log(renderFootnote(`Counterfactual (*) = ollama token volume valued at ${opts.counterfactualModel} prices. ollama and Claude tokenize differently, so this is a proxy for "what Claude authoring would have cost," not a measured figure.`));
  if (totalReviewRuns > 0) {
    console.log(renderFootnote(`Review rows (run_id starting with "review:") are excluded from the counterfactual (review is not authoring) but reported separately so no spend is hidden.`));
  }
  if (totalBenchRuns > 0) {
    console.log(renderFootnote(`Benchmark rows (run_id starting with "bench:") are excluded from the counterfactual (a benchmark sweep is an evaluation, not authoring — nobody would have paid Claude to generate benchmark completions across a model grid) but reported separately so no spend is hidden.`));
  }
  if (totalUnverifiedRuns > 0) {
    const failedShare = valueAtClaudePrices(totalUnverifiedIn, totalUnverifiedOut, opts.counterfactualModel);
    const sharePct = failedShare !== null && counterfactualAttributed > 0
      ? ` That is ${formatUsd(failedShare)} of the ${formatUsd(counterfactualAttributed)} counterfactual — ${Math.round(failedShare / counterfactualAttributed * 100)}% of the priced figure bought nothing.`
      : "";
    console.log(renderFootnote(`Authoring runs that did not succeed (hit the turn cap, or failed their verify command) are INCLUDED in the counterfactual — the tokens were really spent, and Claude would have paid for a wrong first try too — but reported separately so failed work is not hidden in the total. A run that CRASHED is not counted here and is not in the ledger at all — the bridge writes its row after the failure path has already returned (nhangen/claude-ceo#328), so its tokens are missing from every figure on this report.${sharePct}`));
  }
  if (opts.pmCost !== undefined) {
    console.log(renderFootnote(`PM overhead (†) = ${formatUsd(opts.pmCost)}, supplied by the caller as a measured figure (e.g. a subagent PM's cost from the subagent-bucket delta between two --spend runs). Net = Counterfactual − measured PM. The figure's accuracy is the caller's — the report does not verify it against transcripts.`));
  } else if (opts.pmTurnRange) {
    console.log(renderFootnote(`PM overhead (†) = Claude billed spend of turns ${opts.pmTurnRange.from ?? 1}..${opts.pmTurnRange.to ?? "end"} only — the delegation's orchestration turns. Net = Counterfactual − PM overhead; positive means delegation saved money. Subagent (auditor/explorer) cost is session-wide in v1 and is NOT included in a turn slice, so PM overhead here is a floor — and the net a best case.`));
  } else {
    console.log(renderFootnote(`PM overhead (†) = actual Claude billed spend of the WHOLE session(s) that ran the delegations (direct + subagents). Net = Counterfactual − PM overhead. For a per-task net, scope it to the delegation's turns with --pm-turns; otherwise unrelated session work inflates PM overhead and net reads negative.`));
  }
  // An in-transcript session whose turn slice selected no turns is a distinct
  // case from "no session" — don't let it hide behind the generic diagnostic.
  const emptySlice = opts.pmTurnRange
    ? groups.filter((g) => g.sessionId !== null && g.found && g.pmOverhead === null)
    : [];
  if (emptySlice.length > 0) {
    console.log(renderFootnote(`--pm-turns ${opts.pmTurnRange!.from ?? 1}..${opts.pmTurnRange!.to ?? "end"} selected no turns in ${emptySlice.map((g) => g.sessionId!.slice(0, 16)).join(", ")} (out of range for the session), so PM overhead is unknown and it's excluded from the net. Widen the range.`));
  }
  const genuinelyUnattributed = unattributedRuns - emptySlice.reduce((s, g) => s + g.runCount, 0);
  if (genuinelyUnattributed > 0) {
    console.log(renderFootnote(`${genuinelyUnattributed} run(s) excluded from the net headline: no Claude session could be attributed (null session_id, or the session isn't in the local transcripts).`));
  }
  if (!counterfactualPriced) {
    console.log(renderFootnote(`Counterfactual model "${opts.counterfactualModel}" has no entry in the price table, so counterfactual + net are unavailable. Pass --counterfactual-model with a known Claude model.`));
  }
  if (groups.some((g) => g.pmPartial)) {
    console.log(renderFootnote(`Some attributed sessions include turns on a model with no known pricing; their PM overhead is understated.`));
  }
  console.log("");
}
