// Respects NO_COLOR env var per https://no-color.org/
const USE_COLOR = !process.env["NO_COLOR"] && process.stdout.isTTY;

function ansi(code: string, text: string): string {
  if (!USE_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const bold  = (s: string) => ansi("1",  s);
export const dim   = (s: string) => ansi("2",  s);

/** Formats an integer with thousands separators: 1204389 → "1,204,389" */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** Formats a USD value. dp=4 for tables, dp=2 for weekly trend. */
export function formatUsd(n: number | null | undefined, dp = 4): string {
  if (n == null) return "—";
  return `$${n.toFixed(dp)}`;
}

/** Formats a percentage to 1dp. */
export function formatPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}

/** Formats a duration in milliseconds as HH:MM:SS. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

/** Formats a Unix ms timestamp to a human-readable local datetime. */
export function formatTimestamp(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/** Prefixes a non-"—" string with "~" to signal approximation. */
export function approx(s: string): string {
  return s === "—" ? "—" : `~${s}`;
}

/** Truncates a string to maxLen chars, appending "…" if truncated. */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

export interface Column {
  header: string;
  align?: "left" | "right";
  width?: number;
}

/**
 * Renders an ASCII table with headers and separator.
 * Auto-calculates column widths from content if width not specified.
 * Strips ANSI codes for width calculation so colored cells pad correctly.
 */
export function renderTable(columns: Column[], rows: string[][]): string {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  const widths = columns.map((col, i) => {
    const contentMax = Math.max(0, ...rows.map((r) => stripAnsi(r[i] ?? "").length));
    return col.width ?? Math.max(stripAnsi(col.header).length, contentMax);
  });

  const pad = (s: string, w: number, align: "left" | "right" = "left") => {
    const visible = stripAnsi(s).length;
    const padding = Math.max(0, w - visible);
    return align === "right" ? " ".repeat(padding) + s : s + " ".repeat(padding);
  };

  const separator = widths.map((w) => "─".repeat(w)).join("─┼─");
  const header = widths
    .map((w, i) => pad(bold(columns[i]!.header), w))
    .join(" │ ");
  const rowLines = rows.map((row) =>
    widths.map((w, i) => pad(row[i] ?? "", w, columns[i]?.align ?? "left")).join(" │ ")
  );

  return [header, separator, ...rowLines].join("\n");
}

/** Renders key-value pairs: label (padded) + value */
export function renderKV(pairs: Array<[string, string]>, labelWidth = 28): string {
  return pairs.map(([label, value]) => `  ${dim(label.padEnd(labelWidth))} ${value}`).join("\n");
}

/** Renders a section header with top/bottom border lines. */
export function renderHeader(title: string): string {
  const line = "─".repeat(60);
  return `\n${line}\n${bold(title)}\n${line}`;
}

/** Renders a dim footnote prefixed with asterisk. */
export function renderFootnote(text: string): string {
  return `\n${dim(`  * ${text}`)}`;
}

