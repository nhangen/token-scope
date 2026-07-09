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

/** Actual Claude billed spend for a session: direct turns + subagent rollup.
 *  `found` is false when the session isn't present in the transcripts. */
function sessionBilledSpend(reader: Reader, sessionId: string): { cost: number | null; partial: boolean; found: boolean } {
  const turns = reader.querySessionTurns(sessionId);
  if (turns.length === 0) return { cost: null, partial: false, found: false };
  let cost = 0, anyKnown = false, anyNull = false;
  for (const t of turns) {
    if (t.costUsd === null) anyNull = true;
    else { cost += t.costUsd; anyKnown = true; }
  }
  let total: number | null = anyKnown ? cost : null;
  let partial = anyNull;
  const sub = reader.querySubagentSpend(sessionId);
  if (sub.supported) {
    if (sub.costUsd !== null) total = (total ?? 0) + sub.costUsd;
    partial = partial || sub.costPartial;
  }
  return { cost: total, partial, found: true };
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
    if (sessionId !== null) {
      const billed = sessionBilledSpend(reader, sessionId);
      pmOverhead = billed.cost; pmPartial = billed.partial; found = billed.found;
    }
    // A group is attributed only when we have BOTH sides of the subtraction.
    const attributed = found && counterfactual !== null && pmOverhead !== null;
    const net = attributed ? counterfactual! - pmOverhead! : null;

    groups.push({
      sessionId, cwd: groupRuns.find((r) => r.cwd !== null)?.cwd ?? null,
      runCount: groupRuns.length, ollamaInput, ollamaOutput, models,
      counterfactual, pmOverhead, pmPartial, net, attributed,
    });
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
  console.log(renderFootnote(`PM overhead (†) = actual Claude billed spend of the session(s) that ran the delegations. Net = Counterfactual − PM overhead; positive means delegation saved money.`));
  if (unattributedRuns > 0) {
    console.log(renderFootnote(`${unattributedRuns} run(s) excluded from the net headline: no Claude session could be attributed (null session_id, or the session isn't in the local transcripts).`));
  }
  if (!counterfactualPriced) {
    console.log(renderFootnote(`Counterfactual model "${opts.counterfactualModel}" has no entry in the price table, so counterfactual + net are unavailable. Pass --counterfactual-model with a known Claude model.`));
  }
  if (groups.some((g) => g.pmPartial)) {
    console.log(renderFootnote(`Some attributed sessions include turns on a model with no known pricing; their PM overhead is understated.`));
  }
  console.log("");
}
