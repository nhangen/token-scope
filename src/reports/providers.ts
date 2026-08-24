/**
 * `token-scope --providers --since 7d` report (#37).
 *
 * Per-harness/model usage with null token classes shown as "—". Cash spend
 * appears only where a source meters per request (OpenCode does; Anthropic
 * subscription does not — never manufactured). A class some events in the
 * group report and others omit is aggregated but marked partial: summing
 * known values while hiding the gaps would overstate measurement (#37 audit).
 */
import type { Collected, ProviderEvent } from "@/providers";

export interface ProviderRow {
  harness: string;
  billingRoute: string;
  model: string;
  events: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  /** Events marked as retries of an earlier attempt. */
  retries: number;
  /** Summed measured cash charge for this row, where any source provides it. */
  cashUsd: number | null;
  /** Token classes where SOME events reported a value and others did not —
   * the aggregate sums what exists but is not fully measured. */
  partialClasses: string[];
  /** Distinct source files/db behind this row, sorted. Provenance (#37 AC). */
  provenance: string[];
}

interface ClassAgg {
  value: number | null;
  complete: boolean;
}

function agg(vals: Array<number | null>): ClassAgg {
  const known = vals.filter((v): v is number => v !== null);
  if (known.length === 0) return { value: null, complete: true };
  return {
    value: known.reduce((a, v) => a + v, 0),
    complete: known.length === vals.length,
  };
}

/** Milliseconds for an event's timestamp, or null when it cannot be dated
 * (absent or unparseable). Single source of truth for "cannot be placed in
 * the window" — the --since filter and untimedExcluded() must not drift (#42). */
function tsMs(e: ProviderEvent): number | null {
  if (!e.ts) return null;
  const ms = Date.parse(e.ts);
  return Number.isNaN(ms) ? null : ms;
}

export function providerRows(collected: Collected, sinceMs?: number): ProviderRow[] {
  // No window: keep everything, including timestamp-less events. With a
  // window there is no honest place to put an undated event — count them
  // via untimedExcluded() so the loss is visible instead of silent.
  const filtered = sinceMs
    ? collected.events.filter((e) => {
        const ms = tsMs(e);
        return ms !== null && ms >= sinceMs;
      })
    : collected.events;
  const groups = new Map<string, ProviderEvent[]>();
  for (const e of filtered) {
    const key = `${e.harness}|${e.billingRoute}|${e.modelProvider}|${e.model}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const rows: ProviderRow[] = [];
  for (const [key, evs] of [...groups.entries()].sort()) {
    const parts = key.split("|");
    const harness = parts[0] ?? "";
    const billingRoute = parts[1] ?? "unknown";
    const model = parts[3] ?? parts[2] ?? "unknown";
    const classes: Array<[string, ClassAgg]> = [
      ["input", agg(evs.map((e) => e.inputTokens))],
      ["output", agg(evs.map((e) => e.outputTokens))],
      ["cacheRead", agg(evs.map((e) => e.cacheReadTokens))],
      ["cacheWrite", agg(evs.map((e) => e.cacheWriteTokens))],
      ["reasoning", agg(evs.map((e) => e.reasoningTokens))],
    ];
    const partialClasses = classes
      .filter(([, a]) => !a.complete)
      .map(([n]) => n);
    const cashVals = evs
      .map((e) => e.cashChargeUsd)
      .filter((v): v is number => v !== null);
    rows.push({
      harness,
      billingRoute,
      model,
      events: evs.length,
      input: classes[0]![1].value,
      output: classes[1]![1].value,
      cacheRead: classes[2]![1].value,
      cacheWrite: classes[3]![1].value,
      reasoning: classes[4]![1].value,
      retries: evs.filter((e) => e.retryOf !== null).length,
      cashUsd: cashVals.length > 0 ? cashVals.reduce((a, v) => a + v, 0) : null,
      partialClasses,
      provenance: [...new Set(evs.map((e) => e.provenance))].sort(),
    });
  }
  return rows;
}

/** Events dropped by the --since window purely because they cannot be dated
 * (timestamp absent or unparseable). Without --since nothing is dropped —
 * untimed volume still counts. */
export function untimedExcluded(collected: Collected, sinceMs?: number): number {
  if (!sinceMs) return 0;
  return collected.events.filter((e) => tsMs(e) === null).length;
}

export interface ProviderReportJson {
  rows: ProviderRow[];
  unavailable: string[];
  /** Files that existed but failed to read, by harness. */
  partial: Record<string, number>;
  /** Events outside --since only because they carry no timestamp. */
  untimedExcluded: number;
  /** Every number above is read from source records; nothing is estimated. */
  measured: true;
}

const dash = (v: number | null): string => (v === null ? "—" : String(v));

const fmtCash = (v: number | null): string =>
  v === null ? "—" : `$${v.toFixed(2)}`;

export function renderProviderReport(
  rows: ProviderRow[],
  unavailable: string[],
  partial: Record<string, number> = {},
): string {
  const lines: string[] = [];
  lines.push("provider usage by harness / billing route / model");
  lines.push("");
  if (rows.length === 0) {
    lines.push("  (no timestamped provider events in range)");
  } else {
    lines.push(
      "harness        route         model                      events   input       output     cache-r    cache-w    reasoning     cash     partial",
    );
    for (const r of rows) {
      lines.push(
        [
          r.harness.padEnd(14),
          r.billingRoute.padEnd(13),
          r.model.slice(0, 26).padEnd(26),
          String(r.events).padStart(6),
          dash(r.input).padStart(11),
          dash(r.output).padStart(10),
          dash(r.cacheRead).padStart(10),
          dash(r.cacheWrite).padStart(10),
          dash(r.reasoning).padStart(10),
          fmtCash(r.cashUsd).padStart(9),
          (r.partialClasses.length > 0 ? r.partialClasses.join(",") : "—").padStart(10),
        ].join("  "),
      );
    }
    lines.push("");
    lines.push('partial: token classes some events in the group do not report — sums cover reported events only');
  }
  lines.push("");
  lines.push("all values measured from source records; no estimates");
  if (Object.keys(partial).length > 0) {
    const parts = Object.entries(partial).map(([h, n]) => `${h}: ${n} file(s) skipped`);
    lines.push(`partially read (${parts.join(", ")}) — skipped volume unknown`);
  }
  if (unavailable.length > 0) {
    lines.push(`unavailable sources (volume unknown, not zero): ${unavailable.join(", ")}`);
  }
  return lines.join("\n");
}

export function providerReportJson(
  rows: ProviderRow[],
  unavailable: string[],
  partial: Record<string, number> = {},
  untimedExcluded = 0,
): ProviderReportJson {
  return { rows, unavailable, partial, untimedExcluded, measured: true };
}
