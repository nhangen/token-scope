import type { Reader } from "@/reader";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatTimestamp, bold } from "@/format";

interface Options { since: number; sinceStr: string; limit: number; json: boolean }

export function renderProjectDrillDown(reader: Reader, fragment: string, opts: Options): void {
  const matches = reader.queryProjectMatches(fragment);

  if (matches.length === 0) {
    console.log(`No projects found matching "${fragment}".`);
    return;
  }

  if (matches.length > 1) {
    console.log(`Multiple projects match "${fragment}":`);
    matches.forEach((m, i) => console.log(`  ${i + 1}. ${m.cwd}`));
    console.log("Re-run with a more specific fragment.");
    return;
  }

  const cwd = matches[0]!.cwd;
  const allProjects = reader.queryByProject(opts.since, 1000);
  const project = allProjects.find((p) => p.cwd === cwd);

  if (!project) {
    console.log(`No data for project "${cwd}" in the last ${opts.sinceStr}.`);
    return;
  }

  const sessions = reader.querySessions(opts.since, 1000).filter((s) => s.cwd === cwd).slice(0, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, limit: opts.limit, token_scope_version: "1.0.0" },
      report: "project", cwd, project, sessions,
    }, null, 2));
    return;
  }

  console.log(renderHeader(`token-scope — Project: ${cwd}`));
  console.log(renderKV([
    ["Sessions", String(project.sessions)],
    ["Turns", String(project.turns)],
    ["Output Tokens", formatTokens(project.outputTokens)],
    ["Total Cost", formatUsd(project.totalCostUsd)],
    ["Avg Session Cost", formatUsd(project.avgSessionCost)],
  ]));

  if (sessions.length > 0) {
    console.log(`\n${bold("  Recent Sessions")}`);
    console.log(renderTable(
      [
        { header: "Session ID", align: "left", width: 12 },
        { header: "Started", align: "left", width: 18 },
        { header: "Turns", align: "right", width: 7 },
        { header: "Output Tokens", align: "right", width: 14 },
        { header: "Cost", align: "right", width: 10 },
      ],
      sessions.map((s) => [s.sessionId.slice(0, 12), formatTimestamp(s.startedAt), String(s.turnCount), formatTokens(s.outputTokens), formatUsd(s.totalCostUsd)])
    ));
  }

  console.log("");
}
