import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatPct, bold, dim, renderFootnote } from "@/format";
import { VERSION } from "@/version";
import { analyzeCacheEconomics } from "@/cache-economics";
import type { CacheEconomicsAnalysis, GapHistogramBucket } from "@/cache-economics";

interface Options {
  since: number;
  sinceStr: string;
  limit: number;
  json: boolean;
  focus?: "all" | "misses" | "sim";
}

function renderBar(pct: number, maxBar = 24): string {
  if (pct <= 0) return "";
  const len = Math.max(1, Math.round((pct / 100) * maxBar));
  return "█".repeat(len);
}

export function renderCacheReport(reader: Reader, opts: Options): void {
  const rows = reader.queryCacheStats(opts.since, opts.limit);
  const { mainTurns, subagentTurns, subagentsSupported } = reader.queryCacheTurns(opts.since);
  const analysis = analyzeCacheEconomics({
    mainTurns,
    subagentTurns,
    sinceSec: opts.since,
    nowMs: Date.now(),
  });

  const focus = opts.focus ?? "all";
  const showMisses = focus === "all" || focus === "misses";
  const showSim = focus === "all" || focus === "sim";

  if (opts.json) {
    const totalSavings = rows.reduce((s, r) => s + (r.estimatedSavingsUsd ?? 0), 0);
    console.log(JSON.stringify({
      meta: {
        generated_at: new Date().toISOString(),
        since: opts.since,
        limit: opts.limit,
        token_scope_version: VERSION,
      },
      report: focus === "misses" ? "cache-misses" : focus === "sim" ? "cache-sim" : "cache",
      summary: {
        projects: rows.length,
        subagents_supported: subagentsSupported,
        overall_cache_hit_pct: analysis.correctedHitPct,
        legacy_read_share_pct: analysis.legacyHitPct,
        estimated_total_savings_usd: totalSavings > 0 ? totalSavings : null,
        total_expiry_extra_cost_usd: analysis.misses.totalExpiryExtraCostUsd,
        total_subagent_expiry_extra_cost_usd: analysis.subagentMisses.totalExpiryExtraCostUsd,
        total_invalidation_extra_cost_usd: analysis.misses.totalInvalidationExtraCostUsd,
        total_subagent_invalidation_extra_cost_usd: analysis.subagentMisses.totalInvalidationExtraCostUsd,
        unpriced_turns: analysis.unpriced.turns,
        unpriced_models: analysis.unpriced.models,
      },
      token_mix: analysis.tokenMix,
      cost_mix: analysis.costMix,
      rows,
      ...(showMisses
        ? { misses: analysis.misses, subagent_misses: analysis.subagentMisses, gap_histogram: analysis.gapHistogram }
        : {}),
      ...(showSim ? { simulations: analysis.simulations } : {}),
      reconciliation: analysis.reconciliation,
    }, null, 2));
    return;
  }

  if (rows.length === 0 && mainTurns.length === 0 && subagentTurns.length === 0) {
    console.log(`No cache data found in the last ${opts.sinceStr}.`);
    return;
  }

  const totalSavings = rows.reduce((s, r) => s + (r.estimatedSavingsUsd ?? 0), 0);

  if (showMisses) {
    console.log(renderHeader("token-scope — Cache Economics & Efficiency"));
    console.log(renderKV([
      ["Projects", String(rows.length)],
      ["Overall Cache Hit %", `${formatPct(analysis.correctedHitPct)} ${dim("(read / (read + write + input))")}`],
      ["Read Share (non-write)", `${formatPct(analysis.legacyHitPct)} ${dim("(legacy read / (read + input))")}`],
      ["Est. Total Savings", formatUsd(totalSavings > 0 ? totalSavings : null)],
      ["Rebuild Miss Cost", formatUsd(
        analysis.misses.totalExpiryExtraCostUsd + analysis.subagentMisses.totalExpiryExtraCostUsd +
        analysis.misses.totalInvalidationExtraCostUsd + analysis.subagentMisses.totalInvalidationExtraCostUsd
      )],
      ...(analysis.reconciliation.turns > 0
        ? [["Reader vs Tier-Priced", `${formatUsd(analysis.reconciliation.readerCostUsd)} vs ${formatUsd(analysis.reconciliation.tokenPricedCostUsd)} ${dim(`(Δ ${formatUsd(analysis.reconciliation.deltaUsd)})`)}`] as [string, string]]
        : []),
    ]));

    console.log(`\n${bold("  Input Token & Cost Mix")}`);
    console.log(renderTable(
      [
        { header: "Category", align: "left", width: 16 },
        { header: "Tokens", align: "right", width: 14 },
        { header: "Token %", align: "right", width: 9 },
        { header: "Cost ($)", align: "right", width: 11 },
        { header: "Cost %", align: "right", width: 8 },
        { header: "Credits", align: "right", width: 14 },
        { header: "Credits %", align: "right", width: 10 },
      ],
      [
        [
          "Cache Read",
          formatTokens(analysis.tokenMix.cacheReadTokens),
          formatPct(analysis.tokenMix.cacheReadPct),
          formatUsd(analysis.costMix.cacheReadCostUsd),
          formatPct(analysis.costMix.cacheReadCostPct),
          formatTokens(analysis.costMix.cacheReadCredits),
          formatPct(analysis.costMix.cacheReadCreditsPct),
        ],
        [
          "Cache Write",
          formatTokens(analysis.tokenMix.cacheWriteTokens),
          formatPct(analysis.tokenMix.cacheWritePct),
          formatUsd(analysis.costMix.cacheWriteCostUsd),
          formatPct(analysis.costMix.cacheWriteCostPct),
          formatTokens(analysis.costMix.cacheWriteCredits),
          formatPct(analysis.costMix.cacheWriteCreditsPct),
        ],
        [
          "Uncached Input",
          formatTokens(analysis.tokenMix.uncachedInputTokens),
          formatPct(analysis.tokenMix.uncachedInputPct),
          formatUsd(analysis.costMix.uncachedInputCostUsd),
          formatPct(analysis.costMix.uncachedInputCostPct),
          formatTokens(analysis.costMix.uncachedInputCredits),
          formatPct(analysis.costMix.uncachedInputCreditsPct),
        ],
      ]
    ));

    console.log(`\n${bold("  By Project")}`);
    console.log(renderTable(
      [
        { header: "Project", align: "left", width: 28 },
        { header: "Sessions", align: "right", width: 9 },
        { header: "Turns", align: "right", width: 7 },
        { header: "Cache Hit %", align: "right", width: 12 },
        { header: "Read Share", align: "right", width: 12 },
        { header: "Cache Reads", align: "right", width: 13 },
        { header: "Est. Savings", align: "right", width: 13 },
      ],
      rows.map((r) => [
        r.cwd.split("/").at(-1) ?? r.cwd,
        String(r.sessions),
        String(r.turns),
        formatPct(r.cacheHitPct),
        formatPct(r.readSharePct),
        formatTokens(r.totalCacheReadTokens),
        formatUsd(r.estimatedSavingsUsd),
      ])
    ));

    console.log(`\n${bold("  Miss Classification & Extra Rebuild Costs")}`);
    console.log(renderTable(
      [
        { header: "Loop", align: "left", width: 14 },
        { header: "Classification", align: "left", width: 16 },
        { header: "Requests", align: "right", width: 10 },
        { header: "Extra Cost", align: "right", width: 12 },
        { header: "Note", align: "left", width: 36 },
      ],
      [
        ["Main session", "Expiry (>1h gap)", String(analysis.misses.expiries), formatUsd(analysis.misses.totalExpiryExtraCostUsd), "Idle pause exceeded 1h TTL; cache rebuilt"],
        ["Main session", "Growth (no gap)", String(analysis.misses.growths), formatUsd(0), "Normal incremental context expansion"],
        ["Main session", "Invalidation", String(analysis.misses.invalidations), formatUsd(analysis.misses.totalInvalidationExtraCostUsd), "Prefix invalidated (model/prompt change)"],
        ["Main session", "Cold initial", String(analysis.misses.colds), formatUsd(0), "Session start / first request"],
        ...subagentRows(analysis, subagentsSupported),
      ]
    ));

    console.log(`\n${bold("  Request Gap Distribution (Main Loop)")}`);
    console.log(renderGapHistogramTable(analysis.gapHistogram.buckets));
  }

  if (showSim) {
    if (focus === "sim") {
      console.log(renderHeader("token-scope — Cache Savings Simulations"));
    } else {
      console.log(`\n${bold("  What Would Have Saved (Simulations)")}`);
    }

    const simRows: string[][] = [];
    const descriptions: string[] = [];
    for (let i = 0; i < analysis.simulations.length; i++) {
      const s = analysis.simulations[i]!;
      if (s.policyId === "actual_baseline") continue;
      simRows.push([
        String(simRows.length + 1),
        s.title,
        s.weeklySavingsUsd > 0
          ? `~$${s.weeklySavingsUsd.toFixed(2)}/wk`
          : s.weeklySavingsUsd < 0 ? `+$${(-s.weeklySavingsUsd).toFixed(2)}/wk cost` : "$0.00/wk",
        s.weeklySavingsCredits > 0
          ? `~${formatTokens(Math.round(s.weeklySavingsCredits))}/wk`
          : s.weeklySavingsCredits < 0 ? `+${formatTokens(Math.round(-s.weeklySavingsCredits))}/wk` : "0/wk",
        formatUsd(s.simulatedTotalCostUsd),
      ]);
      descriptions.push(`  ${bold(String(simRows.length) + ". " + s.title)}\n` + s.assumptions.map((a) => `     • ${a}`).join("\n"));
    }

    if (simRows.length > 0) {
      console.log(renderTable(
        [
          { header: "#", align: "right", width: 3 },
          { header: "Policy Change", align: "left", width: 44 },
          { header: "Est. Savings/Wk", align: "right", width: 16 },
          { header: "Credits Saved", align: "right", width: 15 },
          { header: "Simulated Cost", align: "right", width: 14 },
        ],
        simRows
      ));
      console.log(`\n${bold("  Simulation Assumptions & Details:")}`);
      console.log(descriptions.join("\n\n"));
    } else {
      console.log("  No alternative policies found with measurable delta.");
    }
  }

  if (analysis.unpriced.turns > 0) {
    console.log(renderFootnote(`${analysis.unpriced.turns} turns on unpriced models (${analysis.unpriced.models.join(", ")}) are excluded from every dollar figure.`));
  }
  console.log(renderFootnote("Corrected hit rate accounts for cache writes (misses). Rebuild cost (expiry + invalidation) reflects rebuilding the prefix at write price instead of read price."));
  console.log("");
}

