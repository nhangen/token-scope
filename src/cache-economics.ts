import { getPricing, type ModelPricing } from "@/pricing";
import { CREDIT_WEIGHTS } from "@/credits";

export interface CacheTurnRecord {
  uuid: string;
  sessionId: string;
  /** Subagent transcripts share the parent sessionId; agentId separates their cache streams. */
  agentId?: string;
  cwd?: string;
  timestampMs: number;
  model: string;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Portion of cacheWriteTokens billed at the 1h tier (usage.cache_creation.ephemeral_1h_input_tokens). */
  cacheWrite1hTokens?: number;
  costUsd: number | null;
  isSubagent?: boolean;
}

export interface TokenMix {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  totalInputTokens: number;
  cacheReadPct: number | null;
  cacheWritePct: number | null;
  uncachedInputPct: number | null;
}

export interface CostMix {
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  uncachedInputCostUsd: number;
  totalInputCostUsd: number;
  cacheReadCostPct: number | null;
  cacheWriteCostPct: number | null;
  uncachedInputCostPct: number | null;
  cacheReadCredits: number;
  cacheWriteCredits: number;
  uncachedInputCredits: number;
  totalInputCredits: number;
  cacheReadCreditsPct: number | null;
  cacheWriteCreditsPct: number | null;
  uncachedInputCreditsPct: number | null;
}

export type MissType = "expiry" | "growth" | "invalidation" | "cold";

export interface MissClassification {
  type: MissType;
  turn: number;
  sessionId: string;
  timestampMs: number;
  gapMs: number | null;
  contextTokens: number;
  prevContextTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  rebuildPrefixTokens: number;
  extraCostUsd: number;
  extraCredits: number;
  model: string;
  isSubagent: boolean;
}

export interface GapHistogramBucket {
  label: string;
  minSec: number;
  maxSec: number | null;
  count: number;
  pct: number;
}

export interface PolicySimulationResult {
  policyId: string;
  title: string;
  weeklySavingsUsd: number;
  totalSavingsUsd: number;
  weeklySavingsCredits: number;
  assumptions: string[];
  simulatedTotalCostUsd: number;
}

export interface CacheEconomicsAnalysis {
  correctedHitPct: number | null;
  legacyHitPct: number | null;
  tokenMix: TokenMix;
  costMix: CostMix;
  misses: {
    totalWrites: number;
    expiries: number;
    growths: number;
    invalidations: number;
    colds: number;
    totalExpiryExtraCostUsd: number;
    totalExpiryExtraCredits: number;
    items: MissClassification[];
  };
  subagentMisses: {
    totalTurns: number;
    coldStarts: number;
    expiries: number;
    growths: number;
    invalidations: number;
    totalExpiryExtraCostUsd: number;
    totalExpiryExtraCredits: number;
    items: MissClassification[];
  };
  gapHistogram: {
    totalGaps: number;
    buckets: GapHistogramBucket[];
  };
  simulations: PolicySimulationResult[];
}

export interface CacheEconomicsInput {
  mainTurns: CacheTurnRecord[];
  subagentTurns?: CacheTurnRecord[];
  sinceSec: number;
  nowMs?: number;
}

export const MAIN_TTL_MS = 60 * 60 * 1000; // 1 hour default
export const SUBAGENT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// pricing.ts carries only the 5m write rate (1.25x input); the 1h tier bills 2.0x input.
const ONE_HOUR_WRITE_INPUT_MULTIPLE = 2.0;

type WriteSplit = { cacheWriteTokens: number; cacheWrite1hTokens?: number };

function splitWrites(t: WriteSplit): { w5m: number; w1h: number } {
  const w1h = Math.min(Math.max(0, t.cacheWrite1hTokens ?? 0), t.cacheWriteTokens);
  return { w5m: t.cacheWriteTokens - w1h, w1h };
}

export function cacheWriteCostUsd(t: WriteSplit, p: ModelPricing): number {
  const { w5m, w1h } = splitWrites(t);
  return (w5m * p.cacheWritePerMillion + w1h * p.inputPerMillion * ONE_HOUR_WRITE_INPUT_MULTIPLE) / 1_000_000;
}

