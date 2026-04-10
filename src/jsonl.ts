import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { computeTurnCost, computeCacheSavings, getPricing } from "@/pricing";
import { parseContentBlocks, resolveDominantTool } from "@/parse";
import type {
  SummaryTotals, ToolRow, ProjectRow, SessionRow, TurnRow,
  WeekRow, ThinkingTurnRow, BashCommandRow, ProjectMatch, RawTurnForTool,
  ContextStatRow, CacheStatRow, ContributorRow,
} from "@/reader";
import type { Reader } from "@/reader";

interface JsonlTurn {
  uuid: string;
  sessionId: string;
  cwd: string;
  timestampMs: number;
  model: string;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason: string | null;
  messageJson: string;
  costUsd: number | null;
}


function scanJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  function walk(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "subagents") walk(join(current, entry.name));
      } else if (entry.name.endsWith(".jsonl")) {
        files.push(join(current, entry.name));
      }
    }
  }
  walk(dir);
  return files;
}

function loadTurns(dirs: string[]): JsonlTurn[] {
  const turns: JsonlTurn[] = [];
  for (const file of dirs.flatMap(scanJsonlFiles)) {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj["type"] !== "assistant") continue;
      const msg = obj["message"] as Record<string, unknown> | undefined;
      if (!msg) continue;
      const usage = msg["usage"] as Record<string, unknown> | undefined;
      if (!usage) continue;
      const out = Number(usage["output_tokens"] ?? 0);
      if (out <= 0) continue;
      const model = String(msg["model"] ?? "");
      const inp = Number(usage["input_tokens"] ?? 0);
      const cacheRead = Number(usage["cache_read_input_tokens"] ?? 0);
      const cacheWrite = Number(usage["cache_creation_input_tokens"] ?? 0);
      turns.push({
        uuid: String(obj["uuid"] ?? ""),
        sessionId: String(obj["sessionId"] ?? ""),
        cwd: String(obj["cwd"] ?? ""),
        timestampMs: new Date(String(obj["timestamp"] ?? "")).getTime(),
        model,
        outputTokens: out,
        inputTokens: inp,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        stopReason: msg["stop_reason"] ? String(msg["stop_reason"]) : null,
        messageJson: JSON.stringify(msg),
        costUsd: computeTurnCost(model, out, inp, cacheRead, cacheWrite),
      });
    }
  }
  return turns;
}

export class JsonlReader implements Reader {
  private readonly turns: JsonlTurn[];

  constructor(projectsDirs: string | string[]) {
    this.turns = loadTurns(Array.isArray(projectsDirs) ? projectsDirs : [projectsDirs]);
  }

  private filter(since: number): JsonlTurn[] {
    const sinceMs = since * 1000;
    return this.turns.filter((t) => t.timestampMs > sinceMs);
  }

  querySummaryTotals(since: number): SummaryTotals {
    const turns = this.filter(since);
    const sessionCount = new Set(turns.map((t) => t.sessionId)).size;
    const totalOutputTokens = turns.reduce((s, t) => s + t.outputTokens, 0);
    const totalInputTokens = turns.reduce((s, t) => s + t.inputTokens, 0);
    const totalCacheReadTokens = turns.reduce((s, t) => s + t.cacheReadTokens, 0);
    const totalCacheWriteTokens = turns.reduce((s, t) => s + t.cacheWriteTokens, 0);
    const costsKnown = turns.filter((t) => t.costUsd !== null);
    const totalCostUsd = costsKnown.length > 0
      ? costsKnown.reduce((s, t) => s + t.costUsd!, 0)
      : null;
    const avgCostPerSession =
      totalCostUsd !== null && sessionCount > 0 ? totalCostUsd / sessionCount : null;
    const avgCostPerTurn =
      totalCostUsd !== null && turns.length > 0 ? totalCostUsd / turns.length : null;

    let outputCostUsd = 0, inputCostUsd = 0, cacheReadCostUsd = 0, cacheWriteCostUsd = 0;
    for (const t of turns) {
      const p = getPricing(t.model);
      if (!p) continue;
      outputCostUsd += (t.outputTokens * p.outputPerMillion) / 1_000_000;
      inputCostUsd += (t.inputTokens * p.inputPerMillion) / 1_000_000;
      cacheReadCostUsd += (t.cacheReadTokens * p.cacheReadPerMillion) / 1_000_000;
      cacheWriteCostUsd += (t.cacheWriteTokens * p.cacheWritePerMillion) / 1_000_000;
    }

    return {
      totalOutputTokens, totalInputTokens, totalCacheReadTokens, totalCacheWriteTokens,
      totalCostUsd, outputCostUsd, inputCostUsd, cacheReadCostUsd, cacheWriteCostUsd,
      sessionCount, turnCount: turns.length,
      avgCostPerSession, avgCostPerTurn,
    };
  }