function subagentRows(analysis: CacheEconomicsAnalysis, supported: boolean): string[][] {
  const s = analysis.subagentMisses;
  const rows: [string, number, number | null, string][] = [
    ["Cold starts", s.coldStarts, 0, "Subagent first turn (5m TTL)"],
    ["Expiry (>5m gap)", s.expiries, s.totalExpiryExtraCostUsd, "Subagent pause exceeded 5m TTL"],
    ["Growth (no gap)", s.growths, 0, "Subagent context growth"],
    ["Invalidation", s.invalidations, s.totalInvalidationExtraCostUsd, "Subagent prefix invalidated"],
  ];
  return rows.map(([label, count, cost, note]) =>
    supported
      ? ["Subagents", label, String(count), formatUsd(cost), note]
      : ["Subagents", label, "n/a", "n/a", "Source has no subagent transcripts"]
  );
}

function renderGapHistogramTable(buckets: GapHistogramBucket[]): string {
  const lines: string[] = [];
  const header = `  ${bold("Bucket".padEnd(12))} │ ${bold("Count".padStart(7))} │ ${bold("Share".padStart(7))} │ ${bold("Distribution")}`;
  const separator = `  ${"─".repeat(12)}─┼─${"─".repeat(7)}─┼─${"─".repeat(7)}─┼─${"─".repeat(30)}`;
  lines.push(header, separator);

  for (const b of buckets) {
    const row = `  ${b.label.padEnd(12)} │ ${String(b.count).padStart(7)} │ ${formatPct(b.pct).padStart(7)} │ ${renderBar(b.pct)}`;
    lines.push(row);

    if (b.label === "1m – 5m") {
      lines.push(dim(`  ─────────────── 5m TTL (subagents / 5m policy / overage) ───────────────`));
    } else if (b.label === "30m – 60m") {
      lines.push(dim(`  ─────────────── 1h TTL (default main-session policy) ───────────────────`));
    }
  }

  return lines.join("\n");
}