export function cacheWriteCredits(t: WriteSplit): number {
  const { w5m, w1h } = splitWrites(t);
  return w5m * CREDIT_WEIGHTS.cacheWrite + w1h * CREDIT_WEIGHTS.input * ONE_HOUR_WRITE_INPUT_MULTIPLE;
}

export function classifyTurn(
  prev: CacheTurnRecord | null,
  curr: CacheTurnRecord,
  isSubagent = false,
  turnNumber = 1
): MissClassification {
  const isCold = prev === null;
  const ttlMs = isSubagent ? SUBAGENT_TTL_MS : MAIN_TTL_MS;
  const gapMs = prev !== null ? Math.max(0, curr.timestampMs - prev.timestampMs) : null;
  const prevContext = prev !== null ? prev.inputTokens + prev.cacheReadTokens + prev.cacheWriteTokens : 0;
  const currContext = curr.inputTokens + curr.cacheReadTokens + curr.cacheWriteTokens;
  const deltaContext = Math.max(0, currContext - prevContext);

  let type: MissType = "growth";
  let rebuildPrefixTokens = 0;
  let extraCostUsd = 0;
  let extraCredits = 0;

  const p = getPricing(curr.model);
  const writePerToken = p && curr.cacheWriteTokens > 0 ? cacheWriteCostUsd(curr, p) / curr.cacheWriteTokens : 0;
  const readPerToken = p ? p.cacheReadPerMillion / 1_000_000 : 0;
  const writeCreditsPerToken = curr.cacheWriteTokens > 0 ? cacheWriteCredits(curr) / curr.cacheWriteTokens : 0;

  if (isCold) {
    type = "cold";
  } else if (curr.cacheWriteTokens > 0) {
    if (gapMs !== null && gapMs > ttlMs) {
      type = "expiry";
      rebuildPrefixTokens = Math.min(prevContext, curr.cacheWriteTokens);
      extraCostUsd = rebuildPrefixTokens * (writePerToken - readPerToken);
      extraCredits = rebuildPrefixTokens * (writeCreditsPerToken - CREDIT_WEIGHTS.cacheRead);
    } else {
      // Gap <= TTL: check whether write corresponds to new content
      // If previous context was mostly read and write is within expected growth margin, it's growth
      const isGrowth =
        curr.cacheReadTokens >= prevContext * 0.75 ||
        curr.cacheWriteTokens <= Math.max(deltaContext * 1.25, 2048);

      if (isGrowth) {
        type = "growth";
      } else {
        type = "invalidation";
        rebuildPrefixTokens = Math.min(prevContext, curr.cacheWriteTokens);
        extraCostUsd = rebuildPrefixTokens * (writePerToken - readPerToken);
        extraCredits = rebuildPrefixTokens * (writeCreditsPerToken - CREDIT_WEIGHTS.cacheRead);
      }
    }
  }

  return {
    type,
    turn: turnNumber,
    sessionId: curr.sessionId,
    timestampMs: curr.timestampMs,
    gapMs,
    contextTokens: currContext,
    prevContextTokens: prevContext,
    cacheWriteTokens: curr.cacheWriteTokens,
    cacheWrite1hTokens: splitWrites(curr).w1h,
    cacheReadTokens: curr.cacheReadTokens,
    inputTokens: curr.inputTokens,
    rebuildPrefixTokens,
    extraCostUsd,
    extraCredits,
    model: curr.model,
    isSubagent,
  };
}

export function computeGapHistogram(gapsSec: number[]): { totalGaps: number; buckets: GapHistogramBucket[] } {
  const bucketDefs = [
    { label: "< 1m", minSec: 0, maxSec: 60 },
    { label: "1m – 5m", minSec: 60, maxSec: 300 },
    { label: "5m – 15m", minSec: 300, maxSec: 900 },
    { label: "15m – 30m", minSec: 900, maxSec: 1800 },
    { label: "30m – 60m", minSec: 1800, maxSec: 3600 },
    { label: "1h – 2h", minSec: 3600, maxSec: 7200 },
    { label: "2h – 4h", minSec: 7200, maxSec: 14400 },
    { label: "> 4h", minSec: 14400, maxSec: null },
  ];

  const counts = new Array(bucketDefs.length).fill(0);
  for (const g of gapsSec) {
    for (let i = 0; i < bucketDefs.length; i++) {
      const def = bucketDefs[i]!;
      if (def.maxSec === null) {
        if (g >= def.minSec) counts[i]++;
      } else if (g >= def.minSec && g < def.maxSec) {
        counts[i]++;
        break;
      }
    }
  }

  const totalGaps = gapsSec.length;
  const buckets: GapHistogramBucket[] = bucketDefs.map((def, i) => ({
    label: def.label,
    minSec: def.minSec,
    maxSec: def.maxSec,
    count: counts[i],
    pct: totalGaps > 0 ? (counts[i] / totalGaps) * 100 : 0,
  }));

  return { totalGaps, buckets };
}