  queryRawTurnsForTool(since: number): RawTurnForTool[] {
    return this.filter(since).map((t) => ({
      uuid: t.uuid,
      sessionId: t.sessionId,
      cwd: t.cwd,
      outputTokens: t.outputTokens,
      costUsd: t.costUsd,
      message: t.messageJson,
    }));
  }

  queryByTool(since: number, limit: number): ToolRow[] {
    const turns = this.filter(since);
    const totalOutput = turns.reduce((s, t) => s + t.outputTokens, 0);
    const totalCost = turns.reduce((s, t) => s + (t.costUsd ?? 0), 0);
    const byTool = new Map<string, { turns: number; outputTokens: number; costUsd: number }>();
    for (const t of turns) {
      const tool = resolveDominantTool(parseContentBlocks(t.messageJson));
      const e = byTool.get(tool) ?? { turns: 0, outputTokens: 0, costUsd: 0 };
      byTool.set(tool, {
        turns: e.turns + 1,
        outputTokens: e.outputTokens + t.outputTokens,
        costUsd: e.costUsd + (t.costUsd ?? 0),
      });
    }
    return Array.from(byTool.entries())
      .map(([tool, d]) => ({
        tool, turns: d.turns, outputTokens: d.outputTokens,
        outputPct: totalOutput > 0 ? (d.outputTokens / totalOutput) * 100 : 0,
        avgOutputPerTurn: d.turns > 0 ? d.outputTokens / d.turns : 0,
        totalCostUsd: d.costUsd > 0 ? d.costUsd : null,
        costPct: totalCost > 0 ? (d.costUsd / totalCost) * 100 : null,
      }))
      .sort((a, b) => b.outputTokens - a.outputTokens)
      .slice(0, limit);
  }

  queryByProject(since: number, limit: number): ProjectRow[] {
    const turns = this.filter(since);
    const byProject = new Map<string, {
      sessions: Set<string>; turns: number; outputTokens: number;
      costUsd: number; costKnown: boolean;
    }>();
    for (const t of turns) {
      const e = byProject.get(t.cwd) ?? {
        sessions: new Set(), turns: 0, outputTokens: 0, costUsd: 0, costKnown: false,
      };
      e.sessions.add(t.sessionId);
      e.turns++;
      e.outputTokens += t.outputTokens;
      if (t.costUsd !== null) { e.costUsd += t.costUsd; e.costKnown = true; }
      byProject.set(t.cwd, e);
    }
    return Array.from(byProject.entries())
      .map(([cwd, d]) => {
        const totalCostUsd = d.costKnown ? d.costUsd : null;
        const sessions = d.sessions.size;
        return {
          cwd, sessions, turns: d.turns, outputTokens: d.outputTokens, totalCostUsd,
          avgSessionCost: totalCostUsd !== null && sessions > 0 ? totalCostUsd / sessions : null,
        };
      })
      .sort((a, b) => (b.totalCostUsd ?? 0) - (a.totalCostUsd ?? 0))
      .slice(0, limit);
  }

