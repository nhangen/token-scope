/**
 * `token-scope --providers --since 7d` report (#37).
 *
 * Per-harness/model usage with null token classes shown as "—". Cash spend
 * appears only where a source meters per request (OpenCode does; Anthropic
 * subscription does not — never manufactured). A class some events in the
 * group report and others omit is aggregated but marked partial: summing
 * known values while hiding the gaps would overstate measurement (#37 audit).
 */
import type { Collected, ProviderEvent, PartialReason, UnavailableReason, CollectorError } from "@/providers";
import { tsMs } from "@/providers/types";
import { assertSafeLabelValue, labelRejectionReason } from "@/fleet-contract";

const REDACTED = "[redacted]";

type LabelRejections = Record<"privacy" | "oversize_label", number>;

function screenLabel(value: string, rejections: LabelRejections): string {
  try {
    assertSafeLabelValue(value);
    return value;
  } catch (e) {
    const reason = labelRejectionReason(e);
    if (reason) {
      rejections[reason] += 1;
      return REDACTED;
    }
    throw e;
  }
}

export interface ProviderRow {
  harness: string;
  provider?: string;
  billingRoute: string;
  model: string | null;
  events: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  /** Events marked as retries of an earlier attempt. */
  retries: number;
  /** Events whose source token classes contradict or fail the schema. */
  malformedEvents: number;
  /** Events with incomplete class coverage or response attribution. */
  partialEvents: number;
  /** Aggregate fallback events from rollouts without per-response usage. */
  legacyCumulativeEvents: number;
  /** Summed measured cash charge for this row, where any source provides it. */
  cashUsd: number | null;
  /** Token classes where SOME events reported a value and others did not —
   * the aggregate sums what exists but is not fully measured. */
  partialClasses: string[];
  /** Distinct source files/db behind this row, sorted. Provenance (#37 AC). */
  provenance: string[];
  /** Event labels (model or provider, per event) withheld by the label screen (#126). */
  redactedLabels: number;
  labelRejections: LabelRejections;
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
  const groups = new Map<string, {
    harness: string;
    billingRoute: string;
    provider: string;
    model: string | null;
    events: ProviderEvent[];
    redactedLabels: number;
    labelRejections: LabelRejections;
  }>();
  for (const e of filtered) {
    const rejections: LabelRejections = { privacy: 0, oversize_label: 0 };
    const provider = screenLabel(e.modelProvider, rejections);
    const model = e.model === null ? null : screenLabel(e.model, rejections);
    const key = JSON.stringify([e.harness, e.billingRoute, provider, model]);
    const group = groups.get(key) ?? {
      harness: e.harness,
      billingRoute: e.billingRoute,
      provider,
      model,
      events: [],
      redactedLabels: 0,
      labelRejections: { privacy: 0, oversize_label: 0 },
    };
    group.events.push(e);
    group.redactedLabels += Number(provider !== e.modelProvider) + Number(model !== e.model);
    group.labelRejections.privacy += rejections.privacy;
    group.labelRejections.oversize_label += rejections.oversize_label;
    groups.set(key, group);
  }
  const rows: ProviderRow[] = [];
  for (const [, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const evs = group.events;
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
      harness: group.harness,
      provider: group.provider,
      billingRoute: group.billingRoute,
      model: group.model,
      events: evs.length,
      input: classes[0]![1].value,
      output: classes[1]![1].value,
      cacheRead: classes[2]![1].value,
      cacheWrite: classes[3]![1].value,
      reasoning: classes[4]![1].value,
      retries: evs.filter((e) => e.retryOf !== null).length,
      malformedEvents: evs.filter((e) => (e.malformed?.length ?? 0) > 0).length,
      partialEvents: evs.filter((e) => (e.partial?.length ?? 0) > 0).length,
      legacyCumulativeEvents: evs.filter((e) => e.usageSource === "legacy-cumulative").length,
      cashUsd: cashVals.length > 0 ? cashVals.reduce((a, v) => a + v, 0) : null,
      partialClasses,
      provenance: [...new Set(evs.map((e) => e.provenance))].sort(),
      redactedLabels: group.redactedLabels,
      labelRejections: group.labelRejections,
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
  /** Why each unavailable source could not be read, by harness (#174). */
  unavailableReasons: Record<string, UnavailableReason[]>;
  /** Error details for crashed collectors (#174). */
  collectorErrors: Record<string, CollectorError>;
  /** Files that were skipped or contained partial records, by harness. */
  partial: Record<string, number>;
  /** Why each partially-read source is partial, by harness (#125). */
  partialReasons: Record<string, PartialReason[]>;
  /** Events outside --since only because they carry no timestamp. */
  untimedExcluded: number;
  /** False for empty reports, skipped/partial files, untimed exclusions,
   * or malformed/incomplete observations. */
  measured: boolean;
  /** Source surfaces intentionally excluded rather than conflated. */
  unsupported: string[];
  /** Model/provider values withheld by the label screen from the rows (#126). */
  redactedLabels: number;
  labelRejections: LabelRejections;
}

const dash = (v: number | null): string => (v === null ? "—" : String(v));

const fmtCash = (v: number | null): string =>
  v === null ? "—" : `$${v.toFixed(2)}`;

export function renderProviderReport(
  rows: ProviderRow[],
  unavailable: string[],
  partial: Record<string, number> = {},
  unsupported: string[] = [],
  partialReasons: Record<string, PartialReason[]> = {},
  unavailableReasons: Record<string, UnavailableReason[]> = {},
): string {
  const lines: string[] = [];
  lines.push("provider usage by harness / provider / billing route / model");
  lines.push("");
  if (rows.length === 0) {
    lines.push("  (no timestamped provider events in range)");
  } else {
    lines.push(
      "harness        provider      route         model                      events   input       output     cache-r    cache-w    reasoning     cash     partial",
    );
    for (const r of rows) {
      lines.push(
        [
          r.harness.padEnd(14),
          (r.provider ?? "unknown").padEnd(13),
          r.billingRoute.padEnd(13),
          (r.model === null ? "—" : r.model.slice(0, 26)).padEnd(26),
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
  const malformed = rows.reduce((sum, row) => sum + row.malformedEvents, 0);
  const partialEvents = rows.reduce((sum, row) => sum + row.partialEvents, 0);
  const legacy = rows.reduce((sum, row) => sum + row.legacyCumulativeEvents, 0);
  if (malformed > 0 || partialEvents > 0 || legacy > 0) {
    const issues = [
      malformed > 0 ? `${malformed} malformed event(s)` : null,
      partialEvents > 0 ? `${partialEvents} partial event(s)` : null,
      legacy > 0 ? `${legacy} legacy aggregate event(s) without per-response attribution` : null,
    ].filter((issue): issue is string => issue !== null);
    lines.push(`measurement incomplete: ${issues.join(", ")}; reported values are source-recorded, not estimated`);
  } else {
    lines.push("all values measured from source records; no estimates");
  }
  const oversize = rows.reduce((sum, row) => sum + row.labelRejections.oversize_label, 0);
  const redacted = rows.reduce((sum, row) => sum + row.labelRejections.privacy, 0);
  if (oversize > 0) {
    lines.push(`${oversize} event label(s) redacted: oversize_label (length or control characters)`);
  }
  if (redacted > 0) {
    lines.push(`${redacted} event label(s) redacted: credential-shaped source values withheld`);
  }
  if (Object.keys(partial).length > 0) {
    const parts = Object.entries(partial).map(([h, n]) => {
      const reasons = partialReasons[h] ?? [];
      const suffix = reasons.length > 0 ? ` [${reasons.join(", ")}]` : "";
      return `${h}: ${n} affected file(s)${suffix}`;
    });
    lines.push(`partially read (${parts.join(", ")}); unreported volume unknown`);
  }
  if (unavailable.length > 0) {
    const parts = unavailable.map((u) => {
      const reasons = unavailableReasons[u] ?? [];
      const suffix = reasons.length > 0 ? ` [${reasons.join(", ")}]` : "";
      return `${u}${suffix}`;
    });
    lines.push(`unavailable sources (volume unknown, not zero): ${parts.join(", ")}`);
  }
  if (unsupported.length > 0) {
    lines.push(`unsupported sources (not ingested): ${unsupported.join(", ")}`);
  }
  return lines.join("\n");
}

export function providerReportJson(
  rows: ProviderRow[],
  unavailable: string[],
  partial: Record<string, number> = {},
  untimedExcluded = 0,
  unsupported: string[] = [],
  partialReasons: Record<string, PartialReason[]> = {},
  unavailableReasons: Record<string, UnavailableReason[]> = {},
  collectorErrors: Record<string, CollectorError> = {},
): ProviderReportJson {
  return {
    rows,
    unavailable,
    unavailableReasons,
    collectorErrors,
    partial,
    partialReasons,
    untimedExcluded,
    measured: rows.length > 0
      && !Object.values(partial).some((count) => count > 0)
      && untimedExcluded === 0
      && rows.every((row) => (
        row.malformedEvents === 0
        && row.partialEvents === 0
        && row.legacyCumulativeEvents === 0
      )),
    unsupported,
    redactedLabels: rows.reduce((sum, row) => sum + row.redactedLabels, 0),
    labelRejections: {
      privacy: rows.reduce((sum, row) => sum + (row.labelRejections.privacy), 0),
      oversize_label: rows.reduce((sum, row) => sum + (row.labelRejections.oversize_label), 0),
    },
  };
}
