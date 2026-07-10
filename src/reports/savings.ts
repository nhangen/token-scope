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
  models: string[];
  counterfactual: number | null;
  pmOverhead: number | null;
  pmPartial: boolean;
  net: number | null;
  attributed: boolean;
  found: boolean;
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
    const counterfactual = valueAtClaudePrices(ollamaInput, ollamaOutput, opts.counterfactualModel);

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
      runCount: groupRuns.length, ollamaInput, ollamaOutput, models,
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
  const attributedGroups = groups.filter((g) => g.attributed);
  const netTotal = attributedGroups.length > 0
    ? attributedGroups.reduce((s, g) => s + (g.net ?? 0), 0) : null;
  const counterfactualAttributed = attributedGroups.reduce((s, g) => s + (g.counterfactual ?? 0), 0);
  const pmAttributed = attributedGroups.reduce((s, g) => s + (g.pmOverhead ?? 0), 0);
  const unattributedRuns = groups.filter((g) => !g.attributed).reduce((s, g) => s + g.runCount, 0);

  if (opts.json) {
    console.log(JSON.stringify({
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
      sessions: groups.map((g) => ({
        session_id: g.sessionId, cwd: g.cwd, run_count: g.runCount,
        ollama_input: g.ollamaInput, ollama_output: g.ollamaOutput, models: g.models,
        counterfactual_usd: g.counterfactual, pm_overhead_usd: g.pmOverhead,
        pm_overhead_partial: g.pmPartial, net_savings_usd: g.net, attributed: g.attributed,
      })),
      totals: {
        run_count: totalRuns, ollama_input: totalIn, ollama_output: totalOut,
        counterfactual_usd: attributedGroups.length > 0 ? counterfactualAttributed : null,
        pm_overhead_usd: attributedGroups.length > 0 ? pmAttributed : null,
        net_savings_usd: netTotal,
        attributed_session_count: attributedGroups.length,
        unattributed_run_count: unattributedRuns,
      },
    }, null, 2));
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

  console.log(`\n${bold("  Totals")}`);
  console.log(renderKV([
    ["Ollama tokens", `in=${formatTokens(totalIn)}  out=${formatTokens(totalOut)}`],
    ["Counterfactual* (attributed)", formatUsd(attributedGroups.length > 0 ? counterfactualAttributed : null)],
    ["PM overhead† (attributed)", formatUsd(attributedGroups.length > 0 ? pmAttributed : null)],
    ["Net savings (headline)", bold(formatUsd(netTotal))],
  ]));

  console.log(renderFootnote(`Counterfactual (*) = ollama token volume valued at ${opts.counterfactualModel} prices. ollama and Claude tokenize differently, so this is a proxy for "what Claude authoring would have cost," not a measured figure.`));
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
