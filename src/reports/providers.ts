/**
 * `token-scope --providers --since 7d` report (#37).
 *
 * Per-harness/model usage with null token classes shown as "—". Cash spend
 * appears only for metered routes; subscription/local routes surface volume
 * and (where the source provides it) allowance utilization — no manufactured
 * per-request cash cost.
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
}

const sum = (vals: Array<number | null>): number | null =>
  vals.every((v) => v === null)
    ? null
    : vals.reduce<number>((a, v) => a + (v ?? 0), 0);

export interface ProviderReportJson {
  rows: ProviderRow[];
  unavailable: string[];
  /** Every number above is read from source records; nothing is estimated. */
  measured: true;
}

export function providerRows(collected: Collected, sinceMs?: number): ProviderRow[] {
  const filtered = sinceMs
    ? collected.events.filter((e) => e.ts && Date.parse(e.ts) >= sinceMs)
    : collected.events.filter((e) => e.ts);
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
    rows.push({
      harness,
      billingRoute,
      model,
      events: evs.length,
      input: sum(evs.map((e) => e.inputTokens)),
      output: sum(evs.map((e) => e.outputTokens)),
      cacheRead: sum(evs.map((e) => e.cacheReadTokens)),
      cacheWrite: sum(evs.map((e) => e.cacheWriteTokens)),
      reasoning: sum(evs.map((e) => e.reasoningTokens)),
      retries: evs.filter((e) => e.retryOf !== null).length,
    });
  }
  return rows;
}

const dash = (v: number | null): string => (v === null ? "—" : String(v));

export function renderProviderReport(
  rows: ProviderRow[],
  unavailable: string[],
): string {
  const lines: string[] = [];
  lines.push("provider usage by harness / billing route / model");
  lines.push("");
  if (rows.length === 0) {
    lines.push("  (no timestamped provider events in range)");
  } else {
    lines.push(
      "harness        route         model                      events   input       output     cache-r    cache-w    reasoning   retry  cash-usd",
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
          String(r.retries).padStart(6),
          dash(null).padStart(9), // cash charge: no source meters per request yet
        ].join("  "),
      );
    }
    lines.push("");
    lines.push("all values measured from source records; no estimates");
  }
  if (unavailable.length > 0) {
    lines.push("");
    lines.push(`unavailable sources (volume unknown, not zero): ${unavailable.join(", ")}`);
  }
  return lines.join("\n");
}

export function providerReportJson(
  rows: ProviderRow[],
  unavailable: string[],
): ProviderReportJson {
  return { rows, unavailable, measured: true };
}