  queryWeeklyTrend(since: number): WeekRow[] {
    const turns = this.filter(since);
    const byWeek = new Map<string, {
      sessions: Set<string>; turns: number; outputTokens: number;
      costUsd: number; costKnown: boolean;
    }>();
    for (const t of turns) {
      const d = new Date(t.timestampMs);
      const year = d.getUTCFullYear();
      const jan1 = new Date(Date.UTC(year, 0, 1));
      const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
      const week = Math.floor((dayOfYear + jan1.getUTCDay()) / 7);
      const label = `${year}-W${String(week).padStart(2, "0")}`;
      const e = byWeek.get(label) ?? {
        sessions: new Set(), turns: 0, outputTokens: 0, costUsd: 0, costKnown: false,
      };
      e.sessions.add(t.sessionId);
      e.turns++;
      e.outputTokens += t.outputTokens;
      if (t.costUsd !== null) { e.costUsd += t.costUsd; e.costKnown = true; }
      byWeek.set(label, e);
    }
    return Array.from(byWeek.entries())
      .map(([weekLabel, d]) => ({
        weekLabel, sessions: d.sessions.size, turns: d.turns, outputTokens: d.outputTokens,
        totalCostUsd: d.costKnown ? d.costUsd : null,
      }))
      .sort((a, b) => b.weekLabel.localeCompare(a.weekLabel))
      .slice(0, 5);
  }

  querySessions(since: number, limit: number): SessionRow[] {
    const turns = this.filter(since);
    const bySession = new Map<string, {
      cwdCounts: Map<string, number>; timestamps: number[]; outputTokens: number;
      inputTokens: number; cacheReadTokens: number; costUsd: number; costKnown: boolean;
    }>();
    for (const t of turns) {
      const e = bySession.get(t.sessionId) ?? {
        cwdCounts: new Map<string, number>(), timestamps: [], outputTokens: 0, inputTokens: 0,
        cacheReadTokens: 0, costUsd: 0, costKnown: false,
      };
      e.cwdCounts.set(t.cwd, (e.cwdCounts.get(t.cwd) ?? 0) + 1);
      e.timestamps.push(t.timestampMs);
      e.outputTokens += t.outputTokens;
      e.inputTokens += t.inputTokens;
      e.cacheReadTokens += t.cacheReadTokens;
      if (t.costUsd !== null) { e.costUsd += t.costUsd; e.costKnown = true; }
      bySession.set(t.sessionId, e);
    }
    return Array.from(bySession.entries())
      .map(([sessionId, d]) => {
        const sorted = d.timestamps.slice().sort((a, b) => a - b);
        const startedAt = sorted[0]!;
        const endedAt = sorted.at(-1)!;
        const totalInput = d.inputTokens + d.cacheReadTokens;
        const cacheHitPct = totalInput > 0 ? (d.cacheReadTokens / totalInput) * 100 : null;
        const cwd = [...d.cwdCounts.entries()].sort((a, b) => (b[1] as number) - (a[1] as number))[0]![0];
        return {
          sessionId, cwd, startedAt,
          durationMs: sorted.length > 1 ? endedAt - startedAt : null,
          turnCount: d.timestamps.length,
          outputTokens: d.outputTokens,
          cacheHitPct,
          totalCostUsd: d.costKnown ? d.costUsd : null,
        };
      })
      .sort((a, b) => (b.totalCostUsd ?? 0) - (a.totalCostUsd ?? 0))
      .slice(0, limit);
  }

  querySessionTurns(sessionId: string): TurnRow[] {
    return this.turns
      .filter((t) => t.sessionId === sessionId)
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((t) => ({
        uuid: t.uuid,
        timestamp: t.timestampMs,
        outputTokens: t.outputTokens,
        inputTokens: t.inputTokens,
        cacheReadTokens: t.cacheReadTokens,
        cacheWriteTokens: t.cacheWriteTokens,
        costUsd: t.costUsd,
        durationMs: null,
        model: t.model,
        stopReason: t.stopReason,
        message: t.messageJson,
      }));
  }

