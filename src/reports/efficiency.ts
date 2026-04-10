import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatUsd, bold, dim } from "@/format";
import { VERSION } from "@/version";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

const BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "1–5",   min: 1,  max: 5 },
  { label: "6–15",  min: 6,  max: 15 },
  { label: "16–30", min: 16, max: 30 },
  { label: "31–50", min: 31, max: 50 },
  { label: "51+",   min: 51, max: Infinity },
];

export function renderEfficiencyReport(reader: Reader, opts: Options): void {
  const sessions = reader.querySessions(opts.since, 100_000);

  const buckets = BUCKETS.map(({ label, min, max }) => {
    const inBucket = sessions.filter((s) => s.turnCount >= min && s.turnCount <= max);
    const totalCost = inBucket.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    const totalTurns = inBucket.reduce((s, r) => s + r.turnCount, 0);
    return {
      bucket: label,
      sessionCount: inBucket.length,
      avgTurns: inBucket.length > 0 ? totalTurns / inBucket.length : null,
      avgSessionCost: inBucket.length > 0 ? totalCost / inBucket.length : null,
      avgPerTurnCost: totalTurns > 0 ? totalCost / totalTurns : null,
    };
  });

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: VERSION },
      report: "efficiency", buckets,
    }, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log(`No sessions found in the last ${opts.sinceStr}.`);
    return;
  }

  console.log(renderHeader("token-scope — Session Efficiency"));
  console.log(renderKV([["Total Sessions", String(sessions.length)]]));

  console.log(`\n${bold("  Cost Per Turn by Session Length")} ${dim("(longer sessions accumulate more context, raising per-turn cost)")}`);
  console.log(renderTable(
    [
      { header: "Turn Bucket",       align: "left",  width: 12 },
      { header: "Sessions",          align: "right", width: 9 },
      { header: "Avg Turns",         align: "right", width: 10 },
      { header: "Avg Per-Turn Cost", align: "right", width: 18 },
      { header: "Avg Session Cost",  align: "right", width: 17 },
    ],
    buckets.map((b) => [
      b.bucket,
      String(b.sessionCount),
      b.avgTurns != null ? b.avgTurns.toFixed(1) : "—",
      b.avgPerTurnCost != null ? formatUsd(b.avgPerTurnCost) : "—",
      b.avgSessionCost != null ? formatUsd(b.avgSessionCost) : "—",
    ])
  ));

  console.log("");
}
