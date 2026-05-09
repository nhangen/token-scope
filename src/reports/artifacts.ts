import type { Reader } from "@/reader";
import { analyzeArtifacts } from "@/artifacts";
import type { ArtifactFormat } from "@/artifacts";
import { renderHeader, renderKV, renderTable, formatUsd, bold, dim, truncate, formatTokens } from "@/format";
import { VERSION } from "@/version";

interface Options {
  since: number;
  sinceStr: string;
  limit: number;
  json: boolean;
  format?: ArtifactFormat | "all";
  pathFragment?: string;
}

export function renderArtifactsReport(reader: Reader, opts: Options): void {
  const turns = reader.queryRawTurnsForArtifact(opts.since);
  const analysis = analyzeArtifacts(turns);

  let rows = analysis.byArtifact;
  if (opts.format && opts.format !== "all") {
    rows = rows.filter((a) => a.format === opts.format);
  }
  if (opts.pathFragment) {
    const frag = opts.pathFragment.toLowerCase();
    rows = rows.filter((a) => a.path.toLowerCase().includes(frag));
  }

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: VERSION },
      report: "artifacts",
      summary: analysis.summary,
      byArtifact: rows.slice(0, opts.limit),
    }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(
      opts.format && opts.format !== "all"
        ? `No artifacts of format "${opts.format}" found in the last ${opts.sinceStr}.`
        : `No Write/Edit/NotebookEdit calls found in the last ${opts.sinceStr}.`
    );
    return;
  }

  console.log(renderHeader("token-scope — Artifact Cost Analysis"));
  console.log(renderKV([
    ["Distinct Artifacts", String(analysis.summary.distinctArtifacts)],
    ["Total Writes/Edits", String(analysis.summary.totalWrites)],
    ["Total Attributed Cost", formatUsd(analysis.summary.totalCost)],
    ["Window", opts.sinceStr],
  ]));

  console.log(`\n${bold("  Cost by Format")}`);
  console.log(renderTable(
    [
      { header: "Format", align: "left", width: 10 },
      { header: "Artifacts", align: "right", width: 10 },
      { header: "Cost", align: "right", width: 14 },
      { header: "Avg/Artifact", align: "right", width: 14 },
    ],
    analysis.summary.formats.map((f) => [
      f.format,
      String(f.artifacts),
      formatUsd(f.cost),
      formatUsd(f.cost != null && f.artifacts > 0 ? f.cost / f.artifacts : null),
    ])
  ));

  const heading = opts.format && opts.format !== "all"
    ? `Top Artifacts (format: ${opts.format})`
    : "Top Artifacts by Cost";

  console.log(`\n${bold(`  ${heading}`)}`);
  console.log(renderTable(
    [
      { header: "Path", align: "left", width: 56 },
      { header: "Fmt", align: "left", width: 5 },
      { header: "Edits", align: "right", width: 6 },
      { header: "Cost", align: "right", width: 12 },
      { header: "Output Tok", align: "right", width: 12 },
    ],
    rows.slice(0, opts.limit).map((a) => [
      truncate(a.path, 56),
      a.format,
      String(a.edits),
      formatUsd(a.attributedCost),
      formatTokens(a.outputTokens),
    ])
  ));

  if (!analysis.summary.costKnown && rows.length > 0) {
    console.log(`\n${dim("  * Costs unknown for these turns — sorted by output tokens.")}`);
  }
  console.log(`\n${dim("  * Cost is attributed proportionally by tool-input payload size per turn.")}`);
  console.log(`${dim("  * Edits = distinct turns containing a Write/Edit on this path. Multiple writes")}`);
  console.log(`${dim("    in one turn count as one edit.")}\n`);
}