  queryThinkingTurns(since: number): ThinkingTurnRow[] {
    const turns = this.filter(since);
    const bySession = new Map<string, JsonlTurn[]>();
    for (const t of turns) {
      const arr = bySession.get(t.sessionId) ?? [];
      arr.push(t);
      bySession.set(t.sessionId, arr);
    }

    const results: ThinkingTurnRow[] = [];
    for (const arr of bySession.values()) {
      arr.sort((a, b) => a.timestampMs - b.timestampMs);
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i]!;
        const blocks = parseContentBlocks(t.messageJson);
        let thinkingChars = 0;
        let textChars = 0;
        for (const b of blocks) {
          if (b.type === "thinking") thinkingChars += (b.thinking ?? "").length;
          else if (b.type === "text") textChars += (b.text ?? "").length;
        }
        if (thinkingChars === 0) continue;

        const isThinkingOnly = blocks.every((b) => b.type === "thinking");
        let mergedMessage = t.messageJson;
        let mergedOutputTokens = t.outputTokens;
        let mergedCost = t.costUsd;

        if (isThinkingOnly && i + 1 < arr.length) {
          const next = arr[i + 1]!;
          const nextBlocks = parseContentBlocks(next.messageJson);
          for (const b of nextBlocks) {
            if (b.type === "text") textChars += (b.text ?? "").length;
          }
          mergedMessage = next.messageJson;
          mergedOutputTokens += next.outputTokens;
          if (next.costUsd !== null) mergedCost = (mergedCost ?? 0) + next.costUsd;
          i++;
        }

        results.push({
          uuid: t.uuid, sessionId: t.sessionId, cwd: t.cwd,
          timestamp: t.timestampMs, outputTokens: mergedOutputTokens, costUsd: mergedCost,
          thinkingChars, textChars, message: mergedMessage,
        });
      }
    }
    return results;
  }

  queryBashTurns(since: number): BashCommandRow[] {
    return this.filter(since)
      .flatMap((t) => {
        const blocks = parseContentBlocks(t.messageJson);
        const bashBlock = blocks.find((b) => b.type === "tool_use" && (b.name ?? "").toLowerCase() === "bash");
        if (!bashBlock) return [];
        const command = bashBlock.input && typeof bashBlock.input === "object" && "command" in bashBlock.input
          ? String((bashBlock.input as Record<string, unknown>)["command"])
          : "";
        return [{ uuid: t.uuid, sessionId: t.sessionId, timestamp: t.timestampMs, outputTokens: t.outputTokens, costUsd: t.costUsd, command }];
      });
  }

  queryProjectMatches(fragment: string): ProjectMatch[] {
    const seen = new Set<string>();
    const results: ProjectMatch[] = [];
    for (const t of this.turns) {
      if (!seen.has(t.cwd) && t.cwd.toLowerCase().includes(fragment.toLowerCase())) {
        seen.add(t.cwd);
        results.push({ cwd: t.cwd });
      }
    }
    return results;
  }

  queryContextStats(since: number, limit: number): ContextStatRow[] {
    const turns = this.filter(since);
    const bySession = new Map<string, { cwdCounts: Map<string, number>; turns: JsonlTurn[] }>();
    for (const t of turns) {
      const e = bySession.get(t.sessionId) ?? { cwdCounts: new Map<string, number>(), turns: [] };
      e.cwdCounts.set(t.cwd, (e.cwdCounts.get(t.cwd) ?? 0) + 1);
      e.turns.push(t);
      bySession.set(t.sessionId, e);
    }
    const rows: ContextStatRow[] = [];
    for (const [sessionId, d] of bySession.entries()) {
      if (d.turns.length < 6) continue;
      const sorted = d.turns.slice().sort((a, b) => a.timestampMs - b.timestampMs);
      const early = sorted.slice(0, 3);
      const late = sorted.slice(-3);
      const avgEarlyInput = early.reduce((s, t) => s + t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens, 0) / 3;
      const avgLateInput = late.reduce((s, t) => s + t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens, 0) / 3;
      const bloatRatio = avgEarlyInput > 0 ? avgLateInput / avgEarlyInput : null;
      const cwd = [...d.cwdCounts.entries()].sort((a, b) => (b[1] as number) - (a[1] as number))[0]![0];
      rows.push({ sessionId, cwd, turnCount: d.turns.length, avgEarlyInput, avgLateInput, bloatRatio });
    }
    return rows.sort((a, b) => (b.bloatRatio ?? 0) - (a.bloatRatio ?? 0)).slice(0, limit);
  }

  queryCacheStats(since: number, limit: number): CacheStatRow[] {
    const turns = this.filter(since);
    const byProject = new Map<string, {
      sessions: Set<string>; turns: number;
      totalInputTokens: number; totalCacheReadTokens: number; totalCacheWriteTokens: number;
      savings: number;
    }>();
    for (const t of turns) {
      const e = byProject.get(t.cwd) ?? {
        sessions: new Set(), turns: 0,
        totalInputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
        savings: 0,
      };
      e.sessions.add(t.sessionId);
      e.turns++;
      e.totalInputTokens += t.inputTokens;
      e.totalCacheReadTokens += t.cacheReadTokens;
      e.totalCacheWriteTokens += t.cacheWriteTokens;
      const s = computeCacheSavings(t.model, t.cacheReadTokens);
      if (s !== null) e.savings += s;
      byProject.set(t.cwd, e);
    }
    return Array.from(byProject.entries())
      .map(([cwd, d]) => ({
        cwd,
        sessions: d.sessions.size,
        turns: d.turns,
        totalInputTokens: d.totalInputTokens,
        totalCacheReadTokens: d.totalCacheReadTokens,
        totalCacheWriteTokens: d.totalCacheWriteTokens,
        cacheHitPct: d.totalInputTokens + d.totalCacheReadTokens > 0
          ? (d.totalCacheReadTokens / (d.totalInputTokens + d.totalCacheReadTokens)) * 100 : null,
        estimatedSavingsUsd: d.savings > 0 ? d.savings : null,
      }))
      .sort((a, b) => (b.estimatedSavingsUsd ?? 0) - (a.estimatedSavingsUsd ?? 0))
      .slice(0, limit);
  }

  queryContextContributors(since: number, limit: number): ContributorRow[] {
    const turns = this.filter(since);
    const totalCW = turns.reduce((s, t) => s + t.cacheWriteTokens, 0);

    const byTool = new Map<string, { turns: number; totalCW: number; maxCW: number; costUsd: number }>();
    for (const t of turns) {
      const tool = resolveDominantTool(parseContentBlocks(t.messageJson));
      const e = byTool.get(tool) ?? { turns: 0, totalCW: 0, maxCW: 0, costUsd: 0 };
      byTool.set(tool, {
        turns: e.turns + 1,
        totalCW: e.totalCW + t.cacheWriteTokens,
        maxCW: Math.max(e.maxCW, t.cacheWriteTokens),
        costUsd: e.costUsd + (t.costUsd ?? 0),
      });
    }

    return Array.from(byTool.entries())
      .map(([tool, d]) => ({
        tool,
        turns: d.turns,
        totalCacheWrite: d.totalCW,
        avgCacheWrite: d.turns > 0 ? d.totalCW / d.turns : 0,
        maxCacheWrite: d.maxCW,
        pctOfTotal: totalCW > 0 ? (d.totalCW / totalCW) * 100 : 0,
        estimatedCostUsd: d.costUsd > 0 ? d.costUsd : null,
      }))
      .sort((a, b) => b.totalCacheWrite - a.totalCacheWrite)
      .slice(0, limit);
  }

  close(): void {}
}
