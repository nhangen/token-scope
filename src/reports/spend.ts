import type { Reader, TurnRow, SubagentSpend } from "@/reader";
import {
  renderHeader, renderKV, renderTable, renderFootnote,
  formatTokens, formatUsd, formatTimestamp, truncate, dim, bold,
} from "@/format";
import { VERSION } from "@/version";

interface SpendOptions {
  sessionId?: string;
  turnRange?: { from?: number; to?: number };
  since: number;
  sinceStr: string;
  json: boolean;
}

interface Bucket {
  output: number; input: number; cacheRead: number; cacheWrite: number;
  cost: number | null; costPartial: boolean;
}

/** Sums token types + cost across turns; cost skips unknown-model (null) turns. */
function sumTurns(turns: TurnRow[]): Bucket {
  let output = 0, input = 0, cacheRead = 0, cacheWrite = 0;
  let cost = 0, anyKnown = false, anyNull = false;
  for (const t of turns) {
    output += t.outputTokens; input += t.inputTokens;
    cacheRead += t.cacheReadTokens; cacheWrite += t.cacheWriteTokens;
    if (t.costUsd === null) anyNull = true;
    else { cost += t.costUsd; anyKnown = true; }
  }
  return { output, input, cacheRead, cacheWrite, cost: anyKnown ? cost : null, costPartial: anyNull };
}

