import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { renderHeader, renderKV, renderTable, formatTokens, formatUsd, formatPct, bold, dim, renderFootnote } from "@/format";
import { computeTurnCost } from "@/pricing";
import { resolveDbPath } from "@/db";
import { VERSION } from "@/version";

const EXPECTED_SCHEMA = 1;
const PRE_WINDOW = 5;
const POST_WINDOW = 5;
const QUALITY_RX = /\b(as i said|like i said|as mentioned|we were|i told you|previously|earlier you|continue with|where were we|already (said|mentioned|told))\b/i;

export type Section = "tuning" | "reclamation" | "patterns" | "roi" | "all";

interface Options { since: number; sinceStr: string; limit: number; json: boolean; sections: Section[] }

interface Fire {
  id: number;
  sessionId: string;
  cwd: string | null;
  firedAt: number;
  level: "advisory" | "escalated";
  fillPct: number;
  inputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  windowSize: number;
  model: string | null;
  assistantUuid: string;
}

interface Outcome {
  fireEventId: number;
  acted: 0 | 1;
  detectedAt: number | null;
  preFillPct: number;
  postFillPct: number | null;
  tokensReclaimed: number | null;
  turnsUntilAction: number | null;
  detectionMethod: string;
}

interface FireWithOutcome extends Fire { outcome: Outcome | null }

interface RoiRow {
  fireId: number;
  sessionId: string;
  cwd: string | null;
  level: "advisory" | "escalated";
  fillPctAtFire: number;
  acted: boolean;
  preAvgCostUsd: number | null;
  overheadUsd: number | null;
  postAvgCostUsd: number | null;
  netPerTurnUsd: number | null;
  turnsUsedPost: number;
  realizedSavingsUsd: number | null;
  roi: number | null;
}

interface AssistantTurn {
  uuid: string;
  ts: number;
  model: string | null;
  output: number;
  input: number;
  cacheRead: number;
  cacheCreate: number;
  costUsd: number | null;
  stopReason: string | null;
  hasSubagentDispatch: boolean;
}

interface UserTurn { ts: number; text: string }

function defaultContextLoopDbPath(): string {
  return join(process.env["HOME"] ?? "~", ".claude", "context-loop.db");
}

function openContextLoopDb(): { db: Database; path: string } | { error: string } {
  const env = process.env["CONTEXT_LOOP_DB"];
  const path = env || defaultContextLoopDbPath();
  if (!existsSync(path)) return { error: `No context-loop database at ${path}. Run with the context-loop plugin installed to generate data.` };
  try {
    const db = new Database(path, { readonly: true });
    const v = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const found = v ? parseInt(v.value, 10) : 0;
    if (found !== EXPECTED_SCHEMA) {
      db.close();
      return { error: `context-loop schema version mismatch: token-scope expects ${EXPECTED_SCHEMA}, found ${found}. Update one of the plugins.` };
    }
    return { db, path };
  } catch (e) {
    return { error: `Failed to open context-loop database at ${path}: ${String(e)}` };
  }
}

function loadFiresWithOutcomes(db: Database, since: number): FireWithOutcome[] {
  return db.query<{
    id: number; session_id: string; cwd: string | null; fired_at: number;
    level: string; fill_pct: number; input_tokens: number; cache_read: number; cache_create: number;
    window_size: number; model: string | null; assistant_uuid: string;
    o_acted: number | null; o_detected_at: number | null; o_pre_fill: number | null; o_post_fill: number | null;
    o_reclaimed: number | null; o_turns: number | null; o_method: string | null;
  }, [number]>(`
    SELECT f.id, f.session_id, f.cwd, f.fired_at, f.level, f.fill_pct,
      f.input_tokens, f.cache_read, f.cache_create, f.window_size, f.model, f.assistant_uuid,
      o.acted AS o_acted, o.detected_at AS o_detected_at,
      o.pre_fill_pct AS o_pre_fill, o.post_fill_pct AS o_post_fill,
      o.tokens_reclaimed AS o_reclaimed, o.turns_until_action AS o_turns,
      o.detection_method AS o_method
    FROM fire_events f
    LEFT JOIN compaction_outcomes o ON o.fire_event_id = f.id
    WHERE f.fired_at >= ?
    ORDER BY f.fired_at ASC
  `).all(since).map((r) => ({
    id: r.id, sessionId: r.session_id, cwd: r.cwd, firedAt: r.fired_at,
    level: r.level as "advisory" | "escalated",
    fillPct: r.fill_pct, inputTokens: r.input_tokens, cacheRead: r.cache_read, cacheCreate: r.cache_create,
    windowSize: r.window_size, model: r.model, assistantUuid: r.assistant_uuid,
    outcome: r.o_acted == null ? null : {
      fireEventId: r.id,
      acted: r.o_acted as 0 | 1,
      detectedAt: r.o_detected_at,
      preFillPct: r.o_pre_fill ?? 0,
      postFillPct: r.o_post_fill,
      tokensReclaimed: r.o_reclaimed,
      turnsUntilAction: r.o_turns,
      detectionMethod: r.o_method ?? "",
    },
  }));
}

