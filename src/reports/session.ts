import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, renderFootnote, formatTokens, formatUsd, formatPct, formatDuration, formatTimestamp, approx, truncate, bold, dim } from "@/format";
import { parseContentBlocks, resolveDominantTool, estimateThinkingTokens } from "@/parse";
import { VERSION } from "@/version";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderSessionView(reader: Reader, sessionId: string, json: boolean, sinceStr: string): void {
  const allSessions = reader.querySessions(0, 10000);
  const matching = allSessions.filter((s) => s.sessionId.startsWith(sessionId));

  if (matching.length === 0) {
    console.log(`No session found with ID starting with "${sessionId}".`);
    return;
  }
  if (matching.length > 1) {
    console.log(`Multiple sessions match "${sessionId}":`);
    matching.forEach((s) => console.log(`  ${s.sessionId.slice(0, 16)} — ${s.cwd ?? "(unknown)"}`));
    console.log("Use a longer prefix.");
    return;
  }

  const session = matching[0]!;
  const turns = reader.querySessionTurns(session.sessionId);

  if (turns.length === 0) {
    console.log(`Session "${sessionId}" has no valid turns.`);
    return;
  }

  const peakIdx = turns.reduce((max, t, i) => t.outputTokens > (turns[max]?.outputTokens ?? 0) ? i : max, 0);

  if (json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), token_scope_version: VERSION },
      report: "session", session,
      turns: turns.map((t, i) => {
        const blocks = parseContentBlocks(t.message);
        const { thinking, text } = getThinkingChars(blocks);
        return {
          turn: i + 1, timestamp: t.timestamp,
          dominantTool: resolveDominantTool(blocks),
          outputTokens: t.outputTokens, costUsd: t.costUsd, stopReason: t.stopReason,
          estimatedThinkingTokens: estimateThinkingTokens(thinking, text, t.outputTokens),
        };
      }),
    }, null, 2));
    return;
  }

  if (sinceStr !== "30d") {
    console.log(dim("  Note: --since is ignored for --session (a session is a fixed time range)."));
  }

  const startMs = turns[0]!.timestamp;
  const endMs = turns.at(-1)!.timestamp;

  console.log(renderHeader(`token-scope — Session: ${session.sessionId.slice(0, 16)}…`));
  console.log(renderKV([
    ["Project", session.cwd ?? "(unknown)"],
    ["Started", formatTimestamp(startMs)],
    ["Duration", formatDuration(endMs - startMs)],
    ["Turns", String(turns.length)],
    ["Total Output Tokens", formatTokens(session.outputTokens)],
    ["Total Cost", formatUsd(session.totalCostUsd)],
    ["Peak Turn", `Turn ${peakIdx + 1} (${formatTokens(turns[peakIdx]!.outputTokens)} tokens)`],
  ]));

  let cumulativeTokens = 0;
  let cumulativeCost = 0;

  const rows = turns.map((t, i) => {
    const blocks = parseContentBlocks(t.message);
    const { thinking, text } = getThinkingChars(blocks);
    const thinkingPct = thinking + text > 0 ? approx(formatPct((thinking / (thinking + text)) * 100)) : "—";
    cumulativeTokens += t.outputTokens;
    cumulativeCost += t.costUsd ?? 0;
    const row = [
      String(i + 1), formatTimestamp(t.timestamp), resolveDominantTool(blocks),
      thinkingPct, formatTokens(t.outputTokens), formatTokens(cumulativeTokens),
      formatUsd(t.costUsd), formatUsd(cumulativeCost), t.stopReason ?? "—",
    ];
    return i === peakIdx ? row.map(bold) : row;
  });

  console.log(`\n${bold("  Turn-by-Turn Breakdown")}`);
  console.log(renderTable(
    [
      { header: "#", align: "right", width: 4 },
      { header: "Timestamp", align: "left", width: 14 },
      { header: "Dominant Tool", align: "left", width: 16 },
      { header: "~Think Chars %", align: "right", width: 15 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Cumulative", align: "right", width: 12 },
      { header: "Cost", align: "right", width: 10 },
      { header: "Cumul. Cost", align: "right", width: 12 },
      { header: "Stop", align: "left", width: 10 },
    ],
    rows
  ));
  console.log(renderFootnote("~Think Chars % is a character ratio, not a token ratio (±15–30% error)."));
  console.log(renderFootnote("Peak turn (most output tokens) is shown in bold."));
  console.log("");
}

export function renderSessionsList(reader: Reader, opts: Options): void {
  const sessions = reader.querySessions(opts.since, opts.limit);

  if (opts.json) {
    const total = sessions.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: VERSION },
      report: "sessions",
      totals: { session_count: sessions.length, total_cost_usd: total, avg_session_cost_usd: sessions.length > 0 ? total / sessions.length : 0 },
      sessions: sessions.map((s) => ({
        session_id: s.sessionId, cwd: s.cwd, started_at: new Date(s.startedAt).toISOString(),
        duration_ms: s.durationMs, turn_count: s.turnCount, output_tokens: s.outputTokens,
        cache_hit_pct: s.cacheHitPct, total_cost_usd: s.totalCostUsd,
      })),
    }, null, 2));
    return;
  }

  console.log(renderHeader(`token-scope — Sessions  (last ${opts.sinceStr})`));
  console.log(renderTable(
    [
      { header: "Session ID", align: "left", width: 14 },
      { header: "Project", align: "left", width: 40 },
      { header: "Started", align: "left", width: 16 },
      { header: "Duration", align: "right", width: 10 },
      { header: "Turns", align: "right", width: 7 },
      { header: "Output Tokens", align: "right", width: 14 },
      { header: "Cache Hit%", align: "right", width: 10 },
      { header: "Cost", align: "right", width: 10 },
    ],
    sessions.map((s) => [
      s.sessionId.slice(0, 14), truncate(s.cwd ?? "(unknown)", 40), formatTimestamp(s.startedAt),
      formatDuration(s.durationMs), String(s.turnCount), formatTokens(s.outputTokens),
      formatPct(s.cacheHitPct), formatUsd(s.totalCostUsd),
    ])
  ));

  const totalCost = sessions.reduce((sum, s) => sum + (s.totalCostUsd ?? 0), 0);
  const avgCost = sessions.length > 0 ? totalCost / sessions.length : 0;
  console.log(dim(`\n  Showing ${sessions.length} sessions  |  Total cost: ${formatUsd(totalCost)}  |  Avg: ${formatUsd(avgCost)}`));
  console.log("");
}

function getThinkingChars(blocks: ReturnType<typeof parseContentBlocks>) {
  let thinking = 0, text = 0;
  for (const b of blocks) {
    if (b.type === "thinking") thinking += (b.thinking ?? "").length;
    else if (b.type === "text") text += (b.text ?? "").length;
  }
  return { thinking, text };
}