/** Null-aware addition: null + null = null; otherwise treats null as 0. */
function addCost(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

export function renderSpendReport(reader: Reader, opts: SpendOptions): void {
  // Resolve the session: explicit --session (prefix match) or most-recent
  // within the --since window.
  let session;
  if (opts.sessionId) {
    const matching = reader.querySessions(0, 100000).filter((s) => s.sessionId.startsWith(opts.sessionId!));
    if (matching.length === 0) { console.log(`No session found with ID starting with "${opts.sessionId}".`); return; }
    if (matching.length > 1) {
      console.log(`Multiple sessions match "${opts.sessionId}":`);
      matching.forEach((s) => console.log(`  ${s.sessionId.slice(0, 16)} — ${s.cwd ?? "(unknown)"}`));
      console.log("Use a longer prefix.");
      return;
    }
    session = matching[0]!;
  } else {
    const candidates = reader.querySessions(opts.since, 100000);
    if (candidates.length === 0) { console.log(`No sessions found in the last ${opts.sinceStr}.`); return; }
    session = candidates.reduce((latest, s) => (s.startedAt > latest.startedAt ? s : latest));
  }

  const allTurns = reader.querySessionTurns(session.sessionId);
  if (allTurns.length === 0) { console.log(`Session "${session.sessionId.slice(0, 16)}" has no valid turns.`); return; }

  // Slice by 1-indexed turn range (task isolation). Turn numbers reference the
  // full session order so they match `--session` output.
  const from = opts.turnRange?.from ?? 1;
  const to = Math.min(opts.turnRange?.to ?? allTurns.length, allTurns.length);
  const indexed = allTurns.map((t, i) => ({ turnNo: i + 1, t }));
  let selected = indexed.filter((x) => x.turnNo >= from && x.turnNo <= to);

  // --since acts as a within-session timestamp floor, but only when explicitly
  // set (the 30d default must not silently truncate an older target session).
  const sinceFloorApplied = opts.sinceStr !== "30d";
  if (sinceFloorApplied) {
    const cutoffMs = opts.since * 1000;
    selected = selected.filter((x) => x.t.timestamp > cutoffMs);
  }

  const directTurns = selected.map((x) => x.t);
  const direct = sumTurns(directTurns);
  const sub: SubagentSpend = reader.querySubagentSpend(session.sessionId);

  const combined: Bucket = {
    output: direct.output + (sub.supported ? sub.outputTokens : 0),
    input: direct.input + (sub.supported ? sub.inputTokens : 0),
    cacheRead: direct.cacheRead + (sub.supported ? sub.cacheReadTokens : 0),
    cacheWrite: direct.cacheWrite + (sub.supported ? sub.cacheWriteTokens : 0),
    cost: sub.supported ? addCost(direct.cost, sub.costUsd) : direct.cost,
    costPartial: direct.costPartial || (sub.supported && sub.costPartial),
  };

  const rangeLabel = opts.turnRange
    ? `${from}..${opts.turnRange.to ?? allTurns.length}`
    : `1..${allTurns.length} (all)`;

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), token_scope_version: VERSION },
      report: "spend",
      session: { session_id: session.sessionId, cwd: session.cwd, turn_count_total: allTurns.length },
      turn_range: opts.turnRange ? { from, to: opts.turnRange.to ?? allTurns.length } : null,
      since_floor_applied: sinceFloorApplied,
      turns: selected.map((x) => ({
        turn: x.turnNo, timestamp: x.t.timestamp, model: x.t.model,
        output: x.t.outputTokens, input: x.t.inputTokens,
        cache_read: x.t.cacheReadTokens, cache_write: x.t.cacheWriteTokens,
        cost_usd: x.t.costUsd,
      })),
      totals: {
        direct: {
          turns: directTurns.length, output: direct.output, input: direct.input,
          cache_read: direct.cacheRead, cache_write: direct.cacheWrite,
          cost_usd: direct.cost, cost_partial: direct.costPartial,
        },
        subagent: {
          supported: sub.supported, session_wide: true, agent_count: sub.agentCount,
          output: sub.outputTokens, input: sub.inputTokens,
          cache_read: sub.cacheReadTokens, cache_write: sub.cacheWriteTokens,
          cost_usd: sub.costUsd, cost_partial: sub.costPartial,
        },
        combined: {
          output: combined.output, input: combined.input,
          cache_read: combined.cacheRead, cache_write: combined.cacheWrite,
          cost_usd: combined.cost, cost_partial: combined.costPartial,
        },
      },
    }, null, 2));
    return;
  }

  console.log(renderHeader(`token-scope — Spend: ${session.sessionId.slice(0, 16)}…`));
  console.log(renderKV([
    ["Project", session.cwd ?? "(unknown)"],
    ["Turn range", rangeLabel],
    ["Turns shown", `${directTurns.length} of ${allTurns.length}`],
    ["Since floor", sinceFloorApplied ? `> ${opts.sinceStr}` : "none (whole session)"],
  ]));

  console.log(`\n${bold("  Per-Turn Spend (Claude, billed)")}`);
  console.log(renderTable(
    [
      { header: "#", align: "right", width: 5 },
      { header: "Timestamp", align: "left", width: 14 },
      { header: "Model", align: "left", width: 22 },
      { header: "Output", align: "right", width: 10 },
      { header: "Input", align: "right", width: 9 },
      { header: "Cache Rd", align: "right", width: 11 },
      { header: "Cache Wr", align: "right", width: 11 },
      { header: "Cost", align: "right", width: 10 },
    ],
    selected.map((x) => [
      String(x.turnNo), formatTimestamp(x.t.timestamp), truncate(x.t.model ?? "—", 22),
      formatTokens(x.t.outputTokens), formatTokens(x.t.inputTokens),
      formatTokens(x.t.cacheReadTokens), formatTokens(x.t.cacheWriteTokens),
      formatUsd(x.t.costUsd),
    ])
  ));

  const subLabel = sub.supported
    ? `Subagent (session-wide, ${sub.agentCount} agent${sub.agentCount === 1 ? "" : "s"})`
    : "Subagent";
  console.log(`\n${bold("  Totals (Claude, billed)")}`);
  console.log(renderTable(
    [
      { header: "Bucket", align: "left", width: 34 },
      { header: "Output", align: "right", width: 10 },
      { header: "Input", align: "right", width: 9 },
      { header: "Cache Rd", align: "right", width: 11 },
      { header: "Cache Wr", align: "right", width: 11 },
      { header: "Cost", align: "right", width: 10 },
    ],
    [
      ["Direct (this range)", formatTokens(direct.output), formatTokens(direct.input), formatTokens(direct.cacheRead), formatTokens(direct.cacheWrite), formatUsd(direct.cost)],
      sub.supported
        ? [subLabel, formatTokens(sub.outputTokens), formatTokens(sub.inputTokens), formatTokens(sub.cacheReadTokens), formatTokens(sub.cacheWriteTokens), formatUsd(sub.costUsd)]
        : [subLabel, "—", "—", "—", "—", "—"],
      ["Combined", formatTokens(combined.output), formatTokens(combined.input), formatTokens(combined.cacheRead), formatTokens(combined.cacheWrite), formatUsd(combined.cost)].map(bold),
    ]
  ));

  if (!sub.supported) {
    console.log(renderFootnote("Subagent attribution needs the JSONL source (run with --source jsonl); unavailable on sqlite."));
  } else {
    console.log(renderFootnote("Subagent total is session-wide (v1), not scoped to the turn range."));
  }
  if (combined.costPartial) {
    console.log(renderFootnote("Some turns used a model with no known pricing; their tokens are counted but cost is excluded."));
  }
  console.log(renderFootnote("Cost is Claude billed spend. Local (ollama) authoring runs off-transcript and is not counted here."));
  console.log("");
}