function loadSessionTurns(storeDb: Database, sessionId: string): AssistantTurn[] {
  return storeDb.query<{
    uuid: string; ts: number; model: string | null;
    out: number; inp: number; cr: number; cw: number; cost: number | null;
    stop: string | null; message: string;
  }, [string]>(`
    SELECT am.uuid, bm.timestamp AS ts, am.model,
      CAST(json_extract(am.message, '$.usage.output_tokens') AS INTEGER) AS out,
      CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER) AS inp,
      CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER) AS cr,
      CAST(json_extract(am.message, '$.usage.cache_creation_input_tokens') AS INTEGER) AS cw,
      am.cost_usd AS cost,
      json_extract(am.message, '$.stop_reason') AS stop,
      am.message
    FROM assistant_messages am
    JOIN base_messages bm ON am.uuid = bm.uuid
    WHERE bm.session_id = ? AND json_valid(am.message) = 1
    ORDER BY bm.timestamp ASC
  `).all(sessionId).map((r) => ({
    uuid: r.uuid, ts: r.ts, model: r.model,
    output: r.out ?? 0, input: r.inp ?? 0, cacheRead: r.cr ?? 0, cacheCreate: r.cw ?? 0,
    costUsd: r.cost ?? (r.model ? computeTurnCost(r.model, r.out ?? 0, r.inp ?? 0, r.cr ?? 0, r.cw ?? 0) : null),
    stopReason: r.stop,
    hasSubagentDispatch: r.message.includes('"name":"Task"') || r.message.includes('"name":"Agent"'),
  }));
}

function loadSessionUserTurns(storeDb: Database, sessionId: string): UserTurn[] {
  return storeDb.query<{ ts: number; message: string }, [string]>(`
    SELECT bm.timestamp AS ts, um.message
    FROM user_messages um
    JOIN base_messages bm ON um.uuid = bm.uuid
    WHERE bm.session_id = ? AND json_valid(um.message) = 1
    ORDER BY bm.timestamp ASC
  `).all(sessionId).map((r) => {
    let text = "";
    try {
      const m = JSON.parse(r.message) as { content?: unknown };
      if (typeof m.content === "string") text = m.content;
      else if (Array.isArray(m.content)) {
        for (const block of m.content as Array<Record<string, unknown>>) {
          if (block["type"] === "text" && typeof block["text"] === "string") text += block["text"] + " ";
        }
      }
    } catch { /* ignore */ }
    return { ts: r.ts, text };
  });
}