export function renderArtifactShowReport(
  reader: Reader,
  path: string,
  opts: Options
): void {
  const turns = reader.queryRawTurnsForArtifact(opts.since);
  const analysis = analyzeArtifacts(turns);
  const target = analysis.byArtifact.find((a) => a.path === path);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, token_scope_version: VERSION },
      report: "artifacts.show",
      path,
      found: target != null,
      artifact: target ?? null,
    }, null, 2));
    return;
  }

  if (!target) {
    console.log(`No writes for "${path}" in the last ${opts.sinceStr}.`);
    return;
  }

  console.log(renderHeader(`token-scope — Artifact: ${truncate(target.path, 50)}`));
  console.log(renderKV([
    ["Path", target.path],
    ["Format", target.format],
    ["Edits", String(target.edits)],
    ["Sessions", String(target.sessions)],
    ["First Seen", target.firstSeen > 0 ? new Date(target.firstSeen * 1000).toISOString() : "—"],
    ["Last Seen", target.lastSeen > 0 ? new Date(target.lastSeen * 1000).toISOString() : "—"],
    ["Total Cost", formatUsd(target.attributedCost)],
    ["Output Tokens", formatTokens(target.outputTokens)],
    ["Avg Cost/Edit", formatUsd(target.attributedCost != null && target.edits > 0 ? target.attributedCost / target.edits : null)],
  ]));
  console.log("");
}

export function renderArtifactCompareReport(
  reader: Reader,
  mdPath: string,
  opts: Options
): void {
  if (!mdPath.endsWith(".md")) {
    console.log(`Error: --artifact-compare expects a .md path. Got: ${mdPath}`);
    process.exitCode = 1;
    return;
  }

  // Derive the sibling HTML path: <dir>/artifacts/<slug>.html
  const lastSlash = mdPath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? mdPath.slice(0, lastSlash) : ".";
  const file = lastSlash >= 0 ? mdPath.slice(lastSlash + 1) : mdPath;
  const slug = file.replace(/\.md$/, "");
  const htmlPath = `${dir}/artifacts/${slug}.html`;

  const turns = reader.queryRawTurnsForArtifact(opts.since);
  const analysis = analyzeArtifacts(turns);
  const md = analysis.byArtifact.find((a) => a.path === mdPath);
  const html = analysis.byArtifact.find((a) => a.path === htmlPath);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, token_scope_version: VERSION },
      report: "artifacts.compare",
      md: { path: mdPath, found: md != null, artifact: md ?? null },
      html: { path: htmlPath, found: html != null, artifact: html ?? null },
    }, null, 2));
    return;
  }

  console.log(renderHeader("token-scope — Artifact MD vs HTML Comparison"));
  console.log(renderKV([
    ["MD Path", mdPath],
    ["HTML Path", htmlPath],
  ]));

  console.log(renderTable(
    [
      { header: "Metric", align: "left", width: 20 },
      { header: "MD", align: "right", width: 14 },
      { header: "HTML", align: "right", width: 14 },
      { header: "HTML / MD", align: "right", width: 12 },
    ],
    [
      ["Edits", String(md?.edits ?? 0), String(html?.edits ?? 0), ratio(html?.edits, md?.edits)],
      ["Cost", formatUsd(md?.attributedCost), formatUsd(html?.attributedCost), ratio(html?.attributedCost, md?.attributedCost)],
      ["Output Tokens", formatTokens(md?.outputTokens), formatTokens(html?.outputTokens), ratio(html?.outputTokens, md?.outputTokens)],
      ["Sessions", String(md?.sessions ?? 0), String(html?.sessions ?? 0), "—"],
    ]
  ));

  if (!md && !html) {
    console.log(`\n${dim("  Neither file has been written in the last " + opts.sinceStr + ".")}`);
  } else if (!html) {
    console.log(`\n${dim("  HTML render not yet captured. Run `/render-html " + mdPath + "` to generate one.")}`);
  } else if (!md) {
    console.log(`\n${dim("  Source MD not in window — only the HTML render is recent.")}`);
  }
  console.log("");
}

function ratio(num?: number | null, denom?: number | null): string {
  if (num == null || denom == null || !denom) return "—";
  return `${(num / denom).toFixed(2)}×`;
}
