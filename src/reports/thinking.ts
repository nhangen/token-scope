import type { Database } from "bun:sqlite";
import { queryThinkingTurns, querySummaryTotals, querySessions } from "@/db";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatUsd, formatPct, formatTimestamp, approx, bold, dim } from "@/format";
import { estimateThinkingTokens, parseContentBlocks, resolveDominantTool } from "@/parse";

interface Options { since: number; limit: number; json: boolean }

export function renderThinkingReport(db: Database, opts: Options): void {
  const thinkingTurns = queryThinkingTurns(db, opts.since);
  const totals = querySummaryTotals(db, opts.since);
  const allSessions = querySessions(db, opts.since, 10000);

  const sessionIdsWithThinking = new Set(thinkingTurns.map((t) => t.sessionId));
  const sessionsWithThinking = allSessions.filter((s) => sessionIdsWithThinking.has(s.sessionId));
  const sessionsWithout = allSessions.filter((s) => !sessionIdsWithThinking.has(s.sessionId));

  let totalEstThinking = 0;
  let totalThinkingChars = 0;
  let totalTextChars = 0;

  const enriched = thinkingTurns.map((t) => {
    const est = estimateThinkingTokens(t.thinkingChars, t.textChars, t.outputTokens) ?? 0;
    totalEstThinking += est;
    totalThinkingChars += t.thinkingChars;
    totalTextChars += t.textChars;
    return { ...t, estimatedThinkingTokens: est, dominantTool: resolveDominantTool(parseContentBlocks(t.message)) };
  });

  const thinkingPctOfOutput = totals.totalOutputTokens > 0 ? (totalEstThinking / totals.totalOutputTokens) * 100 : 0;

  const byTool = new Map<string, { turns: number; estThinking: number }>();
  for (const t of enriched) {
    const e = byTool.get(t.dominantTool) ?? { turns: 0, estThinking: 0 };
    byTool.set(t.dominantTool, { turns: e.turns + 1, estThinking: e.estThinking + t.estimatedThinkingTokens });
  }

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "thinking",
      overview: {
        estimated_thinking_tokens: totalEstThinking,
        thinking_pct_of_output: thinkingPctOfOutput,
        turns_with_thinking: thinkingTurns.length,
        turns_with_thinking_pct: totals.turnCount > 0 ? (thinkingTurns.length / totals.turnCount) * 100 : 0,
        sessions_with_thinking: sessionsWithThinking.length,
      },
      character_distribution: {
        thinking_chars: totalThinkingChars, text_chars: totalTextChars,
        thinking_char_pct: totalThinkingChars + totalTextChars > 0 ? (totalThinkingChars / (totalThinkingChars + totalTextChars)) * 100 : 0,
        estimated_thinking_tokens: totalEstThinking,
      },
    }, null, 2));
    return;
  }

  console.log(renderHeader("token-scope — Thinking Analysis"));
  console.log(renderKV([
    ["~Total Thinking Tokens (est)", approx(formatTokens(totalEstThinking))],
    ["~Thinking % of Output", approx(formatPct(thinkingPctOfOutput))],
    ["Turns with Thinking", `${thinkingTurns.length} (${formatPct(totals.turnCount > 0 ? thinkingTurns.length / totals.turnCount * 100 : 0)} of all turns)`],
    ["Sessions with Thinking", `${sessionsWithThinking.length} (${formatPct(allSessions.length > 0 ? sessionsWithThinking.length / allSessions.length * 100 : 0)})`],
  ]));
  console.log(renderFootnote("Thinking token counts are character-ratio estimates (±15–30% error). Prefixed with ~ throughout."));

  const totalChars = totalThinkingChars + totalTextChars;
  if (totalChars > 0) {
    console.log(`\n${bold("  Content Character Distribution")} ${dim("(character proxy, not a token split)")}`);
    console.log(renderTable(
      [
        { header: "Content Block Type", align: "left", width: 20 },
        { header: "Total Characters", align: "right", width: 18 },
        { header: "Char %", align: "right", width: 8 },
        { header: "~Token Estimate", align: "right", width: 16 },
      ],
      [
        ["thinking", formatTokens(totalThinkingChars), formatPct(totalThinkingChars / totalChars * 100), approx(formatTokens(totalEstThinking))],
        ["text", formatTokens(totalTextChars), formatPct(totalTextChars / totalChars * 100), approx(formatTokens(totals.totalOutputTokens - totalEstThinking))],
      ]
    ));
    console.log(renderFootnote("tool_use block JSON contributes to output_tokens but is excluded from this panel."));
  }

  const toolRows = Array.from(byTool.entries()).sort((a, b) => b[1].estThinking - a[1].estThinking).slice(0, opts.limit);
  if (toolRows.length > 0) {
    console.log(`\n${bold("  By Co-occurring Tool")}`);
    console.log(renderTable(
      [
        { header: "Co-occurring Tool", align: "left", width: 20 },
        { header: "Thinking Turns", align: "right", width: 15 },
        { header: "~Avg Thinking Tokens", align: "right", width: 21 },
        { header: "~Total Thinking Tokens", align: "right", width: 22 },
      ],
      toolRows.map(([tool, d]) => [tool, String(d.turns), approx(formatTokens(d.estThinking / d.turns)), approx(formatTokens(d.estThinking))])
    ));
  }

  const avgOutput = (ss: typeof allSessions) => ss.length > 0 ? ss.reduce((s, r) => s + r.outputTokens, 0) / ss.length : 0;
  const avgCost = (ss: typeof allSessions) => ss.length > 0 ? ss.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0) / ss.length : 0;
  const avgTurns = (ss: typeof allSessions) => ss.length > 0 ? ss.reduce((s, r) => s + r.turnCount, 0) / ss.length : 0;

  console.log(`\n${bold("  Session Comparison")}`);
  console.log(renderTable(
    [
      { header: "Metric", align: "left", width: 22 },
      { header: "Thinking Sessions", align: "right", width: 19 },
      { header: "Non-Thinking Sessions", align: "right", width: 22 },
    ],
    [
      ["Count", String(sessionsWithThinking.length), String(sessionsWithout.length)],
      ["Avg Output Tokens", formatTokens(avgOutput(sessionsWithThinking)), formatTokens(avgOutput(sessionsWithout))],
      ["Avg Cost", formatUsd(avgCost(sessionsWithThinking)), formatUsd(avgCost(sessionsWithout))],
      ["Avg Turns", String(Math.round(avgTurns(sessionsWithThinking))), String(Math.round(avgTurns(sessionsWithout)))],
    ]
  ));

  const top10 = [...enriched].sort((a, b) => b.estimatedThinkingTokens - a.estimatedThinkingTokens).slice(0, 10);
  if (top10.length > 0) {
    console.log(`\n${bold("  Top Thinking Turns")}`);
    console.log(renderTable(
      [
        { header: "Session", align: "left", width: 12 },
        { header: "Project", align: "left", width: 25 },
        { header: "Timestamp", align: "left", width: 16 },
        { header: "~Thinking Tokens", align: "right", width: 17 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Cost", align: "right", width: 10 },
      ],
      top10.map((t) => [
        t.sessionId.slice(0, 12), (t.cwd ?? "(unknown)").split("/").at(-1) ?? "(unknown)",
        formatTimestamp(t.timestamp), approx(formatTokens(t.estimatedThinkingTokens)),
        formatTokens(t.outputTokens), formatUsd(t.costUsd),
      ])
    ));
  }

  console.log("");
}