function computeRoi(fire: FireWithOutcome, turns: AssistantTurn[]): RoiRow {
  const idx = turns.findIndex((t) => t.uuid === fire.assistantUuid);
  const fireTs = fire.firedAt;

  // Pre window: 5 turns before the fire turn (excluding fire turn itself).
  let preStart: number, preEnd: number;
  if (idx >= 0) {
    preStart = Math.max(0, idx - PRE_WINDOW);
    preEnd = idx;
  } else {
    const upTo = turns.findIndex((t) => t.ts > fireTs);
    const cutoff = upTo === -1 ? turns.length : upTo;
    preStart = Math.max(0, cutoff - PRE_WINDOW);
    preEnd = cutoff;
  }
  const pre = turns.slice(preStart, preEnd).filter((t) => t.costUsd != null);
  const preAvg = pre.length ? pre.reduce((s, t) => s + (t.costUsd ?? 0), 0) / pre.length : null;

  // Post window: turns after fire.
  const postStartIdx = idx >= 0 ? idx + 1 : turns.findIndex((t) => t.ts > fireTs);
  const postStart = postStartIdx === -1 ? turns.length : postStartIdx;
  const post = turns.slice(postStart).filter((t) => t.costUsd != null).slice(0, POST_WINDOW + 1);
  const overhead = post.length > 0 ? post[0]!.costUsd : null;
  const postSteady = post.slice(1, POST_WINDOW + 1);
  const postAvg = postSteady.length ? postSteady.reduce((s, t) => s + (t.costUsd ?? 0), 0) / postSteady.length : null;

  const acted = !!(fire.outcome && fire.outcome.acted === 1);
  let net: number | null = null;
  let realized: number | null = null;
  let roi: number | null = null;
  if (acted && preAvg != null && postAvg != null) {
    net = preAvg - postAvg;
    const turnsUsedPost = postSteady.length;
    realized = (net * turnsUsedPost) - (overhead ?? 0);
    if (overhead && overhead > 0) roi = realized / overhead;
  }

  return {
    fireId: fire.id, sessionId: fire.sessionId, cwd: fire.cwd, level: fire.level,
    fillPctAtFire: fire.fillPct, acted,
    preAvgCostUsd: preAvg, overheadUsd: overhead, postAvgCostUsd: postAvg,
    netPerTurnUsd: net, turnsUsedPost: postSteady.length,
    realizedSavingsUsd: realized, roi,
  };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

// ─── Tier 1 ───────────────────────────────────────────────────────────────────

function renderHeadline(rois: RoiRow[]): void {
  const acted = rois.filter((r) => r.acted);
  const realized = acted.map((r) => r.realizedSavingsUsd).filter((v): v is number => v != null);
  const totalRealized = realized.reduce((s, v) => s + v, 0);
  const totalOverhead = acted.map((r) => r.overheadUsd ?? 0).reduce((s, v) => s + v, 0);
  const negativeRoi = acted.filter((r) => r.realizedSavingsUsd != null && r.realizedSavingsUsd < 0).length;

  console.log(renderKV([
    ["Fires recorded", String(rois.length)],
    ["Acted on (compaction detected)", `${acted.length} (${rois.length ? formatPct(acted.length / rois.length * 100) : "—"})`],
    ["Total realized savings", formatUsd(totalRealized, 2)],
    ["Total compaction overhead", formatUsd(totalOverhead, 2)],
    ["Net (savings − overhead)", formatUsd(totalRealized - totalOverhead, 2)],
    ["Negative-ROI fires", `${negativeRoi}${acted.length ? ` (${formatPct(negativeRoi / acted.length * 100)} of acted)` : ""}`],
  ]));
}

function renderThresholdCurve(rois: RoiRow[]): void {
  const buckets = new Map<string, RoiRow[]>();
  for (const r of rois) {
    const lo = Math.floor(r.fillPctAtFire * 20) / 20; // 5pp buckets
    const key = `${(lo * 100).toFixed(0)}–${((lo + 0.05) * 100).toFixed(0)}%`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  }
  console.log(`\n${bold("  Threshold Curve")} ${dim("(median realized savings per fill % bucket)")}`);
  console.log(renderTable(
    [
      { header: "Fill at fire", align: "left" },
      { header: "Fires", align: "right" },
      { header: "Acted %", align: "right" },
      { header: "Median realized", align: "right" },
      { header: "Median ROI", align: "right" },
    ],
    Array.from(buckets.entries()).sort().map(([k, rs]) => {
      const acted = rs.filter((r) => r.acted);
      const realized = acted.map((r) => r.realizedSavingsUsd).filter((v): v is number => v != null);
      const rois2 = acted.map((r) => r.roi).filter((v): v is number => v != null);
      return [k, String(rs.length),
        formatPct(rs.length ? acted.length / rs.length * 100 : 0),
        formatUsd(median(realized), 4),
        rois2.length ? median(rois2)!.toFixed(2) + "x" : "—"];
    })
  ));
}

function renderActedSplit(rois: RoiRow[]): void {
  const byLevel = new Map<string, { total: number; acted: number }>();
  for (const r of rois) {
    const e = byLevel.get(r.level) ?? { total: 0, acted: 0 };
    e.total++;
    if (r.acted) e.acted++;
    byLevel.set(r.level, e);
  }
  console.log(`\n${bold("  Acted vs Ignored — by tier")}`);
  console.log(renderTable(
    [{ header: "Level", align: "left" }, { header: "Fires", align: "right" }, { header: "Acted", align: "right" }, { header: "Action rate", align: "right" }],
    ["advisory", "escalated"].filter((l) => byLevel.has(l)).map((l) => {
      const e = byLevel.get(l)!;
      return [l, String(e.total), String(e.acted), formatPct(e.total ? e.acted / e.total * 100 : 0)];
    })
  ));
}

function renderTimeToAction(rois: RoiRow[]): void {
  const acted = rois.filter((r) => r.acted);
  const turns = acted.map((r) => r.turnsUsedPost);
  // turns_until_action stored on outcome; we don't have it here directly. Use turnsUntilAction from FWO instead.
  console.log(`\n${bold("  Time-to-action (post-fire turns until next assistant message)")}  ${dim("[" + (acted.length ? `n=${acted.length}` : "no acted fires") + "]")}`);
  if (!acted.length) return;
  const buckets: Record<string, number> = { "0 (immediate)": 0, "1–2": 0, "3–5": 0, "6–10": 0, "11+": 0 };
  for (const t of turns) {
    if (t === 0) buckets["0 (immediate)"]!++;
    else if (t <= 2) buckets["1–2"]!++;
    else if (t <= 5) buckets["3–5"]!++;
    else if (t <= 10) buckets["6–10"]!++;
    else buckets["11+"]!++;
  }
  console.log(renderTable(
    [{ header: "Turns post-fire used in window", align: "left" }, { header: "Fires", align: "right" }, { header: "Share", align: "right" }],
    Object.entries(buckets).map(([k, v]) => [k, String(v), formatPct(v / acted.length * 100)])
  ));
}

// ─── Tier 2 ───────────────────────────────────────────────────────────────────

function renderPerCwdRoi(rois: RoiRow[]): void {
  const byCwd = new Map<string, { total: number; acted: number; realized: number; overhead: number }>();
  for (const r of rois) {
    const k = r.cwd ?? "(unknown)";
    const e = byCwd.get(k) ?? { total: 0, acted: 0, realized: 0, overhead: 0 };
    e.total++;
    if (r.acted) e.acted++;
    e.realized += r.realizedSavingsUsd ?? 0;
    e.overhead += r.overheadUsd ?? 0;
    byCwd.set(k, e);
  }
  console.log(`\n${bold("  Per-project ROI")}`);
  console.log(renderTable(
    [{ header: "Project", align: "left" }, { header: "Fires", align: "right" }, { header: "Realized $", align: "right" }, { header: "Overhead $", align: "right" }, { header: "Net $", align: "right" }],
    Array.from(byCwd.entries())
      .map(([cwd, e]) => [cwd.replace(process.env["HOME"] ?? "", "~"), String(e.total), formatUsd(e.realized, 2), formatUsd(e.overhead, 2), formatUsd(e.realized - e.overhead, 2)] as [string, string, string, string, string])
      .sort((a, b) => parseFloat(b[4].replace(/[^-0-9.]/g, "") || "0") - parseFloat(a[4].replace(/[^-0-9.]/g, "") || "0"))
  ));
}

function renderNoFireBaseline(storeDb: Database, since: number, advisoryThreshold: number): void {
  const rows = storeDb.query<{
    sessionId: string; cwd: string | null; turnTs: number; uuid: string;
    inp: number; cr: number; cw: number; model: string | null;
  }, [number]>(`
    SELECT bm.session_id AS sessionId, bm.cwd, bm.timestamp AS turnTs, am.uuid,
      CAST(json_extract(am.message, '$.usage.input_tokens') AS INTEGER) AS inp,
      CAST(json_extract(am.message, '$.usage.cache_read_input_tokens') AS INTEGER) AS cr,
      CAST(json_extract(am.message, '$.usage.cache_creation_input_tokens') AS INTEGER) AS cw,
      am.model
    FROM assistant_messages am
    JOIN base_messages bm ON am.uuid = bm.uuid
    WHERE bm.timestamp >= ? AND json_valid(am.message) = 1
  `).all(since);

  // Find turns where total/window >= advisoryThreshold (best-effort: assume 200k window for this baseline)
  const window = 200_000;
  const candidates = rows.filter((r) => ((r.inp ?? 0) + (r.cr ?? 0) + (r.cw ?? 0)) / window >= advisoryThreshold);

  console.log(`\n${bold("  No-fire baseline")} ${dim("(turns hitting advisory fill but no recorded fire — counterfactual)")}`);
  console.log(renderKV([
    ["Candidate high-fill turns (≥" + (advisoryThreshold * 100).toFixed(0) + "% fill, 200k window)", String(candidates.length)],
    ["Note", "Filter against fired sessions to refine; v1 reports raw count"],
  ]));
}

function renderReclamationAttribution(storeDb: Database, fires: FireWithOutcome[]): void {
  const acted = fires.filter((f) => f.outcome?.acted === 1);
  if (!acted.length) {
    console.log(`\n${bold("  What got reclaimed")}  ${dim("(no acted fires in window)")}`);
    return;
  }
  const toolByFire = new Map<string, number>();
  for (const fire of acted) {
    const turns = storeDb.query<{ message: string; cw: number }, [string, number]>(`
      SELECT am.message,
        CAST(json_extract(am.message, '$.usage.cache_creation_input_tokens') AS INTEGER) AS cw
      FROM assistant_messages am
      JOIN base_messages bm ON am.uuid = bm.uuid
      WHERE bm.session_id = ? AND bm.timestamp <= ? AND json_valid(am.message) = 1
      ORDER BY bm.timestamp DESC LIMIT 5
    `).all(fire.sessionId, fire.firedAt);

    for (const t of turns) {
      const blocks = (() => {
        try { return (JSON.parse(t.message) as { content?: unknown }).content; } catch { return null; }
      })();
      let tool = "(text only)";
      if (Array.isArray(blocks)) {
        for (const b of blocks as Array<Record<string, unknown>>) {
          if (b["type"] === "tool_use" && typeof b["name"] === "string") { tool = b["name"] as string; break; }
        }
      }
      toolByFire.set(tool, (toolByFire.get(tool) ?? 0) + (t.cw ?? 0));
    }
  }
  const entries = Array.from(toolByFire.entries()).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  console.log(`\n${bold("  What got reclaimed")} ${dim("(tools contributing cache-writes in 5 turns before each acted fire)")}`);
  console.log(renderTable(
    [{ header: "Tool", align: "left" }, { header: "Cache-writes", align: "right" }, { header: "Share", align: "right" }],
    entries.slice(0, 10).map(([tool, cw]) => [tool, formatTokens(cw), formatPct(cw / total * 100)])
  ));
}

// ─── Tier 3 ───────────────────────────────────────────────────────────────────

function renderNthFire(rois: RoiRow[]): void {
  const bySession = new Map<string, RoiRow[]>();
  for (const r of rois) {
    const arr = bySession.get(r.sessionId) ?? [];
    arr.push(r);
    bySession.set(r.sessionId, arr);
  }
  const byNth: Record<number, number[]> = {};
  for (const [, arr] of bySession) {
    arr.forEach((r, i) => {
      if (!r.acted || r.realizedSavingsUsd == null) return;
      (byNth[i + 1] ??= []).push(r.realizedSavingsUsd);
    });
  }
  console.log(`\n${bold("  N-th fire diminishing returns (within session)")}`);
  console.log(renderTable(
    [{ header: "Fire ordinal", align: "left" }, { header: "Acted fires", align: "right" }, { header: "Median realized $", align: "right" }],
    Object.entries(byNth).slice(0, 5).map(([n, xs]) => [`#${n}`, String(xs.length), formatUsd(median(xs), 4)])
  ));
}

function renderQualityProxy(storeDb: Database, fires: FireWithOutcome[]): void {
  const acted = fires.filter((f) => f.outcome?.acted === 1);
  let flagged = 0;
  for (const fire of acted) {
    const us = loadSessionUserTurns(storeDb, fire.sessionId);
    const post = us.find((u) => u.ts > fire.firedAt);
    if (post && QUALITY_RX.test(post.text)) flagged++;
  }
  console.log(`\n${bold("  Compaction quality proxy")} ${dim("(does the next user message reference earlier context?)")}`);
  console.log(renderKV([
    ["Acted fires examined", String(acted.length)],
    ["User reasserted earlier context", `${flagged}${acted.length ? ` (${formatPct(flagged / acted.length * 100)})` : ""}`],
    ["Interpretation", "Lower is better — high values mean compaction lost continuity"],
  ]));
}

function renderTerminalState(storeDb: Database, since: number, fires: FireWithOutcome[]): void {
  const sessionsHitMax = storeDb.query<{ sessionId: string }, [number]>(`
    SELECT DISTINCT bm.session_id AS sessionId
    FROM assistant_messages am JOIN base_messages bm ON am.uuid = bm.uuid
    WHERE bm.timestamp >= ? AND json_extract(am.message, '$.stop_reason') = 'max_tokens'
  `).all(since);
  const firedSessions = new Set(fires.map((f) => f.sessionId));
  const overflowAndFired = sessionsHitMax.filter((s) => firedSessions.has(s.sessionId)).length;
  const overflowAndNotFired = sessionsHitMax.length - overflowAndFired;

  console.log(`\n${bold("  Session terminal-state correlation")} ${dim("(max_tokens stop_reason)")}`);
  console.log(renderKV([
    ["Sessions hitting max_tokens", String(sessionsHitMax.length)],
    ["  …with at least one fire", String(overflowAndFired)],
    ["  …with no fire (detection miss)", String(overflowAndNotFired)],
  ]));
}

function renderSubagentCorrelation(storeDb: Database, fires: FireWithOutcome[]): void {
  let withSubagent = 0, organic = 0;
  for (const fire of fires) {
    const recent = storeDb.query<{ message: string }, [string, number]>(`
      SELECT am.message FROM assistant_messages am JOIN base_messages bm ON am.uuid = bm.uuid
      WHERE bm.session_id = ? AND bm.timestamp <= ? AND json_valid(am.message) = 1
      ORDER BY bm.timestamp DESC LIMIT 3
    `).all(fire.sessionId, fire.firedAt);
    const sub = recent.some((t) => t.message.includes('"name":"Task"') || t.message.includes('"name":"Agent"'));
    if (sub) withSubagent++; else organic++;
  }
  console.log(`\n${bold("  Subagent-fire correlation")} ${dim("(fires within 3 turns of a Task/Agent dispatch)")}`);
  console.log(renderKV([
    ["Fires after subagent dispatch", `${withSubagent} (${fires.length ? formatPct(withSubagent / fires.length * 100) : "—"})`],
    ["Fires from organic conversation", `${organic} (${fires.length ? formatPct(organic / fires.length * 100) : "—"})`],
  ]));
}

// ─── Entry ────────────────────────────────────────────────────────────────────

export function renderContextLoopReport(opts: Options): void {
  const opened = openContextLoopDb();
  if ("error" in opened) {
    if (opts.json) console.log(JSON.stringify({ error: opened.error }));
    else console.log(opened.error);
    return;
  }
  const { db: clDb, path: clPath } = opened;

  const storeDbPath = resolveDbPath(process.env["TOKEN_SCOPE_DB"]);
  if (!existsSync(storeDbPath.path)) {
    console.log(`token-scope database not found at ${storeDbPath.path}; cannot compute ROI without per-turn cost data.`);
    clDb.close();
    return;
  }
  const storeDb = new Database(storeDbPath.path, { readonly: true });

  const fires = loadFiresWithOutcomes(clDb, opts.since);
  const rois: RoiRow[] = [];
  const sessionTurnsCache = new Map<string, AssistantTurn[]>();
  for (const fire of fires) {
    let turns = sessionTurnsCache.get(fire.sessionId);
    if (!turns) { turns = loadSessionTurns(storeDb, fire.sessionId); sessionTurnsCache.set(fire.sessionId, turns); }
    rois.push(computeRoi(fire, turns));
  }

  if (opts.json) {
    console.log(JSON.stringify({
      meta: { generated_at: new Date().toISOString(), since: opts.since, token_scope_version: VERSION, context_loop_db: clPath },
      report: "context-loop", fires, rois,
    }, null, 2));
    clDb.close(); storeDb.close(); return;
  }

  console.log(renderHeader("token-scope — context-loop savings"));
  if (fires.length === 0) {
    console.log(`No fires recorded since ${opts.sinceStr}.`);
    clDb.close(); storeDb.close(); return;
  }
  renderHeadline(rois);

  const want = (s: Section) => opts.sections.includes("all") || opts.sections.includes(s);

  if (want("tuning")) {
    renderThresholdCurve(rois);
    renderActedSplit(rois);
    renderTimeToAction(rois);
  }
  if (want("reclamation")) {
    renderPerCwdRoi(rois);
    renderReclamationAttribution(storeDb, fires);
    renderNoFireBaseline(storeDb, opts.since, fires[0]!.fillPct < 0.5 ? 0.35 : 0.5);
  }
  if (want("patterns")) {
    renderNthFire(rois);
    renderQualityProxy(storeDb, fires);
    renderTerminalState(storeDb, opts.since, fires);
    renderSubagentCorrelation(storeDb, fires);
  }

  console.log(renderFootnote("Realized savings = (pre_avg_cost − post_avg_cost) × turns_used_post − compaction_overhead. Pre/post windows = 5 turns. Overhead = first post-action turn (cache rebuild)."));
}