export function analyzeCacheEconomics(input: CacheEconomicsInput): CacheEconomicsAnalysis {
  const mainTurns = input.mainTurns.slice().sort((a, b) => a.timestampMs - b.timestampMs);
  const subagentTurns = (input.subagentTurns ?? []).slice().sort((a, b) => a.timestampMs - b.timestampMs);
  const allTurns = [...mainTurns, ...subagentTurns];

  // Token totals
  let totalRead = 0;
  let totalWrite = 0;
  let totalInput = 0;
  let totalReadUsd = 0;
  let totalWriteUsd = 0;
  let totalInputUsd = 0;
  let totalWriteCredits = 0;

  for (const t of allTurns) {
    totalRead += t.cacheReadTokens;
    totalWrite += t.cacheWriteTokens;
    totalInput += t.inputTokens;
    totalWriteCredits += cacheWriteCredits(t);

    const p = getPricing(t.model);
    if (p) {
      totalReadUsd += (t.cacheReadTokens * p.cacheReadPerMillion) / 1_000_000;
      totalWriteUsd += cacheWriteCostUsd(t, p);
      totalInputUsd += (t.inputTokens * p.inputPerMillion) / 1_000_000;
    }
  }

  const totalInputTokens = totalRead + totalWrite + totalInput;
  const tokenMix: TokenMix = {
    cacheReadTokens: totalRead,
    cacheWriteTokens: totalWrite,
    uncachedInputTokens: totalInput,
    totalInputTokens,
    cacheReadPct: totalInputTokens > 0 ? (totalRead / totalInputTokens) * 100 : null,
    cacheWritePct: totalInputTokens > 0 ? (totalWrite / totalInputTokens) * 100 : null,
    uncachedInputPct: totalInputTokens > 0 ? (totalInput / totalInputTokens) * 100 : null,
  };

  const totalInputCostUsd = totalReadUsd + totalWriteUsd + totalInputUsd;
  const totalReadCredits = totalRead * CREDIT_WEIGHTS.cacheRead;
  const totalInputCreditsOnly = totalInput * CREDIT_WEIGHTS.input;
  const totalInputCredits = totalReadCredits + totalWriteCredits + totalInputCreditsOnly;

  const costMix: CostMix = {
    cacheReadCostUsd: totalReadUsd,
    cacheWriteCostUsd: totalWriteUsd,
    uncachedInputCostUsd: totalInputUsd,
    totalInputCostUsd,
    cacheReadCostPct: totalInputCostUsd > 0 ? (totalReadUsd / totalInputCostUsd) * 100 : null,
    cacheWriteCostPct: totalInputCostUsd > 0 ? (totalWriteUsd / totalInputCostUsd) * 100 : null,
    uncachedInputCostPct: totalInputCostUsd > 0 ? (totalInputUsd / totalInputCostUsd) * 100 : null,
    cacheReadCredits: totalReadCredits,
    cacheWriteCredits: totalWriteCredits,
    uncachedInputCredits: totalInputCreditsOnly,
    totalInputCredits,
    cacheReadCreditsPct: totalInputCredits > 0 ? (totalReadCredits / totalInputCredits) * 100 : null,
    cacheWriteCreditsPct: totalInputCredits > 0 ? (totalWriteCredits / totalInputCredits) * 100 : null,
    uncachedInputCreditsPct: totalInputCredits > 0 ? (totalInputCreditsOnly / totalInputCredits) * 100 : null,
  };

  const correctedHitPct = totalInputTokens > 0 ? (totalRead / totalInputTokens) * 100 : null;
  const nonWriteTokens = totalRead + totalInput;
  const legacyHitPct = nonWriteTokens > 0 ? (totalRead / nonWriteTokens) * 100 : null;

  // Group main turns by session
  const mainBySession = new Map<string, CacheTurnRecord[]>();
  for (const t of mainTurns) {
    const list = mainBySession.get(t.sessionId) ?? [];
    list.push(t);
    mainBySession.set(t.sessionId, list);
  }

  const mainMissItems: MissClassification[] = [];
  const gapsSec: number[] = [];

  for (const [, sTurns] of mainBySession) {
    sTurns.sort((a, b) => a.timestampMs - b.timestampMs);
    let prev: CacheTurnRecord | null = null;
    for (let i = 0; i < sTurns.length; i++) {
      const curr = sTurns[i]!;
      if (prev !== null) {
        const gap = Math.max(0, curr.timestampMs - prev.timestampMs);
        gapsSec.push(gap / 1000);
      }
      const item = classifyTurn(prev, curr, false, i + 1);
      mainMissItems.push(item);
      prev = curr;
    }
  }

  const subagentByStream = new Map<string, CacheTurnRecord[]>();
  for (const t of subagentTurns) {
    const key = `${t.sessionId}\u0000${t.agentId ?? ""}`;
    const list = subagentByStream.get(key) ?? [];
    list.push(t);
    subagentByStream.set(key, list);
  }

  const subagentMissItems: MissClassification[] = [];
  for (const [, sTurns] of subagentByStream) {
    sTurns.sort((a, b) => a.timestampMs - b.timestampMs);
    let prev: CacheTurnRecord | null = null;
    for (let i = 0; i < sTurns.length; i++) {
      const curr = sTurns[i]!;
      const item = classifyTurn(prev, curr, true, i + 1);
      subagentMissItems.push(item);
      prev = curr;
    }
  }

  // Summary counts for main misses
  const writesOnly = mainMissItems.filter((m) => m.cacheWriteTokens > 0);
  const expiries = writesOnly.filter((m) => m.type === "expiry");
  const growths = writesOnly.filter((m) => m.type === "growth");
  const invalidations = writesOnly.filter((m) => m.type === "invalidation");
  const colds = writesOnly.filter((m) => m.type === "cold");
  const totalExpiryExtraCostUsd = expiries.reduce((s, m) => s + m.extraCostUsd, 0);
  const totalExpiryExtraCredits = expiries.reduce((s, m) => s + m.extraCredits, 0);

  // Summary counts for subagents
  const subColdStarts = subagentMissItems.filter((m) => m.type === "cold");
  const subExpiries = subagentMissItems.filter((m) => m.type === "expiry");
  const subGrowths = subagentMissItems.filter((m) => m.type === "growth");
  const subInvalidations = subagentMissItems.filter((m) => m.type === "invalidation");
  const subExpiryCostUsd = subExpiries.reduce((s, m) => s + m.extraCostUsd, 0);
  const subExpiryCredits = subExpiries.reduce((s, m) => s + m.extraCredits, 0);

  const gapHistogram = computeGapHistogram(gapsSec);

  // Simulations
  // Estimate window duration in weeks
  const minTs = allTurns.length > 0 ? Math.min(...allTurns.map((t) => t.timestampMs)) : input.sinceSec * 1000;
  const maxTs = input.nowMs ?? (allTurns.length > 0 ? Math.max(...allTurns.map((t) => t.timestampMs)) : Date.now());
  const windowWeeks = Math.max(0.14, (maxTs - minTs) / (7 * 86_400_000));

  // Baseline total actual cost
  let actualTotalCostUsd = 0;
  for (const t of allTurns) {
    if (t.costUsd !== null) actualTotalCostUsd += t.costUsd;
    else {
      const p = getPricing(t.model);
      if (p) {
        actualTotalCostUsd +=
          (t.outputTokens * p.outputPerMillion +
            t.inputTokens * p.inputPerMillion +
            t.cacheReadTokens * p.cacheReadPerMillion) /
            1_000_000 +
          cacheWriteCostUsd(t, p);
      }
    }
  }

  const simulations: PolicySimulationResult[] = [];

  // 1. Baseline reconciliation (must equal actual totals when simulated policy == actual policy)
  simulations.push({
    policyId: "actual_baseline",
    title: "Baseline (Current policy: 1h main TTL, 5m subagent TTL)",
    weeklySavingsUsd: 0,
    totalSavingsUsd: 0,
    weeklySavingsCredits: 0,
    assumptions: ["Current observed configuration: 1h TTL on main loop, 5m TTL on subagents"],
    simulatedTotalCostUsd: actualTotalCostUsd,
  });

  let main5mWriteSavingsUsd = 0;
  let main5mExpiryPenaltiesUsd = 0;
  let main5mBreakEvenGapsCount = 0;

  for (const m of mainMissItems) {
    const p = getPricing(m.model);
    if (!p) continue;
    if (m.cacheWrite1hTokens > 0) {
      main5mWriteSavingsUsd +=
        cacheWriteCostUsd(m, p) - cacheWriteCostUsd({ cacheWriteTokens: m.cacheWriteTokens, cacheWrite1hTokens: 0 }, p);
    }
    // A read that survived a (5m, 60m] gap only hit because the prefix was on the 1h tier.
    if (m.gapMs !== null && m.gapMs > 5 * 60 * 1000 && m.gapMs <= 60 * 60 * 1000 && m.cacheReadTokens > 0) {
      main5mBreakEvenGapsCount++;
      main5mExpiryPenaltiesUsd += (m.cacheReadTokens * (p.cacheWritePerMillion - p.cacheReadPerMillion)) / 1_000_000;
    }
  }

  const net5mSavingsUsd = main5mWriteSavingsUsd - main5mExpiryPenaltiesUsd;
  simulations.push({
    policyId: "main_5m_ttl",
    title: net5mSavingsUsd >= 0 ? "Switch main session to 5m TTL" : "Keep main session on 1h TTL",
    weeklySavingsUsd: Math.abs(net5mSavingsUsd) / windowWeeks,
    totalSavingsUsd: Math.abs(net5mSavingsUsd),
    weeklySavingsCredits: (Math.abs(net5mSavingsUsd) / (totalInputCostUsd || 1)) * totalInputCredits / windowWeeks,
    assumptions: [
      "5m cache write = 1.25x input price; 1h cache write = 2.0x input price; cache read = 0.1x",
      "Write savings apply only to tokens billed at the 1h tier (usage.cache_creation.ephemeral_1h_input_tokens)",
      `Gaps in (5m, 60m] observed: ${main5mBreakEvenGapsCount}`,
      net5mSavingsUsd >= 0
        ? "Fast-paced turns dominate; 37.5% write savings outweigh the few 5m-60m expiry rebuilds"
        : "1h TTL avoids rebuilds on frequent 5m-60m pauses; break-even favors 1h",
    ],
    simulatedTotalCostUsd: actualTotalCostUsd - net5mSavingsUsd,
  });

  // 3. Compact before long breaks (>30m/1h)
  // When a break > 1h occurs and prior context > 20,000 tokens:
  // Compaction beforehand on warm cache costs ~1 read turn (~0.1x) + ~1k output,
  // but reduces rebuild from C_prev to ~15k tokens upon return!
  let compactBeforeBreakSavingsUsd = 0;
  let breaksCount = 0;

  for (const m of mainMissItems) {
    if (m.type === "expiry" && m.prevContextTokens > 20000) {
      breaksCount++;
      const p = getPricing(m.model);
      if (p) {
        const compactedContext = 15000;
        const tokensSaved = Math.max(0, m.rebuildPrefixTokens - compactedContext);
        const writePerToken = cacheWriteCostUsd(m, p) / m.cacheWriteTokens;
        const rebuildSavedUsd = tokensSaved * (writePerToken - p.cacheReadPerMillion / 1_000_000);
        const compactCostUsd = (m.prevContextTokens * p.cacheReadPerMillion + 1000 * p.outputPerMillion) / 1_000_000;
        const net = rebuildSavedUsd - compactCostUsd;
        if (net > 0) compactBeforeBreakSavingsUsd += net;
      }
    }
  }

  simulations.push({
    policyId: "compact_before_breaks",
    title: "Run /compact before breaks > 30 minutes",
    weeklySavingsUsd: compactBeforeBreakSavingsUsd / windowWeeks,
    totalSavingsUsd: compactBeforeBreakSavingsUsd,
    weeklySavingsCredits: (compactBeforeBreakSavingsUsd / (totalInputCostUsd || 1)) * totalInputCredits / windowWeeks,
    assumptions: [
      `Detected ${breaksCount} long breaks (>1h) on large context (>20k tokens)`,
      "Compaction reduces context to ~15k tokens before idle expiry, drastically lowering rebuild size upon return",
      "Compaction cost modeled on warm prefix read (0.1x) + 1,000 output tokens",
    ],
    simulatedTotalCostUsd: actualTotalCostUsd - compactBeforeBreakSavingsUsd,
  });

  // 4. Auto-compact threshold at 35% context (vs default ~80%)
  // Capping context earlier keeps per-turn reads smaller
  let autoCompactSavingsUsd = 0;
  for (const m of mainMissItems) {
    if (m.contextTokens > 70000) {
      const p = getPricing(m.model);
      if (p) {
        // Excess reads above 70k tokens
        const excess = m.contextTokens - 70000;
        autoCompactSavingsUsd += (excess * 0.4 * p.cacheReadPerMillion) / 1_000_000;
      }
    }
  }

  simulations.push({
    policyId: "auto_compact_35pct",
    title: "Lower auto-compact threshold to 35% of context window",
    weeklySavingsUsd: autoCompactSavingsUsd / windowWeeks,
    totalSavingsUsd: autoCompactSavingsUsd,
    weeklySavingsCredits: (autoCompactSavingsUsd / (totalInputCostUsd || 1)) * totalInputCredits / windowWeeks,
    assumptions: [
      "Caps context near 70k tokens, reducing ongoing read token volume across long sessions",
      "Net savings account for ~40% reduced per-turn read context in deep sessions",
    ],
    simulatedTotalCostUsd: actualTotalCostUsd - autoCompactSavingsUsd,
  });

  // 5. Fresh session vs resuming stale (>24h)
  let freshSessionSavingsUsd = 0;
  let staleResumesCount = 0;

  for (const m of mainMissItems) {
    if (m.gapMs !== null && m.gapMs > 24 * 60 * 60 * 1000 && m.prevContextTokens > 30000) {
      staleResumesCount++;
      const p = getPricing(m.model);
      if (p) {
        // Rebuild of stale history vs fresh start (~15k base context)
        const savedWrite = Math.max(0, m.prevContextTokens - 15000);
        freshSessionSavingsUsd += (savedWrite * (p.cacheWritePerMillion - p.cacheReadPerMillion)) / 1_000_000;
      }
    }
  }

  simulations.push({
    policyId: "fresh_session_vs_stale",
    title: "Start a fresh session instead of resuming after > 24h",
    weeklySavingsUsd: freshSessionSavingsUsd / windowWeeks,
    totalSavingsUsd: freshSessionSavingsUsd,
    weeklySavingsCredits: (freshSessionSavingsUsd / (totalInputCostUsd || 1)) * totalInputCredits / windowWeeks,
    assumptions: [
      `Detected ${staleResumesCount} session continuations after > 24h pause on large context`,
      "Starting fresh eliminates full rebuild of expired historic context and lowers subsequent turn volume",
    ],
    simulatedTotalCostUsd: actualTotalCostUsd - freshSessionSavingsUsd,
  });

  // Sort simulations by weekly savings descending (keeping baseline at end or sorted)
  const rankedSimulations = [
    simulations[0]!, // baseline
    ...simulations.slice(1).sort((a, b) => b.weeklySavingsUsd - a.weeklySavingsUsd),
  ];

  return {
    correctedHitPct,
    legacyHitPct,
    tokenMix,
    costMix,
    misses: {
      totalWrites: writesOnly.length,
      expiries: expiries.length,
      growths: growths.length,
      invalidations: invalidations.length,
      colds: colds.length,
      totalExpiryExtraCostUsd,
      totalExpiryExtraCredits,
      items: mainMissItems,
    },
    subagentMisses: {
      totalTurns: subagentMissItems.length,
      coldStarts: subColdStarts.length,
      expiries: subExpiries.length,
      growths: subGrowths.length,
      invalidations: subInvalidations.length,
      totalExpiryExtraCostUsd: subExpiryCostUsd,
      totalExpiryExtraCredits: subExpiryCredits,
      items: subagentMissItems,
    },
    gapHistogram,
    simulations: rankedSimulations,
  };
}
